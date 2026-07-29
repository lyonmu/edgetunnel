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

describe('createRequestContext', () => {
  it('creates canonical request-local metadata without legacy parsing', () => {
    const request = new Request('https://example.com/path?proxyip=ignored', {
      headers: {
        'CF-Connecting-IP': '203.0.113.8',
        'User-Agent': 'metadata-test',
      },
    });
    const context = createRequestContext(request, createEnv(), createExecutionContext());

    expect(context.request).toBe(request);
    expect(context.url.pathname).toBe('/path');
    expect(context.clientIp).toBe('203.0.113.8');
    expect(context.userAgent).toBe('metadata-test');
    expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context).not.toHaveProperty('proxy');
    expect(context).not.toHaveProperty('adminPassword');
  });

  it('creates a unique request ID for concurrent requests', async () => {
    const contexts = await Promise.all(
      Array.from({ length: 20 }, async () =>
        createRequestContext(
          new Request('https://example.com/'),
          createEnv(),
          createExecutionContext(),
        ),
      ),
    );

    expect(new Set(contexts.map((context) => context.requestId))).toHaveLength(20);
  });
});
