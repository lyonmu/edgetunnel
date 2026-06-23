import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';

describe('legacy migration bridge', () => {
  it('keeps unported version routing available', async () => {
    const response = await worker.fetch(
      new Request(`https://example.com/version?uuid=${uuid}`, {
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      }),
      {
        KV: env.KV,
        ASSETS: env.ASSETS,
        ADMIN: 'admin',
        UUID: uuid,
      },
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toHaveProperty('Version');
  });
});
