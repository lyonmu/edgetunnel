import { describe, expect, it, vi } from 'vitest';
import type { TransportBridge } from '../../src/transports/bridge';
import { createDnsUdpSession } from '../../src/networking/udp-dns';

function collectingBridge() {
  const sent: Uint8Array[] = [];
  const bridge: TransportBridge = {
    readyState: WebSocket.OPEN,
    send(data) {
      sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
    },
    close() {},
  };
  return { bridge, sent };
}

describe('DNS UDP session', () => {
  it('buffers fragmented VLESS UDP frames and sends the response header once', async () => {
    const { bridge, sent } = collectingBridge();
    const query = vi.fn(async (payload: Uint8Array) => new Uint8Array([...payload, 9]));
    const session = createDnsUdpSession('vless', bridge, new Uint8Array([0, 0]), query);

    await session.push(new Uint8Array([0, 3, 1]));
    expect(query).not.toHaveBeenCalled();
    await session.push(new Uint8Array([2, 3]));
    await session.push(new Uint8Array([0, 1, 4]));

    expect(query).toHaveBeenNthCalledWith(1, new Uint8Array([1, 2, 3]));
    expect(query).toHaveBeenNthCalledWith(2, new Uint8Array([4]));
    expect(sent).toEqual([new Uint8Array([0, 0, 0, 4, 1, 2, 3, 9]), new Uint8Array([0, 2, 4, 9])]);
  });

  it('parses and re-encapsulates fragmented Trojan UDP frames', async () => {
    const { bridge, sent } = collectingBridge();
    const query = vi.fn(async () => new Uint8Array([7, 8]));
    const session = createDnsUdpSession('trojan', bridge, null, query);
    const address = new Uint8Array([3, 3, 100, 110, 115, 0, 53]);
    const frame = new Uint8Array([...address, 0, 2, 13, 10, 1, 2]);

    await session.push(frame.slice(0, 5));
    await session.push(frame.slice(5));

    expect(query).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    expect(sent).toEqual([new Uint8Array([...address, 0, 2, 13, 10, 7, 8])]);
  });

  it('rejects non-DNS Trojan UDP packets', async () => {
    const { bridge } = collectingBridge();
    const session = createDnsUdpSession('trojan', bridge, null, async () => new Uint8Array());
    const frame = new Uint8Array([1, 192, 0, 2, 1, 0, 80, 0, 1, 13, 10, 1]);

    await expect(session.push(frame)).rejects.toThrow('UDP is not supported');
  });
});
