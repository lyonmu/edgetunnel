const WS_EARLY_DATA_MAX_HEADER = 2048;
const WS_EARLY_DATA_MAX_BYTES = 8 * 1024;

export function decodeEarlyData(header: string, token: string | null): Uint8Array | null {
  if (!header) return null;
  if (header.length > WS_EARLY_DATA_MAX_HEADER) throw new Error('early data is too large');

  let bytes: Uint8Array | null = null;
  try {
    const U8 = Uint8Array as any;
    if (typeof U8.fromBase64 === 'function') {
      bytes = U8.fromBase64(header, { alphabet: 'base64url' });
    }
  } catch { /* ignore */ }

  if (!bytes) {
    let normalized = header.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4;
    if (padding) normalized += '='.repeat(4 - padding);
    let binaryString: string;
    try {
      binaryString = atob(normalized);
    } catch {
      return null;
    }
    bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  }

  if (bytes.byteLength > WS_EARLY_DATA_MAX_BYTES) throw new Error('early data is too large');
  return bytes;
}

export function buildGrpcFrame(payload: Uint8Array): Uint8Array {
  const lenBytes: number[] = [];
  let remaining = payload.byteLength >>> 0;
  while (remaining > 127) {
    lenBytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  lenBytes.push(remaining);
  const protobufLen = 1 + lenBytes.length + payload.byteLength;
  const frame = new Uint8Array(5 + protobufLen);
  frame[0] = 0;
  frame[1] = (protobufLen >>> 24) & 0xff;
  frame[2] = (protobufLen >>> 16) & 0xff;
  frame[3] = (protobufLen >>> 8) & 0xff;
  frame[4] = protobufLen & 0xff;
  frame[5] = 0x0a;
  frame.set(lenBytes, 6);
  frame.set(payload, 6 + lenBytes.length);
  return frame;
}

export function parseGrpcPayload(payload: Uint8Array): Uint8Array {
  if (payload.byteLength >= 2 && payload[0] === 0x0a) {
    let shift = 0;
    let offset = 1;
    let varintValid = false;
    while (offset < payload.length) {
      const current = payload[offset++];
      if ((current & 0x80) === 0) {
        varintValid = true;
        break;
      }
      shift += 7;
      if (shift > 35) break;
    }
    if (varintValid) return payload.subarray(offset);
  }
  return payload;
}

export function parseGrpcFrames(data: Uint8Array): { frames: Uint8Array[]; remainder: Uint8Array } {
  const frames: Uint8Array[] = [];
  let pending = data;

  while (pending.byteLength >= 5) {
    const grpcLen = ((pending[1] << 24) >>> 0) | (pending[2] << 16) | (pending[3] << 8) | pending[4];
    const frameSize = 5 + grpcLen;
    if (pending.byteLength < frameSize) break;
    frames.push(pending.subarray(5, frameSize));
    pending = pending.slice(frameSize);
  }

  return { frames, remainder: pending };
}

export function closeSocketQuietly(ws: WebSocket | null | undefined) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.close(); } catch { /* ignore */ }
  }
}

export function wsSendAndAwait(ws: WebSocket, data: ArrayBuffer | Uint8Array): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) throw new Error('ws.readyState is not open');
  return new Promise<void>((resolve, reject) => {
    try {
      ws.send(data);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}
