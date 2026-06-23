import { describe, expect, it, vi } from 'vitest';
import { createDownloadGrainSender, closeSocketQuietly } from '../../src/networking/stream-pump';

describe('closeSocketQuietly', () => {
  it('closes an open WebSocket', () => {
    const ws = { readyState: 1, close: vi.fn() } as any;
    closeSocketQuietly(ws);
    expect(ws.close).toHaveBeenCalled();
  });

  it('does nothing for a closed WebSocket', () => {
    const ws = { readyState: 3, close: vi.fn() } as any;
    closeSocketQuietly(ws);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('catches close errors', () => {
    const ws = {
      readyState: 1,
      close: vi.fn(() => {
        throw new Error('fail');
      }),
    } as any;
    expect(() => closeSocketQuietly(ws)).not.toThrow();
  });
});

describe('createDownloadGrainSender', () => {
  it('sends data directly', async () => {
    const sent: Uint8Array[] = [];
    const ws = {
      readyState: 1,
      send: vi.fn(async (data: Uint8Array) => {
        sent.push(data);
      }),
    } as any;

    const sender = createDownloadGrainSender(ws);
    await sender.sendDirect(new Uint8Array([1, 2, 3]));
    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('throws when WebSocket is not open', async () => {
    const ws = { readyState: 3 } as any;
    const sender = createDownloadGrainSender(ws);
    await expect(sender.sendDirect(new Uint8Array([1]))).rejects.toThrow('not open');
  });
});
