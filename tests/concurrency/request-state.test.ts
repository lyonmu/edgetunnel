import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRequestContext } from '../../src/app/request-context';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    KV: env.KV,
    ASSETS: env.ASSETS,
    ADMIN: 'admin',
    UUID: uuid,
    ...overrides,
  };
}

describe('request state isolation', () => {
  it('keeps concurrent proxy parameters isolated', async () => {
    const [socks, proxyIp] = await Promise.all([
      createRequestContext(
        new Request('https://example.com/?socks5=user%3Apass%40proxy.example%3A1080&globalproxy=1'),
        createEnv(),
        createExecutionContext(),
      ),
      createRequestContext(
        new Request('https://example.com/?proxyip=proxy-ip.example%3A443'),
        createEnv(),
        createExecutionContext(),
      ),
    ]);

    expect(socks.proxy).toMatchObject({
      type: 'socks5',
      global: true,
      fallback: true,
      address: {
        username: 'user',
        password: 'pass',
        hostname: 'proxy.example',
        port: 1080,
      },
    });
    expect(proxyIp.proxy).toMatchObject({
      type: 'proxyip',
      proxyIp: 'proxy-ip.example:443',
      fallback: false,
      global: false,
    });
    expect(socks.proxy).not.toBe(proxyIp.proxy);
    expect(socks.proxy.whitelist).not.toBe(proxyIp.proxy.whitelist);
  });
});
