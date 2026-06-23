import { createUploadQueue } from '../networking/upload-queue';
import { connectStreams, closeSocketQuietly } from '../networking/stream-pump';
import { decodeEarlyData } from './common';
import { parseVlessRequest } from '../protocols/vless';
import { parseTrojanRequest } from '../protocols/trojan';
import type { RequestContext } from '../app/types';

export interface TransportBridge {
  readyState: number;
  send(data: Uint8Array | ArrayBuffer): void;
  close(): void;
}

export function createWebSocketBridge(ws: WebSocket): TransportBridge {
  return {
    get readyState() { return ws.readyState; },
    send(data) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch { /* ignore */ }
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
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
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
      try { controller.close(); } catch { /* ignore */ }
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
  if (vlessResult && !vlessResult.hasError) {
    return {
      protocol: 'vless',
      hostname: vlessResult.hostname,
      port: vlessResult.port,
      isUDP: vlessResult.isUDP,
      rawData: vlessResult.rawClientData || new Uint8Array(0),
      respHeader: new Uint8Array([vlessResult.version, 0]),
    };
  }

  const trojanResult = parseTrojanRequest(data, token);
  if (trojanResult && !trojanResult.hasError) {
    return {
      protocol: 'trojan',
      hostname: trojanResult.hostname,
      port: trojanResult.port,
      isUDP: trojanResult.isUDP,
      rawData: trojanResult.rawClientData || new Uint8Array(0),
      respHeader: null,
    };
  }

  return null;
}

export function isValidWSEarlyData(bytes: Uint8Array, token: string): boolean {
  if (!bytes?.byteLength) return false;
  if (bytes.byteLength >= 18) {
    try {
      const { matchesUuid } = require('../shared/bytes');
      if (matchesUuid(bytes, 1, token)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export interface RemoteConnWrapper {
  socket: Socket | null;
  connectingPromise: Promise<void> | null;
  retryConnect: (() => Promise<void>) | null;
}

export function createRemoteConnWrapper(): RemoteConnWrapper {
  return { socket: null, connectingPromise: null, retryConnect: null };
}
