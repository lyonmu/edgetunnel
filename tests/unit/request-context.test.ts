import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRequestContext } from '../../src/app/request-context';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    KV: env.KV,
    ASSETS: env.ASSETS,
    ADMIN: 'admin',
    UUID: uuid,
    ...overrides,
  };
}

describe('createRequestContext', () => {
  it('keeps carrier-specific dial concurrency request-local', async () => {
    const cmccRequest = new Request('https://example.com/', {
      cf: { country: 'CN', asn: 9808, colo: 'HKG' },
    });
    const normalRequest = new Request('https://example.com/', {
      cf: { country: 'US', asn: 13335, colo: 'SJC' },
    });

    const cmcc = await createRequestContext(cmccRequest, createEnv(), createExecutionContext());
    const normal = await createRequestContext(normalRequest, createEnv(), createExecutionContext());

    expect(cmcc.dialConcurrency).toBe(1);
    expect(normal.dialConcurrency).toBe(2);
  });

  it('does not persist feature flags between requests', async () => {
    const enabled = await createRequestContext(
      new Request('https://example.com/'),
      createEnv({ DEBUG: 'true', PRELOAD_RACE_DIAL: '1' }),
      createExecutionContext(),
    );
    const disabled = await createRequestContext(
      new Request('https://example.com/'),
      createEnv({ DEBUG: '', PRELOAD_RACE_DIAL: '' }),
      createExecutionContext(),
    );

    expect(enabled.debug).toBe(true);
    expect(enabled.preloadRaceDial).toBe(true);
    expect(disabled.debug).toBe(false);
    expect(disabled.preloadRaceDial).toBe(false);
  });
});
