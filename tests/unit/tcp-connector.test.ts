import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../src/app/types';
import type { TransportBridge } from '../../src/transports/bridge';
import { createRemoteConnWrapper } from '../../src/transports/bridge';
import { createConnectTCP } from '../../src/networking/tcp-connector';
import type { SocketConnector } from '../../src/networking/sockets';

function fakeSocket(): Socket {
  const socket: Socket = {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    closed: new Promise(() => undefined),
    opened: Promise.resolve({}),
    upgraded: false,
    secureTransport: 'off',
    close: vi.fn(async () => undefined),
    startTls() {
      return socket;
    },
  };
  return socket;
}

function context(proxy: Partial<RequestContext['proxy']>): RequestContext {
  return {
    request: new Request('https://worker.example'),
    env: {},
    execution: { waitUntil() {}, passThroughOnException() {}, props: {} },
    url: new URL('https://worker.example'),
    userId: 'user-id',
    host: 'worker.example',
    clientIp: '',
    userAgent: '',
    adminPassword: '',
    encryptionKey: '',
    debug: false,
    preloadRaceDial: false,
    dialConcurrency: 1,
    proxy: {
      type: 'proxyip',
      proxyIp: 'proxy.example:443',
      global: false,
      fallback: true,
      whitelist: [],
      ...proxy,
    },
  } as unknown as RequestContext;
}

const bridge: TransportBridge = {
  readyState: WebSocket.OPEN,
  send() {},
  close() {},
};

describe('createConnectTCP routing policy', () => {
  it('uses direct connection for a non-global proxy outside the whitelist', async () => {
    const addresses: SocketAddress[] = [];
    const connector: SocketConnector = {
      connect(address) {
        addresses.push(address);
        return fakeSocket();
      },
    };
    const socks5 = vi.fn(async () => fakeSocket());
    const connectTCP = createConnectTCP(
      context({
        type: 'socks5',
        address: { hostname: 'proxy.example', port: 1080 },
      }),
      { connector, socks5Connect: socks5, connectStreams: vi.fn(async () => undefined) },
    );

    await connectTCP('target.example', 443, null, bridge, createRemoteConnWrapper());

    expect(addresses).toEqual([{ hostname: 'target.example', port: 443, index: 0 }]);
    expect(socks5).not.toHaveBeenCalled();
  });

  it('uses configured proxy immediately for a global or whitelisted target', async () => {
    const connector: SocketConnector = { connect: vi.fn(() => fakeSocket()) };
    const socks5 = vi.fn(async () => fakeSocket());
    const create = (proxy: Partial<RequestContext['proxy']>) =>
      createConnectTCP(context(proxy), {
        connector,
        socks5Connect: socks5,
        connectStreams: vi.fn(async () => undefined),
      });

    await create({
      type: 'socks5',
      global: true,
      address: { hostname: 'proxy.example', port: 1080 },
    })('first.example', 443, null, bridge, createRemoteConnWrapper());
    await create({
      type: 'socks5',
      whitelist: ['*.allowed.example'],
      address: { hostname: 'proxy.example', port: 1080 },
    })('api.allowed.example', 443, null, bridge, createRemoteConnWrapper());

    expect(socks5).toHaveBeenCalledTimes(2);
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('routes TURN and SSTP through their dedicated connectors', async () => {
    const connector: SocketConnector = { connect: vi.fn(() => fakeSocket()) };
    const turn = vi.fn(async () => fakeSocket());
    const sstp = vi.fn(async () => fakeSocket());
    const create = (type: 'turn' | 'sstp') =>
      createConnectTCP(
        context({
          type,
          global: true,
          address: { hostname: 'proxy.example', port: 443 },
        }),
        {
          connector,
          turnConnect: turn,
          sstpConnect: sstp,
          connectStreams: vi.fn(async () => undefined),
        },
      );

    await create('turn')('first.example', 443, null, bridge, createRemoteConnWrapper());
    await create('sstp')('second.example', 443, null, bridge, createRemoteConnWrapper());

    expect(turn).toHaveBeenCalledOnce();
    expect(sstp).toHaveBeenCalledOnce();
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('falls back to the configured proxy when direct dialing fails', async () => {
    const connector: SocketConnector = {
      connect() {
        const socket = fakeSocket();
        Object.defineProperty(socket, 'opened', {
          value: Promise.reject(new Error('direct failed')),
        });
        return socket;
      },
    };
    const socks5 = vi.fn(async () => fakeSocket());
    const connectTCP = createConnectTCP(
      context({
        type: 'socks5',
        address: { hostname: 'proxy.example', port: 1080 },
      }),
      { connector, socks5Connect: socks5, connectStreams: vi.fn(async () => undefined) },
    );

    await connectTCP('target.example', 443, null, bridge, createRemoteConnWrapper());

    expect(socks5).toHaveBeenCalledOnce();
  });

  it('retries a silent direct connection through resolved ProxyIP candidates', async () => {
    const addresses: SocketAddress[] = [];
    const connector: SocketConnector = {
      connect(address) {
        addresses.push(address);
        return fakeSocket();
      },
    };
    const pump = vi.fn(
      async (
        _socket: { readable: ReadableStream<Uint8Array> },
        _bridge: TransportBridge,
        _header: Uint8Array | null,
        retry?: () => Promise<void>,
      ) => {
        if (retry) await retry();
      },
    );
    const connectTCP = createConnectTCP(context({}), {
      connector,
      connectStreams: pump as never,
      resolveProxyCandidates: vi.fn(async () => [{ hostname: '198.51.100.8', port: 8443 }]),
    });

    await connectTCP(
      'target.example',
      443,
      new Uint8Array([1, 2]),
      bridge,
      createRemoteConnWrapper(),
    );
    await vi.waitFor(() => expect(addresses).toHaveLength(2));

    expect(addresses[0]).toMatchObject({ hostname: 'target.example', port: 443 });
    expect(addresses[1]).toMatchObject({ hostname: '198.51.100.8', port: 8443 });
  });

  it('uses preloaded A/AAAA candidates when race dialing is enabled', async () => {
    const addresses: SocketAddress[] = [];
    const connector: SocketConnector = {
      connect(address) {
        addresses.push(address);
        return fakeSocket();
      },
    };
    const ctx = context({});
    ctx.preloadRaceDial = true;
    ctx.dialConcurrency = 2;
    const connectTCP = createConnectTCP(ctx, {
      connector,
      resolveDns: vi.fn(async (_host, type) =>
        type === 'A'
          ? [{ type: 'A', data: '192.0.2.10', ttl: 60 }]
          : [{ type: 'AAAA', data: '2001:db8::10', ttl: 60 }],
      ),
      connectStreams: vi.fn(async () => undefined),
    });

    await connectTCP('target.example', 443, null, bridge, createRemoteConnWrapper());

    expect(addresses).toEqual([
      { hostname: '192.0.2.10', port: 443, resolvedFrom: 'target.example' },
      { hostname: '2001:db8::10', port: 443, resolvedFrom: 'target.example' },
    ]);
  });
});
