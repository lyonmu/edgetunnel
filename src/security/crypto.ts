const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

export interface EncryptedEnvelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  nonce: string;
  ciphertext: string;
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error('无效的 base64url 字符串');
  }
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function signHmac(key: string, payload: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, toArrayBuffer(payload)));
}

async function importAesKey(encodedKey: string, usage: KeyUsage): Promise<CryptoKey> {
  const raw = decodeBase64Url(encodedKey);
  if (raw.byteLength !== 32) {
    throw new Error('CONFIG_KEY 解码后必须正好是 32 字节');
  }
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), 'AES-GCM', false, [usage]);
}

export async function encryptJson(
  encodedKey: string,
  aad: string,
  value: unknown,
): Promise<EncryptedEnvelope> {
  const key = await importAesKey(encodedKey, 'encrypt');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: encoder.encode(aad),
      tagLength: 128,
    },
    key,
    plaintext,
  );
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptJson<T>(
  encodedKey: string,
  aad: string,
  envelope: EncryptedEnvelope,
): Promise<T> {
  if (envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM') {
    throw new Error('不支持的加密 envelope');
  }
  const nonce = decodeBase64Url(envelope.nonce);
  if (nonce.byteLength !== 12) {
    throw new Error('AES-GCM nonce 必须是 12 字节');
  }
  const key = await importAesKey(encodedKey, 'decrypt');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: encoder.encode(aad),
      tagLength: 128,
    },
    key,
    toArrayBuffer(decodeBase64Url(envelope.ciphertext)),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}
