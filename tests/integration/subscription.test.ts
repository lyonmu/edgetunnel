import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { createDefaultConfig } from '../../src/config/defaults';
import { CONFIG_KEY } from '../../src/config/repository';
import { createSubscriptionToken } from '../../src/auth/subscription-token';
import { encodeBase64Url } from '../../src/security/crypto';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const host = 'subscription.example.com';
const admin = 'admin-secret';
const configEncryptionKey = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index));

function testEnv(): Env {
  return {
    KV: env.KV,
    ASSETS: env.ASSETS,
    ADMIN: admin,
    UUID: uuid,
    CONFIG_KEY: configEncryptionKey,
    TROJAN_PASSWORD: 'trojan-pass',
    SHADOWSOCKS_PASSWORD: 'shadowsocks-pass',
  };
}

async function fetchWorker(
  path: string,
  userAgent: string,
  authenticated = true,
): Promise<Response> {
  const url = new URL(`https://${host}${path}`);
  if (authenticated) url.searchParams.set('token', await createSubscriptionToken(admin, uuid));
  return worker.fetch(
    new Request(url, { headers: { 'User-Agent': userAgent } }),
    testEnv(),
    createExecutionContext(),
  );
}

describe('native subscription routes', () => {
  beforeEach(async () => {
    const config = createDefaultConfig();
    config.inbound.trojan.enabled = true;
    await env.KV.put(CONFIG_KEY, JSON.stringify(config));
    vi.restoreAllMocks();
  });

  it('returns raw mixed nodes for browser user agents', async () => {
    const response = await fetchWorker('/sub', 'Mozilla/5.0');
    const link = new URL((await response.text()).split('\n')[0]!);

    expect(response.status).toBe(200);
    expect(link.protocol).toBe('vless:');
    expect(link.searchParams.get('packetEncoding')).toBe('xudp');
    expect(link.username).toBe(uuid);
  });

  it('base64-encodes the mixed subscription exactly once', async () => {
    const response = await fetchWorker('/sub?format=base64', 'curl/8');
    const decoded = atob(await response.text());

    expect(response.status).toBe(200);
    expect(decoded).toMatch(/^vless:\/\//);
  });

  it.each([
    ['clash', 'application/x-yaml', JSON.parse],
    ['singbox', 'application/json', JSON.parse],
    ['surge', 'text/plain', (value: string) => value],
  ])('generates %s locally without a converter request', async (format, type, parse) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await fetchWorker(`/sub?format=${format}`, 'client');
    const content = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain(type);
    expect(() => parse(content)).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not expose subscription data without a valid HMAC token', async () => {
    const response = await fetchWorker('/sub', 'Mozilla/5.0', false);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Welcome to nginx!');
  });

  it('rejects unknown and disabled explicit formats', async () => {
    const unknown = await fetchWorker('/sub?format=quanx', 'client');
    expect(unknown.status).toBe(400);

    const config = createDefaultConfig();
    config.inbound.trojan.enabled = true;
    config.subscription.formats = ['mixed'];
    await env.KV.put(CONFIG_KEY, JSON.stringify(config));
    const disabled = await fetchWorker('/sub?format=clash', 'client');
    expect(disabled.status).toBe(400);
  });
});
