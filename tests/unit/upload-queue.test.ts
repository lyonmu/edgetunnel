import { describe, expect, it, vi } from 'vitest';
import { createUploadQueue } from '../../src/networking/upload-queue';

describe('createUploadQueue', () => {
  function makeFakeWriter() {
    const writes: Uint8Array[] = [];
    const writer = {
      write: vi.fn(async (chunk: Uint8Array) => { writes.push(chunk); }),
      releaseLock: vi.fn(),
    };
    return { writer, writes };
  }

  it('enqueues and drains data', async () => {
    const { writer, writes } = makeFakeWriter();
    const queue = createUploadQueue({
      getWriter: () => writer,
      releaseWriter: vi.fn(),
      name: 'test',
    });

    const data = new Uint8Array([1, 2, 3]);
    const result = queue.enqueue(data);
    expect(result).toBe(true);

    await queue.waitIdle();
    expect(writes.length).toBe(1);
    expect(writes[0]).toEqual(data);
  });

  it('returns false when no writer available', () => {
    const queue = createUploadQueue({
      getWriter: () => null,
      releaseWriter: vi.fn(),
      name: 'test',
    });

    const result = queue.enqueue(new Uint8Array([1, 2, 3]));
    expect(result).toBe(false);
  });

  it('rejects when queue is closed', () => {
    const { writer } = makeFakeWriter();
    const queue = createUploadQueue({
      getWriter: () => writer,
      releaseWriter: vi.fn(),
      name: 'test',
    });

    queue.clear();
    const result = queue.enqueue(new Uint8Array([1, 2, 3]));
    expect(result).toBe(false);
  });

  it('bundles small chunks together', async () => {
    const { writer, writes } = makeFakeWriter();
    const queue = createUploadQueue({
      getWriter: () => writer,
      releaseWriter: vi.fn(),
      name: 'test',
    });

    queue.enqueue(new Uint8Array([1, 2]));
    queue.enqueue(new Uint8Array([3, 4]));
    await queue.waitIdle();

    expect(writes.length).toBe(1);
    expect(writes[0]).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('enqueueAndWait resolves after flush', async () => {
    const { writer, writes } = makeFakeWriter();
    const queue = createUploadQueue({
      getWriter: () => writer,
      releaseWriter: vi.fn(),
      name: 'test',
    });

    const data = new Uint8Array([1, 2, 3]);
    await queue.enqueueAndWait(data);
    expect(writes.length).toBe(1);
    expect(writes[0]).toEqual(data);
  });
});
