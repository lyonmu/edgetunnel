import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index';

describe('Worker smoke', () => {
  it('serves robots.txt', async () => {
    const testEnv = {
      KV: env.KV,
      ASSETS: env.ASSETS,
      ADMIN: 'admin',
      UUID: '90cd4a77-141a-43c9-991b-08263cfe9c10',
      CONFIG_KEY: 'test',
      TROJAN_PASSWORD: 'trojan',
      SHADOWSOCKS_PASSWORD: 'shadowsocks',
    };
    const response = await worker.fetch(
      new Request('https://example.com/robots.txt'),
      testEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('User-agent: *\nDisallow: /');
  });
});
