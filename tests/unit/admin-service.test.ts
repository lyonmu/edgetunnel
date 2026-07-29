import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { AdminService } from '../../src/admin/service';
import { createDefaultConfig } from '../../src/config/defaults';
import type { RuntimeSnapshot } from '../../src/config/runtime';
import type { ConnectorRegistry } from '../../src/networking/connectors/types';
import { encodeBase64Url } from '../../src/security/crypto';

function socket(): Socket {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    opened: Promise.resolve({ remoteAddress: null, localAddress: null }),
    closed: Promise.resolve(),
    close: vi.fn(async () => undefined),
    startTls() {
      return this;
    },
  } as unknown as Socket;
}

describe('AdminService profile test', () => {
  it('tests the selected profile against a bounded public target and closes the socket', async () => {
    const connected = socket();
    const connect = vi.fn(async () => connected);
    const registry: ConnectorRegistry = {
      get: vi.fn(() => ({ connect })),
    };
    const config = createDefaultConfig();
    const snapshot: RuntimeSnapshot = {
      config,
      secrets: {
        admin: 'admin',
        configKey: encodeBase64Url(new Uint8Array(32)),
      },
      identity: { vlessUuid: '90cd4a77-141a-43c9-991b-08263cfe9c10' },
      requestId: crypto.randomUUID(),
    };
    const service = new AdminService(
      env.KV,
      snapshot.secrets.configKey,
      100,
      registry,
      vi.fn(async () => ['142.250.72.195']),
    );

    const result = await service.testProfile(snapshot, 'direct', {
      hostname: 'www.gstatic.com',
      port: 443,
    });

    expect(connect).toHaveBeenCalledWith(
      { hostname: 'www.gstatic.com', port: 443 },
      expect.objectContaining({ id: 'direct', type: 'direct' }),
      null,
      expect.any(AbortSignal),
      undefined,
    );
    expect(connected.close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      profileId: 'direct',
      profileType: 'direct',
      target: { hostname: 'www.gstatic.com', port: 443 },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
