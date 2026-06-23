import { createUploadQueue } from '../networking/upload-queue';
import { closeSocketQuietly } from '../networking/stream-pump';
import { decodeEarlyData } from './common';
import {
  createWebSocketBridge,
  createRemoteConnWrapper,
  parseFirstPacket,
  type TransportBridge,
  type RemoteConnWrapper,
} from './bridge';
import type { RequestContext } from '../app/types';

interface HalfOpenWebSocket extends WebSocket {
  accept(options?: { allowHalfOpen?: boolean }): void;
}

export function handleWebSocket(
  request: Request,
  ctx: RequestContext,
  connectTCP: (
    host: string,
    port: number,
    data: Uint8Array | null,
    bridge: TransportBridge,
    wrapper: RemoteConnWrapper,
  ) => Promise<void>,
): Response {
  const pair = new WebSocketPair();
  const [clientSock, serverSock] = Object.values(pair) as [WebSocket, WebSocket];

  try {
    (serverSock as HalfOpenWebSocket).accept({ allowHalfOpen: true });
  } catch {
    serverSock.accept();
  }
  serverSock.binaryType = 'arraybuffer';

  const wrapper = createRemoteConnWrapper();
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  let uploadQueue: ReturnType<typeof createUploadQueue> | null = null;

  const getRemoteWriter = () => {
    const socket = wrapper.socket;
    if (!socket) return null;
    return socket.writable.getWriter();
  };

  uploadQueue = createUploadQueue({
    getWriter: getRemoteWriter,
    releaseWriter: () => {},
    retryConnect: async () => {
      if (typeof wrapper.retryConnect !== 'function') throw new Error('retry unavailable');
      await wrapper.retryConnect();
    },
    closeConnection: () => {
      try {
        void wrapper.socket?.close();
      } catch {
        /* ignore */
      }
      closeSocketQuietly(serverSock);
    },
    name: 'WS上行',
  });

  const bridge = createWebSocketBridge(serverSock);

  serverSock.addEventListener('message', async (event) => {
    try {
      const data =
        event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(event.data);
      if (!data.byteLength) return;

      if (!wrapper.socket) {
        const earlyBytes = decodeEarlyData(earlyDataHeader, ctx.userId);
        const firstPacketData = earlyBytes ? concatBytes(earlyBytes, data) : data;
        const firstPacket = parseFirstPacket(firstPacketData, ctx.userId);
        if (!firstPacket) {
          closeSocketQuietly(serverSock);
          return;
        }
        await connectTCP(
          firstPacket.hostname,
          firstPacket.port,
          firstPacket.rawData,
          bridge,
          wrapper,
        );
        if (firstPacket.respHeader) {
          bridge.send(firstPacket.respHeader);
        }
        return;
      }

      if (!uploadQueue.enqueue(data)) {
        throw new Error('Remote socket is not ready');
      }
    } catch {
      closeSocketQuietly(serverSock);
    }
  });

  serverSock.addEventListener('close', () => {
    uploadQueue?.clear();
    try {
      void wrapper.socket?.close();
    } catch {
      /* ignore */
    }
  });

  serverSock.addEventListener('error', () => {
    uploadQueue?.clear();
    try {
      void wrapper.socket?.close();
    } catch {
      /* ignore */
    }
  });

  const earlyBytes = decodeEarlyData(earlyDataHeader, ctx.userId);
  if (earlyBytes && earlyBytes.byteLength > 0) {
    const firstPacket = parseFirstPacket(earlyBytes, ctx.userId);
    if (firstPacket) {
      void (async () => {
        try {
          await connectTCP(
            firstPacket.hostname,
            firstPacket.port,
            firstPacket.rawData,
            bridge,
            wrapper,
          );
          if (firstPacket.respHeader) bridge.send(firstPacket.respHeader);
        } catch {
          closeSocketQuietly(serverSock);
        }
      })();
    }
  }

  return new Response(null, {
    status: 101,
    webSocket: clientSock,
  });
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
