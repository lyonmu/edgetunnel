import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../src/config/defaults';
import { ConfigValidationError, type WorkerConfigV1 } from '../../src/config/schema';
import { parseWorkerConfig } from '../../src/config/validate';

function withConfig(change: (config: WorkerConfigV1) => void): WorkerConfigV1 {
  const config = structuredClone(createDefaultConfig());
  change(config);
  return config;
}

function expectIssue(config: unknown, path: string): void {
  try {
    parseWorkerConfig(config);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).issues.some((issue) => issue.path === path)).toBe(true);
    return;
  }
  throw new Error(`Expected configuration issue at ${path}`);
}

describe('WorkerConfigV1', () => {
  it('accepts the complete default configuration without changing it', () => {
    const defaults = createDefaultConfig();

    expect(parseWorkerConfig(structuredClone(defaults))).toEqual(defaults);
    expect(defaults).toEqual(createDefaultConfig());
  });

  it('rejects unknown root fields', () => {
    expectIssue({ ...createDefaultConfig(), legacy: true }, '/legacy');
  });

  it('rejects a schema version other than one', () => {
    expectIssue({ ...createDefaultConfig(), schemaVersion: 2 }, '/schemaVersion');
  });

  it('rejects ports outside the TCP range', () => {
    const config = withConfig((draft) => {
      draft.egressProfiles.push({
        id: 'invalid-socks',
        type: 'socks5',
        enabled: true,
        timeoutMs: 5_000,
        hostname: 'proxy.example.com',
        port: 65_536,
        credentialRef: 'proxy-main',
      });
    });

    expectIssue(config, '/egressProfiles/1/port');
  });

  it('rejects duplicate egress profile ids', () => {
    const config = withConfig((draft) => {
      draft.egressProfiles.push({
        id: 'direct',
        type: 'proxyip',
        enabled: true,
        timeoutMs: 5_000,
        endpoints: ['proxy.example.com:443'],
      });
    });

    expectIssue(config, '/egressProfiles/1/id');
  });

  it('rejects a missing default egress profile', () => {
    const config = withConfig((draft) => {
      draft.routing.defaultProfileId = 'missing';
    });

    expectIssue(config, '/routing/defaultProfileId');
  });

  it('rejects a rule that references a missing egress profile', () => {
    const config = withConfig((draft) => {
      draft.routing.rules.push({
        id: 'missing-profile',
        enabled: true,
        match: { domainSuffixes: ['example.com'] },
        action: { type: 'use', profileId: 'missing' },
      });
    });

    expectIssue(config, '/routing/rules/0/action/profileId');
  });

  it.each(['/admin', '/api/admin/v1', '/sub'])(
    'rejects reserved WebSocket path %s',
    (reservedPath) => {
      const config = withConfig((draft) => {
        draft.transports.websocket.path = reservedPath;
      });

      expectIssue(config, '/transports/websocket/path');
    },
  );

  it('rejects duplicate enabled transport paths', () => {
    const config = withConfig((draft) => {
      draft.transports.xhttp.enabled = true;
      draft.transports.xhttp.path = draft.transports.websocket.path;
    });

    expectIssue(config, '/transports/xhttp/path');
  });

  it('rejects insecure DoH and public base URLs', () => {
    expectIssue(
      withConfig((draft) => {
        draft.dns.dohUrl = 'http://dns.example.com/query';
      }),
      '/dns/dohUrl',
    );
    expectIssue(
      withConfig((draft) => {
        draft.subscription.publicBaseUrl = 'http://worker.example.com';
      }),
      '/subscription/publicBaseUrl',
    );
  });
});
