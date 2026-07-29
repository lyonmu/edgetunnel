import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { createDefaultConfig } from '../../src/config/defaults';
import { SUBSCRIPTION_CONVERTER_TIMEOUT_MS } from '../../src/subscription/routes';
import { md5Twice } from '../../src/shared/hash';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const host = 'subscription.example.com';

function testEnv(): Env {
  return {
    KV: env.KV,
    ASSETS: env.ASSETS,
    ADMIN: 'admin',
    KEY: 'test-key',
    UUID: uuid,
  };
}

async function fetchWorker(
  path: string,
  userAgent: string,
  authenticated = true,
): Promise<Response> {
  const url = new URL(`https://${host}${path}`);
  if (authenticated) url.searchParams.set('token', await md5Twice(`${host}${uuid}`));
  return worker.fetch(
    new Request(url, {
      headers: { 'User-Agent': userAgent },
    }),
    testEnv(),
    createExecutionContext(),
  );
}

describe('subscription routes', () => {
  beforeEach(async () => {
    const config = createDefaultConfig(host, uuid);
    config.订阅转换配置.SUBAPI = 'https://converter.example.com';
    config.订阅转换配置.SUBCONFIG = 'https://config.example.com/profile.ini';
    await Promise.all([
      env.KV.put('config.json', JSON.stringify(config)),
      env.KV.put('ADD.txt', '1.1.1.1:443#test'),
    ]);
    vi.restoreAllMocks();
  });

  it('returns raw mixed nodes for browser user agents', async () => {
    const response = await fetchWorker('/sub', 'Mozilla/5.0');

    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/^vless:\/\//);
  });

  it('generates Shadowsocks plugin links with cipher routing and mux disabled', async () => {
    const config = createDefaultConfig(host, uuid);
    config.协议类型 = 'ss';
    config.PATH = '/proxy';
    await env.KV.put('config.json', JSON.stringify(config));

    const response = await fetchWorker('/sub', 'Mozilla/5.0');
    const link = new URL(await response.text());
    const plugin = link.searchParams.get('plugin');

    expect(plugin).toContain('path=/proxy?enc=aes-128-gcm');
    expect(plugin).toContain(';mux=0');
  });

  it('does not expose subscription data without a valid token', async () => {
    const response = await fetchWorker('/sub', 'Mozilla/5.0', false);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Welcome to nginx!');
  });

  it('base64-encodes the mixed subscription exactly once', async () => {
    const response = await fetchWorker('/sub?base64', 'curl/8');
    const decoded = atob(await response.text());

    expect(response.status).toBe(200);
    expect(decoded).toMatch(/^vless:\/\//);
  });

  it('uses the stored converter endpoint and config', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('mode: Rule\nproxies: []', { status: 200 }));

    const response = await fetchWorker('/sub?clash', 'ClashMeta');
    const converterUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));

    expect(response.status).toBe(200);
    expect(converterUrl.origin).toBe('https://converter.example.com');
    expect(converterUrl.searchParams.get('config')).toBe('https://config.example.com/profile.ini');
  });

  it('allows slow converter responses without using the old 10 second limit', () => {
    expect(SUBSCRIPTION_CONVERTER_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
