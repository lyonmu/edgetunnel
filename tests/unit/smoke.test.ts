import { describe, expect, it } from 'vitest';
import worker from '../../src/index';

describe('Worker smoke', () => {
  it('serves robots.txt', async () => {
    const env = {
      KV: {} as KVNamespace,
      ASSETS: {} as Fetcher,
    };
    const response = await worker.fetch(new Request('https://example.com/robots.txt'), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('User-agent: *\nDisallow: /');
  });
});
