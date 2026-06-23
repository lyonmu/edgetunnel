import type { RequestContext } from '../app/types';
import type { TransportBridge, RemoteConnWrapper } from '../transports/bridge';
import { connectStreams, closeSocketQuietly } from './stream-pump';
import { openSocket, raceSockets, writeInitialData, cloudflareSocketConnector, type DialCandidate } from './sockets';
import { socks5Connect, httpConnect, httpsConnect } from './proxy-connectors';

export type ConnectTCPFn = (
  host: string,
  port: number,
  data: Uint8Array | null,
  bridge: TransportBridge,
  wrapper: RemoteConnWrapper,
) => Promise<void>;

const CONNECT_TIMEOUT_MS = 1000;

export function createConnectTCP(ctx: RequestContext): ConnectTCPFn {
  const connector = cloudflareSocketConnector;
  const dialConcurrency = ctx.dialConcurrency;
  let sentViaProxy = false;

  async function connectDirect(
    host: string,
    port: number,
    data: Uint8Array | null,
  ): Promise<Socket> {
    const candidates: DialCandidate[] = Array.from(
      { length: dialConcurrency },
      (_, i) => ({ hostname: host, port, index: i }),
    );
    let socket: Socket;
    if (candidates.length === 1) {
      socket = await openSocket(connector, candidates[0]!, CONNECT_TIMEOUT_MS);
    } else {
      const result = await raceSockets(connector, candidates, CONNECT_TIMEOUT_MS);
      socket = result.socket;
    }
    if (data && data.byteLength > 0) {
      await writeInitialData(socket, data);
    }
    return socket;
  }

  async function connectViaProxy(
    host: string,
    port: number,
    data: Uint8Array | null,
  ): Promise<Socket> {
    const proxy = ctx.proxy;
    if (!proxy.address) {
      return connectDirect(host, port, data);
    }

    const proxyAddr = proxy.address;

    switch (proxy.type) {
      case 'socks5':
        return socks5Connect(host, port, data, proxyAddr, connector);
      case 'http':
        return httpConnect(host, port, data, proxyAddr, connector, false);
      case 'https':
        return httpsConnect(host, port, data, proxyAddr, connector);
      case 'proxyip':
      default:
        return connectDirect(host, port, data);
    }
  }

  return async function connectTCP(host, port, data, bridge, wrapper) {
    if (wrapper.connectingPromise) {
      await wrapper.connectingPromise;
      return;
    }

    const shouldSendData = !sentViaProxy && data && data.byteLength > 0;
    const packetData = shouldSendData ? data : null;

    const task = (async () => {
      let socket: Socket;
      const proxy = ctx.proxy;
      if (proxy.type !== 'proxyip' && proxy.address) {
        socket = await connectViaProxy(host, port, packetData);
      } else {
        socket = await connectDirect(host, port, packetData);
      }

      if (shouldSendData) sentViaProxy = true;
      wrapper.socket = socket;
      socket.closed.catch(() => {}).finally(() => closeSocketQuietly(bridge as any));
      connectStreams(socket, bridge, null, undefined);
    })();

    wrapper.connectingPromise = task;
    try {
      await task;
    } finally {
      if (wrapper.connectingPromise === task) {
        wrapper.connectingPromise = null;
      }
    }

    wrapper.retryConnect = async () => {
      sentViaProxy = false;
      const retryTask = (async () => {
        let socket: Socket;
        const proxy = ctx.proxy;
        if (proxy.type !== 'proxyip' && proxy.address) {
          socket = await connectViaProxy(host, port, data);
        } else {
          socket = await connectDirect(host, port, data);
        }
        if (data && data.byteLength > 0) sentViaProxy = true;
        wrapper.socket = socket;
        socket.closed.catch(() => {}).finally(() => closeSocketQuietly(bridge as any));
        connectStreams(socket, bridge, null, undefined);
      })();
      wrapper.connectingPromise = retryTask;
      try {
        await retryTask;
      } finally {
        if (wrapper.connectingPromise === retryTask) {
          wrapper.connectingPromise = null;
        }
      }
    };
  };
}
