import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRequestContext } from '../../src/app/request-context';

function createEnv(): Env {
  return {
    KV: env.KV,
    ASSETS: env.ASSETS,
    ADMIN: 'admin',
    UUID: '90cd4a77-141a-43c9-991b-08263cfe9c10',
    CONFIG_KEY: 'test',
    TROJAN_PASSWORD: 'trojan',
    SHADOWSOCKS_PASSWORD: 'shadowsocks',
  };
}

describe('request state isolation', () => {
  it('does not interpret URL proxy credentials as runtime state', async () => {
    const [first, second] = await Promise.all([
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

    expect(first.url.searchParams.has('socks5')).toBe(true);
    expect(second.url.searchParams.has('proxyip')).toBe(true);
    expect(first).not.toHaveProperty('proxy');
    expect(second).not.toHaveProperty('proxy');
    expect(first.requestId).not.toBe(second.requestId);
  });
});
