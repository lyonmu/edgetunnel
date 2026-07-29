import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('admin assets', () => {
  it.each([
    ['/login', 'EdgeTunnel'],
    ['/admin', 'EdgeTunnel'],
  ])('serves %s from local assets', async (path, marker) => {
    const response = await env.ASSETS.fetch(new Request(`https://example.com${path}`));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(marker);
  });
});
