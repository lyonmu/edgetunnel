import { concatBytes } from '../shared/bytes';
import { closeSocketQuietly } from '../networking/stream-pump';
import { parseVlessRequest } from '../protocols/vless';
import { parseTrojanRequest } from '../protocols/trojan';

export interface TransportBridge {
  readyState: number;
  send(data: Uint8Array | ArrayBuffer): void;
  close(): void;
}

export function createWebSocketBridge(ws: WebSocket): TransportBridge {
  return {
    get readyState() {
      return ws.readyState;
    },
    send(data) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          /* ignore */
        }
      }
    },
    close() {
      closeSocketQuietly(ws);
    },
  };
}

export function createResponseBridge(controller: ReadableStreamDefaultController): TransportBridge {
  let closed = false;
  return {
    readyState: WebSocket.OPEN,
    send(data) {
      if (closed) return;
      try {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        controller.enqueue(chunk);
      } catch {
        closed = true;
        this.readyState = WebSocket.CLOSED;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      this.readyState = WebSocket.CLOSED;
      try {
        controller.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export interface ParsedFirstPacket {
  protocol: 'vless' | 'trojan';
  hostname: string;
  port: number;
  isUDP: boolean;
  udpMode?: 'xudp';
  rawData: Uint8Array;
  respHeader: Uint8Array | null;
}

function parseFirstPacketInternal(
  data: Uint8Array,
  vlessToken: string,
  trojanToken: string,
  logRejection: boolean,
): ParsedFirstPacket | null {
  const vlessResult = parseVlessRequest(data, vlessToken);
  if (vlessResult.ok) {
    const packet: ParsedFirstPacket = {
      protocol: 'vless',
      hostname: vlessResult.hostname,
      port: vlessResult.port,
      isUDP: vlessResult.command !== 'tcp',
      rawData: vlessResult.payload || new Uint8Array(0),
      respHeader: new Uint8Array([0, 0]),
    };
    if (vlessResult.command === 'xudp') packet.udpMode = 'xudp';
    return packet;
  }

  const trojanResult = parseTrojanRequest(data, trojanToken);
  if (trojanResult.ok) {
    return {
      protocol: 'trojan',
      hostname: trojanResult.hostname,
      port: trojanResult.port,
      isUDP: trojanResult.command === 'udp',
      rawData: trojanResult.payload || new Uint8Array(0),
      respHeader: null,
    };
  }

  if (logRejection) {
    console.error(
      JSON.stringify({
        event: 'first_packet_rejected',
        byteLength: data.byteLength,
        vlessError: vlessResult.error,
        trojanError: trojanResult.error,
      }),
    );
  }
  return null;
}

export function parseFirstPacket(
  data: Uint8Array,
  vlessToken: string,
  trojanToken = vlessToken,
): ParsedFirstPacket | null {
  return parseFirstPacketInternal(data, vlessToken, trojanToken, true);
}

export { isValidWSEarlyData } from './common';

export type FirstPacketReadResult =
  | { status: 'need_more' }
  | { status: 'invalid' }
  | { status: 'ok'; packet: ParsedFirstPacket };

export function createFirstPacketReader(
  vlessToken: string,
  trojanToken = vlessToken,
  maxBytes = 64 * 1024,
) {
  let pending = new Uint8Array(0);

  return {
    push(chunk: Uint8Array): FirstPacketReadResult {
      pending = new Uint8Array(concatBytes(pending, chunk));
      if (pending.byteLength > maxBytes) return { status: 'invalid' };

      const packet = parseFirstPacketInternal(pending, vlessToken, trojanToken, false);
      if (packet) return { status: 'ok', packet };

      const vless = parseVlessRequest(pending, vlessToken);
      const trojan = parseTrojanRequest(pending, trojanToken);
      const vlessNeedsMore =
        pending.byteLength < 18 ||
        (!vless.ok && vless.error !== 'Invalid uuid' && /data|length/i.test(vless.error));
      const trojanNeedsMore =
        pending.byteLength < 58 || (!trojan.ok && trojan.error === 'invalid S5 request data');

      if (vlessNeedsMore || trojanNeedsMore) return { status: 'need_more' };
      parseFirstPacketInternal(pending, vlessToken, trojanToken, true);
      return { status: 'invalid' };
    },
  };
}

export interface RemoteConnWrapper {
  socket: Socket | null;
  connectingPromise: Promise<void> | null;
  retryConnect: (() => Promise<void>) | null;
}

export function createRemoteConnWrapper(): RemoteConnWrapper {
  return { socket: null, connectingPromise: null, retryConnect: null };
}

export function createRemoteWriterProvider(wrapper: RemoteConnWrapper) {
  let currentSocket: Socket | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  const releaseWriter = () => {
    if (writer) {
      try {
        writer.releaseLock();
      } catch {
        /* ignore */
      }
    }
    writer = null;
    currentSocket = null;
  };

  const getWriter = () => {
    const socket = wrapper.socket;
    if (!socket) return null;
    if (socket !== currentSocket) {
      releaseWriter();
      currentSocket = socket;
      writer = socket.writable.getWriter();
    }
    return writer;
  };

  return { getWriter, releaseWriter };
}
