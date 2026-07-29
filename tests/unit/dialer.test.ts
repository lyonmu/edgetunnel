import { describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../../src/config/defaults';
import type { RuntimeSnapshot } from '../../src/config/runtime';
import type { EgressProfile, RoutingRule } from '../../src/config/schema';
import {
  BlockedTargetError,
  createDialer,
  selectRoute,
  type DialerDependencies,
} from '../../src/networking/dialer';
import type {
  Connector,
  ConnectorRegistry,
  DialTarget,
} from '../../src/networking/connectors/types';

function fakeSocket(): Socket {
  const socket = {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    opened: Promise.resolve({}),
    closed: new Promise<void>(() => undefined),
    close: vi.fn(async () => undefined),
    startTls: () => socket,
  };
  return socket as unknown as Socket;
}

function rule(change: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 'route',
    enabled: true,
    match: { domainSuffixes: ['example.com'] },
    action: { type: 'use', profileId: 'proxy' },
    ...change,
  };
}

function proxyProfile(type: EgressProfile['type'] = 'socks5'): EgressProfile {
  if (type === 'direct') {
    return { id: 'proxy', type, enabled: true, timeoutMs: 5_000 };
  }
  if (type === 'proxyip') {
    return {
      id: 'proxy',
      type,
      enabled: true,
      timeoutMs: 5_000,
      endpoints: ['proxy.example:443'],
    };
  }
  if (type === 'turn') {
    return {
      id: 'proxy',
      type,
      enabled: true,
      timeoutMs: 5_000,
      hostname: 'proxy.example',
      port: 3478,
      credentialRef: 'proxy-main',
      transport: 'tcp',
    };
  }
  return {
    id: 'proxy',
    type,
    enabled: true,
    timeoutMs: 5_000,
    hostname: 'proxy.example',
    port: type === 'socks5' ? 1080 : 443,
    credentialRef: 'proxy-main',
  };
}

function snapshot(profile: EgressProfile = proxyProfile()): RuntimeSnapshot {
  const config = createDefaultConfig();
  config.egressProfiles.push(profile);
  config.routing.rules = [rule()];
  return {
    config,
    secrets: { admin: 'admin', configKey: 'key' },
    identity: { vlessUuid: '90cd4a77-141a-43c9-991b-08263cfe9c10' },
    requestId: 'request-id',
  };
}

describe('selectRoute', () => {
  it('uses the first enabled matching rule', () => {
    const config = createDefaultConfig();
    config.egressProfiles.push(proxyProfile());
    config.routing.rules = [
      rule({ id: 'disabled', enabled: false, action: { type: 'block' } }),
      rule({ id: 'selected' }),
      rule({ id: 'later', action: { type: 'block' } }),
    ];

    expect(selectRoute({ hostname: 'api.example.com', port: 443 }, 'vless', config)).toEqual({
      type: 'use',
      profileId: 'proxy',
      ruleId: 'selected',
    });
  });

  it('uses the default profile when no rule matches', () => {
    expect(
      selectRoute({ hostname: 'other.test', port: 443 }, 'vless', createDefaultConfig()),
    ).toEqual({ type: 'use', profileId: 'direct' });
  });

  it('matches exact domains, ports and inbound protocols together', () => {
    const config = createDefaultConfig();
    config.egressProfiles.push(proxyProfile());
    config.routing.rules = [
      rule({
        match: {
          domains: ['api.internal.example'],
          ports: [8443],
          inboundProtocols: ['trojan'],
        },
      }),
    ];

    expect(
      selectRoute({ hostname: 'api.internal.example', port: 8443 }, 'trojan', config),
    ).toMatchObject({ profileId: 'proxy' });
    expect(
      selectRoute({ hostname: 'api.internal.example', port: 443 }, 'trojan', config),
    ).toMatchObject({ profileId: 'direct' });
  });
});

describe('Dialer', () => {
  function dependencies(connector: Connector): DialerDependencies {
    const registry: ConnectorRegistry = {
      get: vi.fn(() => connector),
    };
    return {
      registry,
      resolveCredential: vi.fn(async () => ({ username: 'alice', password: 'secret' })),
      resolveTarget: vi.fn(async () => ['203.0.113.10']),
    };
  }

  it('dispatches only to the selected connector with credential and signal', async () => {
    const connect = vi.fn(async () => fakeSocket());
    const connector: Connector = { connect };
    const deps = dependencies(connector);
    const signal = new AbortController().signal;
    const target: DialTarget = { hostname: 'api.example.com', port: 443 };

    const result = await createDialer(snapshot(), deps).connect(
      target,
      'vless',
      signal,
      new Uint8Array([1, 2]),
    );

    expect(result.profile.id).toBe('proxy');
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ id: 'proxy', type: 'socks5' }),
      { username: 'alice', password: 'secret' },
      signal,
      new Uint8Array([1, 2]),
    );
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.1.1', '::1'])(
    'blocks private target %s before connector dispatch',
    async (hostname) => {
      const connect = vi.fn(async () => fakeSocket());
      const deps = dependencies({ connect });

      await expect(
        createDialer(snapshot(), deps).connect(
          { hostname, port: 443 },
          'vless',
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(BlockedTargetError);
      expect(connect).not.toHaveBeenCalled();
      expect(deps.resolveTarget).not.toHaveBeenCalled();
    },
  );

  it('blocks a hostname when DNS resolves to a private address', async () => {
    const connect = vi.fn(async () => fakeSocket());
    const deps = dependencies({ connect });
    deps.resolveTarget = vi.fn(async () => ['10.0.0.8']);

    await expect(
      createDialer(snapshot(), deps).connect(
        { hostname: 'rebinding.example.com', port: 443 },
        'vless',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(BlockedTargetError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('fails closed when a hostname cannot be resolved for private-target enforcement', async () => {
    const connect = vi.fn(async () => fakeSocket());
    const deps = dependencies({ connect });
    deps.resolveTarget = vi.fn(async () => []);

    await expect(
      createDialer(snapshot(), deps).connect(
        { hostname: 'unresolved.example.com', port: 443 },
        'vless',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(BlockedTargetError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects an already aborted request before resolving credentials', async () => {
    const deps = dependencies({ connect: vi.fn(async () => fakeSocket()) });
    const controller = new AbortController();
    controller.abort();

    await expect(
      createDialer(snapshot(), deps).connect(
        { hostname: 'api.example.com', port: 443 },
        'vless',
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.resolveCredential).not.toHaveBeenCalled();
  });
});
