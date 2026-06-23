export interface SSAEADCipher {
  method: string;
  keyLen: number;
  saltLen: number;
  maxChunk: number;
  aesLength: number;
}

export const SS_SUPPORTED_CIPHERS: Record<string, SSAEADCipher> = {
  'aes-128-gcm': { method: 'aes-128-gcm', keyLen: 16, saltLen: 16, maxChunk: 0x3fff, aesLength: 128 },
  'aes-256-gcm': { method: 'aes-256-gcm', keyLen: 32, saltLen: 32, maxChunk: 0x3fff, aesLength: 256 },
};

export const SS_AEAD_TAG_LENGTH = 16;
export const SS_NONCE_LENGTH = 12;

export function ssDeriveKey(password: string, keyLen: number): Uint8Array {
  const key = new Uint8Array(keyLen);
  let i = 0;
  let hash: Uint8Array | null = null;

  while (i < keyLen) {
    const data = hash
      ? concatBuffers(hash, new TextEncoder().encode(password))
      : new TextEncoder().encode(password);

    hash = md5(data);
    const copyLen = Math.min(hash.length, keyLen - i);
    key.set(hash.subarray(0, copyLen), i);
    i += copyLen;
  }

  return key;
}

function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function md5(data: Uint8Array): Uint8Array {
  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const msgLen = data.length;
  const msg = new Uint8Array(msgLen + 1);
  msg.set(data);
  msg[msgLen] = 0x80;

  const paddedLen = ((msg.length + 8) % 64 === 0) ? msg.length + 8 : msg.length + 8 + (64 - ((msg.length + 8) % 64));
  const padded = new Uint8Array(paddedLen);
  padded.set(msg);

  const bitLen = msgLen * 8;
  padded[paddedLen - 8] = bitLen & 0xff;
  padded[paddedLen - 7] = (bitLen >>> 8) & 0xff;
  padded[paddedLen - 6] = (bitLen >>> 16) & 0xff;
  padded[paddedLen - 5] = (bitLen >>> 24) & 0xff;

  for (let i = 0; i < paddedLen; i += 64) {
    const M = new Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = padded[i + j * 4] | (padded[i + j * 4 + 1] << 8) | (padded[i + j * 4 + 2] << 16) | (padded[i + j * 4 + 3] << 24);
    }

    let A = a0, B = b0, C = c0, D = d0;
    for (let j = 0; j < 64; j++) {
      let F: number, g: number;
      if (j < 16) { F = (B & C) | (~B & D); g = j; }
      else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * j) % 16; }

      const temp = D;
      D = C;
      C = B;
      B = B + (((A + F + K[j] + M[g]) << S[j]) | ((A + F + K[j] + M[g]) >>> (32 - S[j])));
      A = temp;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const result = new Uint8Array(16);
  result[0] = a0 & 0xff; result[1] = (a0 >>> 8) & 0xff; result[2] = (a0 >>> 16) & 0xff; result[3] = (a0 >>> 24) & 0xff;
  result[4] = b0 & 0xff; result[5] = (b0 >>> 8) & 0xff; result[6] = (b0 >>> 16) & 0xff; result[7] = (b0 >>> 24) & 0xff;
  result[8] = c0 & 0xff; result[9] = (c0 >>> 8) & 0xff; result[10] = (c0 >>> 16) & 0xff; result[11] = (c0 >>> 24) & 0xff;
  result[12] = d0 & 0xff; result[13] = (d0 >>> 8) & 0xff; result[14] = (d0 >>> 16) & 0xff; result[15] = (d0 >>> 24) & 0xff;
  return result;
}

export async function ssAEADEncrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    key,
    plaintext,
  );
  return new Uint8Array(encrypted);
}

export async function ssAEADDecrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    key,
    ciphertext,
  );
  return new Uint8Array(decrypted);
}

export function incrementNonce(nonce: Uint8Array): void {
  for (let i = 0; i < nonce.length; i++) {
    nonce[i]++;
    if (nonce[i] !== 0) break;
  }
}
