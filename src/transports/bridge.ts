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
  rawData: Uint8Array;
  respHeader: Uint8Array | null;
}

export function parseFirstPacket(data: Uint8Array, token: string): ParsedFirstPacket | null {
  const vlessResult = parseVlessRequest(data, token);
  if (vlessResult.ok) {
    return {
      protocol: 'vless',
      hostname: vlessResult.hostname,
      port: vlessResult.port,
      isUDP: vlessResult.command === 'udp',
      rawData: vlessResult.payload || new Uint8Array(0),
      respHeader: new Uint8Array([0, 0]),
    };
  }

  const trojanResult = parseTrojanRequest(data, token);
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

  return null;
}

export { isValidWSEarlyData } from './common';

export interface RemoteConnWrapper {
  socket: Socket | null;
  connectingPromise: Promise<void> | null;
  retryConnect: (() => Promise<void>) | null;
}

export function createRemoteConnWrapper(): RemoteConnWrapper {
  return { socket: null, connectingPromise: null, retryConnect: null };
}
