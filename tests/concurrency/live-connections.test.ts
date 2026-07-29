import { describe, expect, it, vi } from 'vitest';
import type { ProxyAddress, RequestContext } from '../../src/app/types';
import type { TransportBridge } from '../../src/transports/bridge';
import { createRemoteConnWrapper } from '../../src/transports/bridge';
import { createConnectTCP } from '../../src/networking/tcp-connector';
import type { SocketConnector } from '../../src/networking/sockets';

function fakeSocket(): Socket {
  const socket = {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    opened: Promise.resolve({}),
    closed: new Promise<void>(() => undefined),
    upgraded: false,
    secureTransport: 'off',
    close: vi.fn(async () => undefined),
    startTls() {
      return socket;
    },
  };
  return socket as Socket;
}

function context(proxy: RequestContext['proxy'], dialConcurrency: number): RequestContext {
  return {
    request: new Request('https://worker.example'),
    env: {},
    execution: {},
    url: new URL('https://worker.example'),
    userId: 'user-id',
    host: 'worker.example',
    clientIp: '',
    userAgent: '',
    adminPassword: 'admin',
    encryptionKey: 'key',
    debug: false,
    preloadRaceDial: false,
    dialConcurrency,
    proxy,
  } as unknown as RequestContext;
}

const bridge: TransportBridge = {
  readyState: WebSocket.OPEN,
  send() {},
  close() {},
};

describe('live connection request isolation', () => {
  it('keeps connection A proxy settings after connection B is created', async () => {
    const connector: SocketConnector = { connect: vi.fn(() => fakeSocket()) };
    const proxyAddresses: ProxyAddress[] = [];
    const socks5 = vi.fn(
      async (_host: string, _port: number, _data: Uint8Array | null, address: ProxyAddress) => {
        proxyAddresses.push(address);
        return fakeSocket();
      },
    );
    const pump = vi.fn(async () => undefined);
    const connectionA = createConnectTCP(
      context(
        {
          type: 'socks5',
          address: { hostname: 'proxy-a.example', port: 1080 },
          proxyIp: '',
          global: true,
          fallback: false,
          whitelist: [],
        },
        1,
      ),
      { connector, socks5Connect: socks5, connectStreams: pump },
    );
    const connectionB = createConnectTCP(
      context(
        {
          type: 'proxyip',
          proxyIp: 'proxy-b.example',
          global: false,
          fallback: true,
          whitelist: [],
        },
        2,
      ),
      { connector, connectStreams: pump },
    );
    const wrapperA = createRemoteConnWrapper();

    await connectionA('target-a.example', 443, null, bridge, wrapperA);
    await connectionB('target-b.example', 443, null, bridge, createRemoteConnWrapper());
    await wrapperA.retryConnect!();

    expect(socks5).toHaveBeenCalledTimes(2);
    expect(proxyAddresses).toEqual([
      expect.objectContaining({ hostname: 'proxy-a.example' }),
      expect.objectContaining({ hostname: 'proxy-a.example' }),
    ]);
  });
});
