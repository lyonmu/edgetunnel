import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DataPlaneContext } from '../../src/app/types';
import { createDefaultConfig } from '../../src/config/defaults';
import { buildGrpcFrame, parseGrpcFrames, parseGrpcPayload } from '../../src/transports/common';
import { createGrpcBridge, handleGRPC } from '../../src/transports/grpc';
import { createDnsUdpSession } from '../../src/networking/udp-dns';

const uuid = '12345678-1234-4234-8234-123456789abc';

function context(request: Request): DataPlaneContext {
  return {
    request,
    env: {
      KV: env.KV,
      ASSETS: env.ASSETS,
      ADMIN: 'admin',
      UUID: uuid,
      CONFIG_KEY: 'key',
      TROJAN_PASSWORD: 'trojan',
      SHADOWSOCKS_PASSWORD: 'shadowsocks',
    },
    execution: createExecutionContext(),
    url: new URL(request.url),
    userId: uuid,
    clientIp: '127.0.0.1',
    userAgent: 'vitest',
    requestId: crypto.randomUUID(),
    runtimeSnapshot: {
      config: createDefaultConfig(),
      secrets: { admin: 'admin', configKey: 'key' },
      identity: { vlessUuid: uuid },
      requestId: crypto.randomUUID(),
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

describe('gRPC transport', () => {
  it('flushes a small downlink frame without waiting for another upload chunk', async () => {
    vi.useFakeTimers();
    const controller = {
      enqueue: vi.fn(),
      close: vi.fn(),
    } as unknown as ReadableStreamDefaultController;
    const bridge = createGrpcBridge(controller);

    bridge.send(new Uint8Array([1, 2, 3]));
    expect(controller.enqueue).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(controller.enqueue).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('accumulates a first packet split across gRPC messages', async () => {
    const packet = vlessPacket();
    const first = buildGrpcFrame(packet.subarray(0, 16));
    const second = buildGrpcFrame(packet.subarray(16));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });
    const request = new Request('https://example.com/grpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body,
    });
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

    const response = handleGRPC(request, context(request), connectTCP);
    await response.arrayBuffer();

    expect(connectTCP).toHaveBeenCalledOnce();
    expect(connectTCP).toHaveBeenCalledWith(
      'example.com',
      80,
      new Uint8Array([0xaa]),
      expect.anything(),
      expect.anything(),
      'vless',
    );
  });

  it('frames VLESS UDP DNS responses as gRPC messages', async () => {
    const request = new Request('https://example.com/grpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(buildGrpcFrame(vlessUdpPacket()));
          controller.close();
        },
      }),
    });
    const connectTCP = vi.fn();
    const response = handleGRPC(request, context(request), connectTCP, (protocol, bridge, header) =>
      createDnsUdpSession(protocol, bridge, header, async () => new Uint8Array([9])),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(parseGrpcFrames(bytes).frames.map(parseGrpcPayload)).toEqual([
      new Uint8Array([0, 0, 0, 1, 9]),
    ]);
    expect(connectTCP).not.toHaveBeenCalled();
  });
});
