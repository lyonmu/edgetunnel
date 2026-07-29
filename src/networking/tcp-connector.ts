import type { RequestContext } from '../app/types';
import type { InboundProtocol } from '../config/schema';
import type { TransportBridge, RemoteConnWrapper } from '../transports/bridge';
import { connectStreams, closeSocketQuietly } from './stream-pump';
import {
  openSocket,
  raceSockets,
  writeInitialData,
  cloudflareSocketConnector,
  type DialCandidate,
  type SocketConnector,
} from './sockets';
import { socks5Connect, httpConnect, httpsConnect } from './proxy-connectors';
import { isIPHostname } from './proxy-connectors';
import { resolveProxyCandidates, type DnsResolver } from './proxy-ip';
import { resolveDns } from './dns';
import { turnConnect } from './turn';
import { sstpConnect } from './sstp';

export type ConnectTCPFn = (
  host: string,
  port: number,
  data: Uint8Array | null,
  bridge: TransportBridge,
  wrapper: RemoteConnWrapper,
  inbound?: InboundProtocol,
) => Promise<void>;

type StreamConnector = typeof connectStreams;

export interface ConnectTCPDependencies {
  connector?: SocketConnector;
  connectStreams?: StreamConnector;
  socks5Connect?: typeof socks5Connect;
  httpConnect?: typeof httpConnect;
  httpsConnect?: typeof httpsConnect;
  turnConnect?: typeof turnConnect;
  sstpConnect?: typeof sstpConnect;
  resolveDns?: DnsResolver;
  resolveProxyCandidates?: (
    proxyIp: string,
    targetHost: string,
    userId: string,
    resolver?: DnsResolver,
  ) => Promise<DialCandidate[]>;
}

const CONNECT_TIMEOUT_MS = 1000;

function matchesWhitelist(host: string, whitelist: readonly string[]): boolean {
  return whitelist.some((pattern) => {
    const expression = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${expression}$`, 'i').test(host);
  });
}

export function createConnectTCP(
  ctx: RequestContext,
  dependencies: ConnectTCPDependencies = {},
): ConnectTCPFn {
  const connector = dependencies.connector ?? cloudflareSocketConnector;
  const pumpStreams = dependencies.connectStreams ?? connectStreams;
  const connectSocks5 = dependencies.socks5Connect ?? socks5Connect;
  const connectHttp = dependencies.httpConnect ?? httpConnect;
  const connectHttps = dependencies.httpsConnect ?? httpsConnect;
  const connectTurn = dependencies.turnConnect ?? turnConnect;
  const connectSstp = dependencies.sstpConnect ?? sstpConnect;
  const dnsResolver = dependencies.resolveDns ?? resolveDns;
  const resolveCandidates = dependencies.resolveProxyCandidates ?? resolveProxyCandidates;
  const dialConcurrency = Math.max(1, ctx.dialConcurrency);

  async function connectCandidates(
    candidates: readonly DialCandidate[],
    data: Uint8Array | null,
  ): Promise<Socket> {
    let lastError: unknown = new Error('没有可用的拨号候选');
    for (let offset = 0; offset < candidates.length; offset += dialConcurrency) {
      const batch = candidates.slice(offset, offset + dialConcurrency);
      let socket: Socket | null = null;
      try {
        if (batch.length === 1) {
          socket = await openSocket(connector, batch[0]!, CONNECT_TIMEOUT_MS);
        } else {
          socket = (await raceSockets(connector, batch, CONNECT_TIMEOUT_MS)).socket;
        }
        if (data && data.byteLength > 0) await writeInitialData(socket, data);
        return socket;
      } catch (error) {
        lastError = error;
        if (socket) void socket.close().catch(() => undefined);
      }
    }
    throw lastError;
  }

  async function connectDirect(
    host: string,
    port: number,
    data: Uint8Array | null,
  ): Promise<Socket> {
    let candidates: DialCandidate[] = [];
    if (ctx.preloadRaceDial && !isIPHostname(host)) {
      const [ipv4Answers, ipv6Answers] = await Promise.all([
        dnsResolver(host, 'A'),
        dnsResolver(host, 'AAAA'),
      ]);
      const addresses = [
        ...ipv4Answers
          .filter((answer) => answer.type.toUpperCase() === 'A')
          .map((answer) => answer.data),
        ...ipv6Answers
          .filter((answer) => answer.type.toUpperCase() === 'AAAA')
          .map((answer) => answer.data),
      ];
      candidates = [...new Set(addresses)].slice(0, dialConcurrency).map((hostname) => ({
        hostname,
        port,
        resolvedFrom: host,
      }));
    }
    if (candidates.length === 0) {
      candidates = Array.from({ length: dialConcurrency }, (_, index) => ({
        hostname: host,
        port,
        index,
      }));
    }
    return connectCandidates(candidates, data);
  }

  async function connectViaProxy(
    host: string,
    port: number,
    data: Uint8Array | null,
  ): Promise<Socket> {
    const proxy = ctx.proxy;
    if (proxy.type === 'proxyip') {
      const candidates = await resolveCandidates(proxy.proxyIp, host, ctx.userId, dnsResolver);
      try {
        return await connectCandidates(candidates, data);
      } catch (error) {
        if (!proxy.fallback) throw error;
        return connectDirect(host, port, data);
      }
    }
    if (!proxy.address) return connectDirect(host, port, data);

    switch (proxy.type) {
      case 'socks5':
        return connectSocks5(host, port, data, proxy.address, connector);
      case 'http':
        return connectHttp(host, port, data, proxy.address, connector, false);
      case 'https':
        return connectHttps(host, port, data, proxy.address, connector);
      case 'turn': {
        const socket = await connectTurn(proxy.address, host, port, connector);
        if (data?.byteLength) await writeInitialData(socket, data);
        return socket;
      }
      case 'sstp': {
        const socket = await connectSstp(proxy.address, host, port, connector);
        if (data?.byteLength) await writeInitialData(socket, data);
        return socket;
      }
    }
  }

  return async function connectTCP(host, port, data, bridge, wrapper) {
    if (wrapper.connectingPromise) {
      await wrapper.connectingPromise;
      return;
    }

    const attachSocket = (socket: Socket, retry: (() => Promise<void>) | undefined): void => {
      wrapper.socket = socket;
      void socket.closed
        .finally(() => {
          if (wrapper.socket === socket) closeSocketQuietly(bridge);
        })
        .catch(() => undefined);
      void pumpStreams(socket, bridge, null, retry).catch((error) => {
        console.error(
          JSON.stringify({
            event: 'tcp_stream_pump_failed',
            host,
            port,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        closeSocketQuietly(bridge);
      });
    };

    const connectProxy = async (): Promise<void> => {
      const socket = await connectViaProxy(host, port, data);
      attachSocket(socket, undefined);
    };
    wrapper.retryConnect = connectProxy;

    const task = (async () => {
      const proxy = ctx.proxy;
      const proxyImmediately =
        proxy.type !== 'proxyip' &&
        Boolean(proxy.address) &&
        (proxy.global || matchesWhitelist(host, proxy.whitelist));
      if (proxyImmediately) {
        await connectProxy();
        return;
      }

      try {
        const directSocket = await connectDirect(host, port, data);
        attachSocket(directSocket, async () => {
          if (wrapper.socket !== directSocket) return;
          wrapper.socket = null;
          await connectProxy();
        });
      } catch {
        await connectProxy();
      }
    })();

    wrapper.connectingPromise = task;
    try {
      await task;
    } finally {
      if (wrapper.connectingPromise === task) wrapper.connectingPromise = null;
    }
  };
}
