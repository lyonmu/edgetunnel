import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const userAgent = 'edgetunnel-test';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function testEnv(): Env {
  return {
    KV: env.KV,
    ASSETS: env.ASSETS,
    ADMIN: 'admin',
    KEY: 'test-key',
    UUID: uuid,
  };
}

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(`https://example.com${path}`, init),
    testEnv(),
    createExecutionContext(),
  );
}

async function loginCookie(): Promise<string> {
  const response = await fetchWorker('/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: 'password=admin',
  });
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')?.split(';')[0] ?? '';
}

describe('admin routes', () => {
  beforeEach(async () => {
    await Promise.all(
      ['config.json', 'tg.json', 'cf.json', 'ADD.txt', 'log.json'].map((key) => env.KV.delete(key)),
    );
  });

  it('authenticates and serves the local admin asset', async () => {
    const unauthenticated = await fetchWorker('/admin', {
      headers: { 'User-Agent': userAgent },
    });
    expect(unauthenticated.status).toBe(302);
    expect(unauthenticated.headers.get('Location')).toBe('/login');

    const cookie = await loginCookie();
    const authenticated = await fetchWorker('/admin', {
      headers: { Cookie: cookie, 'User-Agent': userAgent },
    });

    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toContain('优选');
  });

  it('reads and saves compatible config JSON', async () => {
    const cookie = await loginCookie();
    const headers = {
      Cookie: cookie,
      'User-Agent': userAgent,
    };
    const initial = await fetchWorker('/admin/config.json', { headers });
    const initialValue: unknown = await initial.json();
    if (!isRecord(initialValue)) {
      throw new Error('Expected config object');
    }
    const initialConfig = initialValue;
    expect(initial.status).toBe(200);
    expect(initialConfig.UUID).toBe(uuid);

    const savedConfig = { ...initialConfig, HOST: 'saved.example', UUID: uuid };
    const saved = await fetchWorker('/admin/config.json', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(savedConfig),
    });
    expect(saved.status).toBe(200);

    const stored = JSON.parse((await env.KV.get('config.json')) ?? '{}') as Record<string, unknown>;
    expect(stored.HOST).toBe('saved.example');
  });

  it('round-trips ADD.txt and returns log arrays', async () => {
    const cookie = await loginCookie();
    const headers = { Cookie: cookie, 'User-Agent': userAgent };
    const saved = await fetchWorker('/admin/ADD.txt', {
      method: 'POST',
      headers,
      body: '1.1.1.1:443#test',
    });
    expect(saved.status).toBe(200);

    const read = await fetchWorker('/admin/ADD.txt', { headers });
    expect(await read.text()).toBe('1.1.1.1:443#test');

    const logs = await fetchWorker('/admin/log.json', { headers });
    expect(await logs.json()).toEqual([]);
  });

  it('clears the session on logout', async () => {
    const response = await fetchWorker('/logout');

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});
