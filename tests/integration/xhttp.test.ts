import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../src/app/types';
import { handleXHTTP } from '../../src/transports/xhttp';
import { createDnsUdpSession } from '../../src/networking/udp-dns';

const uuid = '12345678-1234-4234-8234-123456789abc';

function context(request: Request): RequestContext {
  return {
    request,
    env: { KV: env.KV, ASSETS: env.ASSETS, ADMIN: 'admin', UUID: uuid },
    execution: createExecutionContext(),
    url: new URL(request.url),
    userId: uuid,
    host: 'example.com',
    clientIp: '127.0.0.1',
    userAgent: 'vitest',
    adminPassword: 'admin',
    encryptionKey: 'key',
    debug: false,
    preloadRaceDial: false,
    dialConcurrency: 1,
    proxy: {
      type: 'proxyip',
      proxyIp: 'proxy.example.com',
      global: false,
      fallback: true,
      whitelist: [],
    },
  };
}

function vlessPacket(): Uint8Array {
  const clean = uuid.replaceAll('-', '');
  const uuidBytes = Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16),
  );
  const host = new TextEncoder().encode('example.com');
  return new Uint8Array([0, ...uuidBytes, 0, 1, 0, 80, 2, host.length, ...host, 0xaa]);
}

function vlessUdpPacket(): Uint8Array {
  const packet = vlessPacket();
  packet[18] = 2;
  packet[19] = 0;
  packet[20] = 53;
  return new Uint8Array([...packet.slice(0, -1), 0, 2, 1, 2]);
}

describe('XHTTP transport', () => {
  it('accumulates a first packet split across request-body chunks', async () => {
    const packet = vlessPacket();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(packet.subarray(0, 12));
        controller.enqueue(packet.subarray(12, 24));
        controller.enqueue(packet.subarray(24));
        controller.close();
      },
    });
    const request = new Request('https://example.com/xhttp', { method: 'POST', body });
    const connectTCP = vi.fn(async (_host, _port, _data, _bridge, wrapper) => {
      wrapper.socket = {
        readable: new ReadableStream(),
        writable: new WritableStream(),
        opened: Promise.resolve({ remoteAddress: null, localAddress: null }),
        closed: new Promise<void>(() => {}),
        close: vi.fn(),
        startTls: vi.fn(),
      } as unknown as Socket;
    });

    const response = handleXHTTP(request, context(request), connectTCP);

    await vi.waitFor(() => expect(connectTCP).toHaveBeenCalledOnce());
    expect(connectTCP).toHaveBeenCalledWith(
      'example.com',
      80,
      new Uint8Array([0xaa]),
      expect.anything(),
      expect.anything(),
      'vless',
    );
    await response.body?.cancel();
  });

  it('streams VLESS UDP DNS responses through XHTTP', async () => {
    const request = new Request('https://example.com/xhttp', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(vlessUdpPacket());
          controller.close();
        },
      }),
    });
    const connectTCP = vi.fn();
    const response = handleXHTTP(
      request,
      context(request),
      connectTCP,
      (protocol, bridge, header) =>
        createDnsUdpSession(protocol, bridge, header, async () => new Uint8Array([9])),
    );

    await expect(response.arrayBuffer()).resolves.toEqual(new Uint8Array([0, 0, 0, 1, 9]).buffer);
    expect(connectTCP).not.toHaveBeenCalled();
  });
});
