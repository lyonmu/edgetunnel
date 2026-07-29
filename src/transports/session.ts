import type { Dialer } from '../networking/dialer';
import { connectStreams } from '../networking/stream-pump';
import type { InboundProtocol } from '../config/schema';
import type { RemoteConnWrapper, TransportBridge } from './bridge';
import type { ConnectTCPFn } from '../networking/tcp-connector';

export class ConnectionScope {
  private readonly controller = new AbortController();
  private socket: Socket | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly bridge: TransportBridge,
    parentSignal?: AbortSignal,
  ) {
    if (parentSignal?.aborted) {
      void this.close(parentSignal.reason);
    } else {
      parentSignal?.addEventListener('abort', () => void this.close(parentSignal.reason), {
        once: true,
      });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  attach(socket: Socket): void {
    if (this.controller.signal.aborted) {
      void socket.close().catch(() => undefined);
      return;
    }
    this.socket = socket;
  }

  close(reason?: unknown): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.controller.abort(reason);
    this.closePromise = (async () => {
      const socket = this.socket;
      this.socket = null;
      if (socket) await socket.close().catch(() => undefined);
      this.bridge.close();
    })();
    return this.closePromise;
  }
}

export interface ConnectTunnelOptions {
  dialer: Dialer;
  inbound: InboundProtocol;
  hostname: string;
  port: number;
  initialData?: Uint8Array;
  bridge: TransportBridge;
  wrapper: RemoteConnWrapper;
  scope: ConnectionScope;
  pump?: typeof connectStreams;
}

export async function connectTunnel(options: ConnectTunnelOptions): Promise<void> {
  const {
    dialer,
    inbound,
    hostname,
    port,
    initialData,
    bridge,
    wrapper,
    scope,
    pump = connectStreams,
  } = options;
  const result = await dialer.connect(
    { hostname, port },
    inbound,
    scope.signal,
    initialData?.byteLength ? initialData : undefined,
  );
  scope.attach(result.socket);
  if (scope.signal.aborted) return;
  wrapper.socket = result.socket;
  void result.socket.closed.finally(() => scope.close('target closed')).catch(() => undefined);
  void pump(result.socket, bridge, null)
    .catch((error) => {
      console.error(
        JSON.stringify({
          event: 'tcp_stream_pump_failed',
          hostname,
          port,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    })
    .finally(() => scope.close('downlink ended'));
}

export function createTunnelConnectTCP(dialer: Dialer, parentSignal?: AbortSignal): ConnectTCPFn {
  const scopes = new WeakMap<TransportBridge, ConnectionScope>();
  return async (hostname, port, data, bridge, wrapper, inbound = 'vless') => {
    let scope = scopes.get(bridge);
    if (!scope) {
      scope = new ConnectionScope(bridge, parentSignal);
      scopes.set(bridge, scope);
    }
    wrapper.retryConnect = null;
    await connectTunnel({
      dialer,
      inbound,
      hostname,
      port,
      ...(data?.byteLength ? { initialData: data } : {}),
      bridge,
      wrapper,
      scope,
    });
  };
}
