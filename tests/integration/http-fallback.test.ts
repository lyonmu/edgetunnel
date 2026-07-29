import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { createDefaultConfig } from '../../src/config/defaults';
import { CONFIG_KEY } from '../../src/config/repository';
import { encodeBase64Url } from '../../src/security/crypto';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const admin = 'admin';
const configEncryptionKey = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index));
const baseEnv = {
  KV: env.KV,
  ASSETS: env.ASSETS,
  ADMIN: admin,
  UUID: uuid,
  CONFIG_KEY: configEncryptionKey,
  TROJAN_PASSWORD: 'trojan',
  SHADOWSOCKS_PASSWORD: 'shadowsocks',
};

beforeEach(async () => {
  await env.KV.delete(CONFIG_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pure Worker HTTP fallback routes', () => {
  it('serves /version before WebSocket routing', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/version', {
        headers: { Upgrade: 'websocket' },
      }),
      baseEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toHaveProperty('Version');
    expect(response.webSocket).toBeNull();
  });

  it('streams the configured camouflage response', async () => {
    const config = createDefaultConfig();
    config.site.camouflageUrl = 'https://origin.example';
    await env.KV.put(CONFIG_KEY, JSON.stringify(config));
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request).toBeInstanceOf(Request);
      return new Response('<a href="https://origin.example/path">origin.example</a>', {
        headers: { 'Content-Type': 'text/html', 'Content-Length': '64' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://worker.example/path?q=1', {
        headers: {
          Cookie: 'edt_session=must-not-leak',
          Authorization: 'Bearer must-not-leak',
          'CF-Connecting-IP': '203.0.113.10',
        },
      }),
      baseEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('origin.example');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://origin.example/path?q=1' }),
    );
    const upstreamRequest = fetchMock.mock.calls[0]![0];
    expect(upstreamRequest.headers.has('Cookie')).toBe(false);
    expect(upstreamRequest.headers.has('Authorization')).toBe(false);
    expect(upstreamRequest.headers.has('CF-Connecting-IP')).toBe(false);
  });

  it('uses the local nginx page when camouflage is not configured', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/unknown'),
      baseEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Welcome to nginx!');
  });

  it('returns a structured service error when the admin API has no KV binding', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/admin/v1/config'),
      {
        KV: undefined!,
        ASSETS: env.ASSETS,
        ADMIN: admin,
        UUID: uuid,
        CONFIG_KEY: 'not-used-without-kv',
        TROJAN_PASSWORD: 'trojan',
        SHADOWSOCKS_PASSWORD: 'shadowsocks',
      },
      createExecutionContext(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'RUNTIME_NOT_CONFIGURED' },
    });
  });
});
