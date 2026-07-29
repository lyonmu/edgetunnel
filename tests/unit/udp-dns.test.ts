import { describe, expect, it, vi } from 'vitest';
import type { TransportBridge } from '../../src/transports/bridge';
import { createDnsUdpSession, queryDnsDoh } from '../../src/networking/udp-dns';
import { encodeXudpDatagram } from '../../src/networking/xudp';

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
  it('forwards raw DNS messages through DoH', async () => {
    const query = new Uint8Array([1, 2, 3]);
    const response = new Uint8Array([4, 5, 6]);
    const fetcher = vi.fn(async () => new Response(response, { status: 200 }));

    await expect(queryDnsDoh(query, fetcher)).resolves.toEqual(response);
    expect(fetcher).toHaveBeenCalledWith(
      'https://cloudflare-dns.com/dns-query',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/dns-message',
          'Content-Type': 'application/dns-message',
        },
        body: query,
      }),
    );
  });

  it('uses the configured DoH endpoint and message limit', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([4, 5])));

    await expect(
      queryDnsDoh(new Uint8Array([1, 2]), fetcher, {
        endpoint: 'https://dns.example/dns-query',
        timeoutMs: 500,
        maxMessageBytes: 2,
      }),
    ).resolves.toEqual(new Uint8Array([4, 5]));
    expect(fetcher).toHaveBeenCalledWith('https://dns.example/dns-query', expect.anything());
    await expect(
      queryDnsDoh(new Uint8Array([1, 2, 3]), fetcher, { maxMessageBytes: 2 }),
    ).rejects.toThrow('configured limit');
  });

  it('limits the number of datagrams in one DNS session', async () => {
    const { bridge } = collectingBridge();
    const session = createDnsUdpSession('vless', bridge, null, async (payload) => payload, {
      maxDatagrams: 1,
    });

    await session.push(new Uint8Array([0, 1, 1]));
    await expect(session.push(new Uint8Array([0, 1, 2]))).rejects.toThrow('datagram limit');
  });

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

  it('parses and re-encapsulates fragmented VLESS PacketAddr DNS frames', async () => {
    const { bridge, sent } = collectingBridge();
    const query = vi.fn(async () => new Uint8Array([7, 8]));
    const session = createDnsUdpSession('vless-packetaddr', bridge, new Uint8Array([0, 0]), query);
    const address = new Uint8Array([1, 1, 1, 1, 1, 0, 53]);
    const packet = new Uint8Array([0, 9, ...address, 3, 4]);

    await session.push(packet.slice(0, 5));
    await session.push(packet.slice(5));

    expect(query).toHaveBeenCalledWith(new Uint8Array([3, 4]));
    expect(sent).toEqual([new Uint8Array([0, 0, 0, 9, ...address, 7, 8])]);
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

  it('forwards and re-encapsulates fragmented Single XUDP DNS frames', async () => {
    const { bridge, sent } = collectingBridge();
    const query = vi.fn(async () => new Uint8Array([7, 8]));
    const session = createDnsUdpSession('vless-xudp', bridge, new Uint8Array([0, 0]), query);
    const frame = encodeXudpDatagram({
      status: 'new',
      destination: {
        hostname: '1.1.1.1',
        port: 53,
        addressType: 1,
        addressBytes: new Uint8Array([1, 1, 1, 1]),
      },
      globalId: new Uint8Array(8),
      payload: new Uint8Array([3, 4]),
    });

    await session.push(frame.slice(0, 7));
    await session.push(frame.slice(7));

    expect(query).toHaveBeenCalledWith(new Uint8Array([3, 4]));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.slice(0, 2)).toEqual(new Uint8Array([0, 0]));
    expect(sent[0]?.slice(-2)).toEqual(new Uint8Array([7, 8]));
  });
});
