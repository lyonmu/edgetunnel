import { describe, expect, it, vi } from 'vitest';
import { fetchTextLimited } from '../../src/shared/fetch-limited';

describe('fetchTextLimited', () => {
  it('returns text from successful response', async () => {
    const mockResponse = new Response('hello world', { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    const result = await fetchTextLimited('https://example.com', undefined, {
      timeoutMs: 5000,
      maxBytes: 1024,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.text).toBe('hello world');

    fetchSpy.mockRestore();
  });

  it('aborts on timeout', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('aborted')), 100);
        }),
    );

    await expect(
      fetchTextLimited('https://example.com', undefined, {
        timeoutMs: 1,
        maxBytes: 1024,
      }),
    ).rejects.toThrow();

    fetchSpy.mockRestore();
  });

  it('stops reading when maxBytes exceeded', async () => {
    const largeBody = 'x'.repeat(2048);
    const mockResponse = new Response(largeBody, { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    const result = await fetchTextLimited('https://example.com', undefined, {
      timeoutMs: 5000,
      maxBytes: 100,
    });

    expect(result.text.length).toBeLessThanOrEqual(100);

    fetchSpy.mockRestore();
  });

  it('preserves non-2xx status', async () => {
    const mockResponse = new Response('not found', { status: 404, statusText: 'Not Found' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    const result = await fetchTextLimited('https://example.com', undefined, {
      timeoutMs: 5000,
      maxBytes: 1024,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.statusText).toBe('Not Found');

    fetchSpy.mockRestore();
  });
});
