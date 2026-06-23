export function toUint8Array(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function toOwnedUint8Array(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

export function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

const uuidByteCache = new Map<string, Uint8Array>();

export function decodeUuid(uuid: string): Uint8Array | null {
  const key = String(uuid || '');
  const cached = uuidByteCache.get(key);
  if (cached) return cached;

  const clean = key.replace(/-/g, '');
  if (clean.length !== 32) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const high = readHexNibble(clean.charCodeAt(i * 2));
    const low = readHexNibble(clean.charCodeAt(i * 2 + 1));
    if (high < 0 || low < 0) return null;
    bytes[i] = (high << 4) | low;
  }

  if (uuidByteCache.size >= 32) uuidByteCache.clear();
  uuidByteCache.set(key, bytes);
  return bytes;
}

export function matchesUuid(data: Uint8Array, offset: number, uuid: string): boolean {
  const expected = decodeUuid(uuid);
  if (!expected || data.byteLength < offset + 16) return false;
  for (let i = 0; i < 16; i++) {
    if (data[offset + i] !== expected[i]) return false;
  }
  return true;
}

function readHexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  code |= 32;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}
