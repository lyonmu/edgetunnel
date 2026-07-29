import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { createLegacyAuthToken } from '../../src/auth/legacy-session';
import { md5Twice } from '../../src/shared/hash';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const admin = 'admin';
const key = 'test-key';
const baseEnv = {
  KV: env.KV,
  ASSETS: env.ASSETS,
  ADMIN: admin,
  UUID: uuid,
  KEY: key,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pure Worker HTTP fallback routes', () => {
  it('serves /version before WebSocket routing when the identifier matches', async () => {
    const response = await worker.fetch(
      new Request(`https://example.com/version?uuid=${uuid}`, {
        headers: { Upgrade: 'websocket' },
      }),
      baseEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toHaveProperty('Version');
    expect(response.webSocket).toBeNull();
  });

  it('proxies authenticated /locations requests', async () => {
    const userAgent = 'route-test';
    const token = await createLegacyAuthToken(userAgent, key, admin);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ iata: 'SJC' }]), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://example.com/locations', {
        headers: { Cookie: `auth=${token}`, 'User-Agent': userAgent },
      }),
      baseEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://speed.cloudflare.com/locations' }),
    );
  });

  it('redirects the configured quick subscription path with a valid token', async () => {
    const response = await worker.fetch(
      new Request(`https://example.com/${key}?clash=1`),
      baseEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get('Location')!;
    expect(location).toContain('/sub?');
    expect(location).toContain(`token=${await md5Twice(`example.com${uuid}`)}`);
    expect(location).toContain('clash=1');
  });

  it('rewrites textual camouflage responses back to the Worker host', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<a href="https://origin.example/path">origin.example</a>', {
          headers: { 'Content-Type': 'text/html', 'Content-Length': '64' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://worker.example/path?q=1'),
      { ...baseEnv, URL: 'origin.example' },
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('worker.example');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.has('Content-Length')).toBe(false);
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
        ASSETS: env.ASSETS,
        ADMIN: admin,
        UUID: uuid,
        CONFIG_KEY: 'not-used-without-kv',
      } as Env,
      createExecutionContext(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'RUNTIME_NOT_CONFIGURED' },
    });
  });
});
