import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { CONFIG_KEY } from '../../src/config/repository';
import { SECRET_STORE_KEY } from '../../src/security/secret-store';
import { encodeBase64Url } from '../../src/security/crypto';
import { LogRepository } from '../../src/storage/log-repository';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const origin = 'https://example.com';
const configEncryptionKey = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index));

function testEnv(): Env {
  return {
    KV: env.KV,
    ASSETS: env.ASSETS,
    ADMIN: 'admin',
    UUID: uuid,
    CONFIG_KEY: configEncryptionKey,
    TROJAN_PASSWORD: 'trojan',
    SHADOWSOCKS_PASSWORD: 'shadowsocks',
  };
}

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), testEnv(), createExecutionContext());
}

async function loginCookie(): Promise<string> {
  const response = await fetchWorker('/api/admin/v1/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password: 'admin' }),
  });
  expect(response.status).toBe(201);
  return response.headers.get('Set-Cookie')?.split(';')[0] ?? '';
}

describe('versioned admin API', () => {
  beforeEach(async () => {
    await Promise.all([
      ...[CONFIG_KEY, SECRET_STORE_KEY, 'config.json'].map((key) => env.KV.delete(key)),
      new LogRepository(env.KV).clear(),
    ]);
  });

  it('does not route an admin POST into XHTTP', async () => {
    const response = await fetchWorker('/api/admin/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ password: 'wrong' }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_CREDENTIALS' },
    });
  });

  it('creates and verifies a hardened session', async () => {
    const cookie = await loginCookie();
    expect(cookie).toMatch(/^edt_session=/);

    const response = await fetchWorker('/api/admin/v1/session', {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { authenticated: true } });
  });

  it('writes a redacted security event for a denied login', async () => {
    const execution = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${origin}/api/admin/v1/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'CF-Connecting-IP': '203.0.113.42',
        },
        body: JSON.stringify({ password: 'wrong-password' }),
      }),
      testEnv(),
      execution,
    );
    await waitOnExecutionContext(execution);

    expect(response.status).toBe(401);
    const logs = await new LogRepository(env.KV).read();
    expect(logs).toContainEqual(
      expect.objectContaining({
        type: 'admin_login',
        outcome: 'denied',
        details: { clientIp: '203.0.113.0/24' },
      }),
    );
    expect(JSON.stringify(logs)).not.toContain('wrong-password');
  });

  it('rejects unauthenticated config access', async () => {
    const response = await fetchWorker('/api/admin/v1/config');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTH_REQUIRED' },
    });
  });

  it('reads and updates v1 config with revision conflict protection', async () => {
    const cookie = await loginCookie();
    const initial = await fetchWorker('/api/admin/v1/config', {
      headers: { Cookie: cookie },
    });
    const initialBody = (await initial.json()) as { data: { config: Record<string, unknown> } };
    expect(initialBody.data.config).toMatchObject({ schemaVersion: 1, revision: 1 });
    expect(JSON.stringify(initialBody)).not.toContain(configEncryptionKey);

    const config = structuredClone(initialBody.data.config);
    (config.observability as Record<string, unknown>).logLevel = 'info';
    const saved = await fetchWorker('/api/admin/v1/config', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ config, expectedRevision: 1 }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      data: { config: { revision: 2, observability: { logLevel: 'info' } } },
    });

    const stale = await fetchWorker('/api/admin/v1/config', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ config, expectedRevision: 1 }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: 'CONFIG_REVISION_CONFLICT' },
    });
  });

  it('does not mutate encrypted credentials for a stale config update', async () => {
    const cookie = await loginCookie();
    const initial = await fetchWorker('/api/admin/v1/config', {
      headers: { Cookie: cookie },
    });
    const initialBody = (await initial.json()) as { data: { config: Record<string, unknown> } };
    const config = structuredClone(initialBody.data.config);

    const first = await fetchWorker('/api/admin/v1/config', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ config, expectedRevision: 1 }),
    });
    expect(first.status).toBe(200);

    const stale = await fetchWorker('/api/admin/v1/config', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config,
        expectedRevision: 1,
        credentials: { 'stale-credential': { username: 'user', password: 'secret' } },
      }),
    });

    expect(stale.status).toBe(409);
    expect(await env.KV.get(SECRET_STORE_KEY)).toBeNull();
  });

  it('rejects cross-origin state changes', async () => {
    const cookie = await loginCookie();
    const response = await fetchWorker('/api/admin/v1/config', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        Origin: 'https://attacker.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ config: {}, expectedRevision: 1 }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ORIGIN' },
    });
  });

  it('expires the session and removes old compatibility APIs', async () => {
    const cookie = await loginCookie();
    const logout = await fetchWorker('/api/admin/v1/session', {
      method: 'DELETE',
      headers: { Cookie: cookie, Origin: origin },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');

    for (const path of ['/admin/config.json', '/admin/ADD.txt', '/admin/log.json']) {
      const response = await fetchWorker(path, { headers: { Cookie: cookie } });
      expect(response.status).toBe(404);
    }
  });

  it('previews subscriptions from the current runtime snapshot', async () => {
    const cookie = await loginCookie();
    const response = await fetchWorker('/api/admin/v1/subscriptions/preview?format=clash', {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { format: string; nodeCount: number; subscriptionUrl: string };
    };
    expect(body).toMatchObject({
      data: {
        format: 'clash',
        nodeCount: 1,
      },
    });
    const subscriptionUrl = new URL(body.data.subscriptionUrl);
    expect(subscriptionUrl.origin).toBe(origin);
    expect(subscriptionUrl.pathname).toBe('/sub');
    expect(subscriptionUrl.searchParams.get('format')).toBe('clash');
    expect(subscriptionUrl.searchParams.get('token')).toMatch(/^v1\./);
    expect(body.data.subscriptionUrl).not.toContain(uuid);
    expect(body.data.subscriptionUrl).not.toContain('admin');
  });

  it('returns not found for an unknown profile test', async () => {
    const cookie = await loginCookie();
    const response = await fetchWorker('/api/admin/v1/profiles/missing/test', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROFILE_NOT_FOUND' },
    });
  });
});
