import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { DataPlaneContext } from '../../src/app/types';
import { createDefaultConfig } from '../../src/config/defaults';
import { createShadowsocksEncryptor } from '../../src/protocols/shadowsocks';
import { handleWebSocket } from '../../src/transports/websocket';
import { createDnsUdpSession } from '../../src/networking/udp-dns';

const uuid = '12345678-1234-4234-8234-123456789abc';

function context(url: string): DataPlaneContext {
  const config = createDefaultConfig();
  config.inbound.trojan.enabled = true;
  config.inbound.shadowsocks.enabled = true;
  return {
    request: new Request(url),
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
    url: new URL(url),
    userId: uuid,
    clientIp: '127.0.0.1',
    userAgent: 'vitest',
    requestId: crypto.randomUUID(),
    runtimeSnapshot: {
      config,
      secrets: {
        admin: 'admin',
        configKey: 'key',
        trojanPassword: uuid,
        shadowsocksPassword: uuid,
      },
      identity: { vlessUuid: uuid },
      requestId: crypto.randomUUID(),
    },
  };
}

function connectedSocket(): Socket {
  return {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    opened: Promise.resolve({ remoteAddress: null, localAddress: null }),
    closed: new Promise<void>(() => {}),
    close: vi.fn(),
    startTls: vi.fn(),
  } as unknown as Socket;
}

function vlessUdpPacket(): Uint8Array {
  const clean = uuid.replaceAll('-', '');
  const uuidBytes = Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16),
  );
  return new Uint8Array([0, ...uuidBytes, 0, 2, 0, 53, 1, 8, 8, 8, 8, 0, 2, 1, 2]);
}

describe('WebSocket transport', () => {
  it('accumulates a fragmented Trojan first packet before connecting', async () => {
    const hash = new TextEncoder().encode(
      '23b527d0e092cc9c57db3caf6b67ff9cf0f2391c16fe423c83456659',
    );
    const host = new TextEncoder().encode('example.com');
    const packet = new Uint8Array([
      ...hash,
      0x0d,
      0x0a,
      0x01,
      0x03,
      host.length,
      ...host,
      0x00,
      0x50,
      0x0d,
      0x0a,
      0xaa,
    ]);
    const connectTCP = vi.fn(async (_host, _port, _data, _bridge, wrapper) => {
      wrapper.socket = connectedSocket();
    });
    const request = new Request('https://example.com/trojan', {
      headers: { Upgrade: 'websocket' },
    });
    const response = handleWebSocket(request, context(request.url), connectTCP);
    const client = response.webSocket!;
    client.accept();

    client.send(packet.subarray(0, 31));
    client.send(packet.subarray(31));

    await vi.waitFor(() => expect(connectTCP).toHaveBeenCalledOnce());
    expect(connectTCP).toHaveBeenCalledWith(
      'example.com',
      80,
      new Uint8Array([0xaa]),
      expect.anything(),
      expect.anything(),
      'trojan',
    );
    client.close();
  });

  it('decrypts Shadowsocks WebSocket input selected by enc', async () => {
    const host = new TextEncoder().encode('example.com');
    const plaintext = new Uint8Array([0x03, host.length, ...host, 0x01, 0xbb, 1, 2]);
    const encryptor = await createShadowsocksEncryptor(uuid, 'aes-128-gcm');
    const firstEncrypted = await encryptor.encrypt(plaintext.slice(0, 5));
    const secondEncrypted = await encryptor.encrypt(plaintext.slice(5));
    const connectTCP = vi.fn(async (_host, _port, _data, _bridge, wrapper) => {
      wrapper.socket = connectedSocket();
    });
    const request = new Request('https://example.com/ss?enc=aes-128-gcm', {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': 'binary',
      },
    });
    const response = handleWebSocket(request, context(request.url), connectTCP);
    const client = response.webSocket!;
    client.accept();

    client.send(firstEncrypted);
    client.send(secondEncrypted);

    await vi.waitFor(() => expect(connectTCP).toHaveBeenCalledOnce());
    expect(connectTCP).toHaveBeenCalledWith(
      'example.com',
      443,
      new Uint8Array([1, 2]),
      expect.anything(),
      expect.anything(),
      'shadowsocks',
    );
    client.close();
  });

  it('forwards VLESS UDP DNS without opening a TCP target connection', async () => {
    const connectTCP = vi.fn();
    const request = new Request('https://example.com/dns', {
      headers: { Upgrade: 'websocket' },
    });
    const response = handleWebSocket(
      request,
      context(request.url),
      connectTCP,
      (protocol, bridge, header) =>
        createDnsUdpSession(protocol, bridge, header, async () => new Uint8Array([9])),
    );
    const client = response.webSocket!;
    client.binaryType = 'arraybuffer';
    client.accept();
    const message = new Promise<Uint8Array>((resolve) => {
      client.addEventListener('message', (event) => {
        resolve(new Uint8Array(event.data as ArrayBuffer));
      });
    });

    client.send(vlessUdpPacket());

    await expect(message).resolves.toEqual(new Uint8Array([0, 0, 0, 1, 9]));
    expect(connectTCP).not.toHaveBeenCalled();
    client.close();
  });
});
