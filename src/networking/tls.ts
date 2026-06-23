import { toOwnedUint8Array } from '../shared/bytes';

export function readUint16(buffer: Uint8Array, offset: number): number {
  return (buffer[offset]! << 8) | buffer[offset + 1]!;
}

export function readUint24(buffer: Uint8Array, offset: number): number {
  return (buffer[offset]! << 16) | (buffer[offset + 1]! << 8) | buffer[offset + 2]!;
}

export class TlsRecordParser {
  private buffer: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array): void {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.buffer = this.buffer.length ? concatBytes(this.buffer, bytes) : bytes;
  }

  next(): { type: number; version: number; length: number; fragment: Uint8Array } | null {
    if (this.buffer.length < 5) return null;
    const contentType = this.buffer[0]!;
    const version = readUint16(this.buffer, 1);
    const length = readUint16(this.buffer, 3);
    if (this.buffer.length < 5 + length) return null;
    const fragment = this.buffer.subarray(5, 5 + length);
    this.buffer = this.buffer.subarray(5 + length);
    return { type: contentType, version, length, fragment };
  }
}

export class TlsHandshakeParser {
  private buffer: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array): void {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.buffer = this.buffer.length ? concatBytes(this.buffer, bytes) : bytes;
  }

  next(): { type: number; length: number; body: Uint8Array; raw: Uint8Array } | null {
    if (this.buffer.length < 4) return null;
    const handshakeType = this.buffer[0]!;
    const length = readUint24(this.buffer, 1);
    if (this.buffer.length < 4 + length) return null;
    const body = this.buffer.subarray(4, 4 + length);
    const raw = this.buffer.subarray(0, 4 + length);
    this.buffer = this.buffer.subarray(4 + length);
    return { type: handshakeType, length, body, raw };
  }
}

export function concatBytes(...chunks: (Uint8Array | null | undefined)[]): Uint8Array {
  const nonEmpty = chunks.filter((c): c is Uint8Array => !!c && c.length > 0);
  if (nonEmpty.length === 0) return new Uint8Array(0);
  if (nonEmpty.length === 1) return nonEmpty[0]!;
  const length = nonEmpty.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of nonEmpty) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

export function hashByteLength(hash: string): number {
  if (hash === 'SHA-512') return 64;
  if (hash === 'SHA-384') return 48;
  return 32;
}

export async function hmac(hash: string, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toOwnedUint8Array(key),
    { name: 'HMAC', hash },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, toOwnedUint8Array(data)));
}

export async function digestBytes(hash: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(hash, toOwnedUint8Array(data)));
}

export async function tls12Prf(
  secret: Uint8Array,
  label: string,
  seed: Uint8Array,
  length: number,
  hash = 'SHA-256',
): Promise<Uint8Array> {
  const textEncoder = new TextEncoder();
  const labelSeed = concatBytes(textEncoder.encode(label), seed);
  let output: Uint8Array = new Uint8Array(0);
  let currentA: Uint8Array = labelSeed;
  while (output.length < length) {
    currentA = await hmac(hash, secret, currentA);
    const block = await hmac(hash, secret, concatBytes(currentA, labelSeed));
    output = concatBytes(output, block);
  }
  return output.slice(0, length);
}

export async function hkdfExtract(
  hash: string,
  salt: Uint8Array | null,
  inputKeyMaterial: Uint8Array,
): Promise<Uint8Array> {
  if (!salt || !salt.length) salt = new Uint8Array(hashByteLength(hash));
  return hmac(hash, salt, inputKeyMaterial);
}

export async function hkdfExpandLabel(
  hash: string,
  secret: Uint8Array,
  label: string,
  context: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const textEncoder = new TextEncoder();
  const fullLabel = textEncoder.encode('tls13 ' + label);
  const info = tlsBytes(uint16be(length), fullLabel.length, fullLabel, context.length, context);

  const hashLen = hashByteLength(hash);
  const roundCount = Math.ceil(length / hashLen);
  let output: Uint8Array = new Uint8Array(0);
  let previousBlock: Uint8Array = new Uint8Array(0);
  for (let round = 1; round <= roundCount; round++) {
    previousBlock = await hmac(
      hash,
      secret,
      concatBytes(previousBlock, info, new Uint8Array([round])),
    );
    output = concatBytes(output, previousBlock);
  }
  return output.slice(0, length);
}

export function tlsBytes(...parts: unknown[]): Uint8Array {
  const flatten = (values: unknown[]): number[] =>
    values.flatMap((v) =>
      v instanceof Uint8Array
        ? [...v]
        : Array.isArray(v)
          ? flatten(v)
          : typeof v === 'number'
            ? [v]
            : [],
    );
  return new Uint8Array(flatten(parts));
}

export function uint16be(value: number): [number, number] {
  return [(value >> 8) & 255, value & 255];
}

export const EMPTY_BYTES = new Uint8Array(0);

export const TLS_VERSION_10 = 769;
export const TLS_VERSION_12 = 771;
export const TLS_VERSION_13 = 772;

export const CONTENT_TYPE_CHANGE_CIPHER_SPEC = 20;
export const CONTENT_TYPE_ALERT = 21;
export const CONTENT_TYPE_HANDSHAKE = 22;
export const CONTENT_TYPE_APPLICATION_DATA = 23;

export const HANDSHAKE_TYPE_CLIENT_HELLO = 1;
export const HANDSHAKE_TYPE_SERVER_HELLO = 2;
export const HANDSHAKE_TYPE_ENCRYPTED_EXTENSIONS = 8;
export const HANDSHAKE_TYPE_CERTIFICATE = 11;
export const HANDSHAKE_TYPE_SERVER_KEY_EXCHANGE = 12;
export const HANDSHAKE_TYPE_SERVER_HELLO_DONE = 14;
export const HANDSHAKE_TYPE_CLIENT_KEY_EXCHANGE = 16;
export const HANDSHAKE_TYPE_FINISHED = 20;

export const EXT_SERVER_NAME = 0;
export const EXT_SUPPORTED_GROUPS = 10;
export const EXT_EC_POINT_FORMATS = 11;
export const EXT_SIGNATURE_ALGORITHMS = 13;
export const EXT_APPLICATION_LAYER_PROTOCOL_NEGOTIATION = 16;
export const EXT_SUPPORTED_VERSIONS = 43;
export const EXT_PSK_KEY_EXCHANGE_MODES = 45;
export const EXT_KEY_SHARE = 51;

export const ALERT_LEVEL_WARNING = 1;
export const ALERT_UNRECOGNIZED_NAME = 112;

export const CIPHER_SUITES_BY_ID = new Map([
  [4865, { id: 4865, keyLen: 16, ivLen: 12, hash: 'SHA-256', tls13: true }],
  [4866, { id: 4866, keyLen: 32, ivLen: 12, hash: 'SHA-384', tls13: true }],
  [4867, { id: 4867, keyLen: 32, ivLen: 12, hash: 'SHA-256', tls13: true, chacha: true }],
  [49199, { id: 49199, keyLen: 16, ivLen: 4, hash: 'SHA-256', kex: 'ECDHE' }],
  [49200, { id: 49200, keyLen: 32, ivLen: 4, hash: 'SHA-384', kex: 'ECDHE' }],
  [52392, { id: 52392, keyLen: 32, ivLen: 12, hash: 'SHA-256', kex: 'ECDHE', chacha: true }],
  [49195, { id: 49195, keyLen: 16, ivLen: 4, hash: 'SHA-256', kex: 'ECDHE' }],
  [49196, { id: 49196, keyLen: 32, ivLen: 4, hash: 'SHA-384', kex: 'ECDHE' }],
  [52393, { id: 52393, keyLen: 32, ivLen: 12, hash: 'SHA-256', kex: 'ECDHE', chacha: true }],
]);

export const GROUPS_BY_ID = new Map([
  [29, 'X25519'],
  [23, 'P-256'],
]);

export const SUPPORTED_SIGNATURE_ALGORITHMS = [
  2052, 2053, 2054, 1025, 1281, 1537, 1027, 1283, 1539,
];

const shouldIgnoreTlsAlert = (fragment: Uint8Array): boolean =>
  fragment?.[0] === ALERT_LEVEL_WARNING && fragment?.[1] === ALERT_UNRECOGNIZED_NAME;

export function buildTlsRecord(
  contentType: number,
  fragment: Uint8Array,
  version = TLS_VERSION_10,
): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = contentType;
  header[1] = (version >> 8) & 0xff;
  header[2] = version & 0xff;
  header[3] = (fragment.length >> 8) & 0xff;
  header[4] = fragment.length & 0xff;
  return concatBytes(header, fragment);
}

export function buildHandshakeMessage(handshakeType: number, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = handshakeType;
  header[1] = (body.length >> 16) & 0xff;
  header[2] = (body.length >> 8) & 0xff;
  header[3] = body.length & 0xff;
  return concatBytes(header, body);
}

export interface ServerHello {
  version: number;
  serverRandom: Uint8Array;
  sessionId: Uint8Array;
  cipherSuite: number;
  compression: number;
  selectedVersion: number;
  keyShare: { group: number; key: Uint8Array } | null;
  alpn: string | null;
  isHRR: boolean;
  isTls13: boolean;
}

export function parseServerHello(body: Uint8Array): ServerHello {
  let offset = 0;
  const legacyVersion = readUint16(body, offset);
  offset += 2;
  const serverRandom = body.slice(offset, offset + 32);
  offset += 32;
  const sessionIdLength = body[offset++]!;
  const sessionId = body.slice(offset, offset + sessionIdLength);
  offset += sessionIdLength;
  const cipherSuite = readUint16(body, offset);
  offset += 2;
  const compression = body[offset++]!;

  let selectedVersion = legacyVersion;
  let keyShare: { group: number; key: Uint8Array } | null = null;
  let alpn: string | null = null;

  if (offset < body.length) {
    const extensionsLength = readUint16(body, offset);
    offset += 2;
    const extensionsEnd = offset + extensionsLength;
    while (offset + 4 <= extensionsEnd) {
      const extensionType = readUint16(body, offset);
      offset += 2;
      const extensionLength = readUint16(body, offset);
      offset += 2;
      const extensionData = body.slice(offset, offset + extensionLength);
      offset += extensionLength;

      if (extensionType === EXT_SUPPORTED_VERSIONS && extensionLength >= 2) {
        selectedVersion = readUint16(extensionData, 0);
      } else if (extensionType === EXT_KEY_SHARE && extensionLength >= 4) {
        const group = readUint16(extensionData, 0);
        const keyLength = readUint16(extensionData, 2);
        keyShare = { group, key: extensionData.slice(4, 4 + keyLength) };
      } else if (
        extensionType === EXT_APPLICATION_LAYER_PROTOCOL_NEGOTIATION &&
        extensionLength >= 3
      ) {
        alpn = new TextDecoder().decode(extensionData.slice(3, 3 + extensionData[2]!));
      }
    }
  }

  const helloRetryRequestRandom = new Uint8Array([
    207, 33, 173, 116, 229, 154, 97, 17, 190, 29, 140, 2, 30, 101, 184, 145, 194, 162, 17, 22, 122,
    187, 140, 94, 7, 158, 9, 226, 200, 168, 51, 156,
  ]);

  return {
    version: legacyVersion,
    serverRandom,
    sessionId,
    cipherSuite,
    compression,
    selectedVersion,
    keyShare,
    alpn,
    isHRR: constantTimeEqual(serverRandom, helloRetryRequestRandom),
    isTls13: selectedVersion === TLS_VERSION_13,
  };
}

export function parseServerKeyExchange(body: Uint8Array): {
  namedCurve: number;
  serverPublicKey: Uint8Array;
} {
  let offset = 1;
  const namedCurve = readUint16(body, offset);
  offset += 2;
  const keyLength = body[offset++]!;
  return { namedCurve, serverPublicKey: body.slice(offset, offset + keyLength) };
}

export function extractLeafCertificate(body: Uint8Array, hasContext = 0): Uint8Array | null {
  let offset = 0;
  if (hasContext) {
    const contextLength = body[offset++]!;
    offset += contextLength;
  }
  if (offset + 3 > body.length) return null;
  const certificateListLength = readUint24(body, offset);
  offset += 3;
  if (!certificateListLength || offset + 3 > body.length) return null;
  const certificateLength = readUint24(body, offset);
  offset += 3;
  return certificateLength ? body.slice(offset, offset + certificateLength) : null;
}

export function parseEncryptedExtensions(body: Uint8Array): { alpn: string | null } {
  const parsed = { alpn: null as string | null };
  let offset = 2;
  const extensionsEnd = 2 + readUint16(body, 0);
  while (offset + 4 <= extensionsEnd) {
    const extensionType = readUint16(body, offset);
    offset += 2;
    const extensionLength = readUint16(body, offset);
    offset += 2;
    if (extensionType === EXT_APPLICATION_LAYER_PROTOCOL_NEGOTIATION && extensionLength >= 3) {
      const protocolLength = body[offset + 2]!;
      if (protocolLength > 0 && offset + 3 + protocolLength <= offset + extensionLength) {
        parsed.alpn = new TextDecoder().decode(body.slice(offset + 3, offset + 3 + protocolLength));
      }
    }
    offset += extensionLength;
  }
  return parsed;
}

export async function generateKeyShare(group = 'P-256') {
  const algorithm = group === 'X25519' ? { name: 'X25519' } : { name: 'ECDH', namedCurve: group };
  const keyPair = (await crypto.subtle.generateKey(algorithm, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return { keyPair, publicKeyRaw };
}

export async function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKey: Uint8Array,
  group = 'P-256',
): Promise<Uint8Array> {
  const algorithm = group === 'X25519' ? { name: 'X25519' } : { name: 'ECDH', namedCurve: group };
  const peerKey = await crypto.subtle.importKey(
    'raw',
    toOwnedUint8Array(peerPublicKey),
    algorithm,
    false,
    [],
  );
  const bits = group === 'P-384' ? 384 : group === 'P-521' ? 528 : 256;
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: algorithm.name, public: peerKey }, privateKey, bits),
  );
}

export async function importAesGcmKey(key: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toOwnedUint8Array(key), { name: 'AES-GCM' }, false, usages);
}

export async function aesGcmEncryptWithKey(
  cryptoKey: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toOwnedUint8Array(iv),
        additionalData: toOwnedUint8Array(additionalData),
        tagLength: 128,
      },
      cryptoKey,
      toOwnedUint8Array(plaintext),
    ),
  );
}

export async function aesGcmDecryptWithKey(
  cryptoKey: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toOwnedUint8Array(iv),
        additionalData: toOwnedUint8Array(additionalData),
        tagLength: 128,
      },
      cryptoKey,
      toOwnedUint8Array(ciphertext),
    ),
  );
}

export function uint64be(sequenceNumber: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, sequenceNumber, false);
  return bytes;
}

export function xorSequenceIntoIv(
  initializationVector: Uint8Array,
  sequenceNumber: bigint,
): Uint8Array {
  const nonce = initializationVector.slice();
  const sequenceBytes = uint64be(sequenceNumber);
  for (let i = 0; i < 8; i++) {
    const index = nonce.length - 8 + i;
    nonce[index] = nonce[index]! ^ sequenceBytes[i]!;
  }
  return nonce;
}

export async function deriveTrafficKeys(
  hash: string,
  secret: Uint8Array,
  keyLen: number,
  ivLen: number,
): Promise<[Uint8Array, Uint8Array]> {
  return Promise.all([
    hkdfExpandLabel(hash, secret, 'key', EMPTY_BYTES, keyLen),
    hkdfExpandLabel(hash, secret, 'iv', EMPTY_BYTES, ivLen),
  ]);
}

export function buildClientHello(
  clientRandom: Uint8Array,
  serverName: string,
  keyShares: { x25519?: Uint8Array; p256?: Uint8Array } | Uint8Array,
  options: {
    tls13?: boolean;
    tls12?: boolean;
    alpn?: string[] | string | null;
    chacha?: boolean;
  } = {},
): Uint8Array {
  const {
    tls13: enableTls13 = true,
    tls12: enableTls12 = true,
    alpn = null,
    chacha = true,
  } = options;
  const textEncoder = new TextEncoder();

  const cipherIds: number[] = [];
  if (enableTls13) cipherIds.push(4865, 4866, ...(chacha ? [4867] : []));
  if (enableTls12) cipherIds.push(49199, 49200, 49195, 49196, ...(chacha ? [52392, 52393] : []));
  const cipherBytes = tlsBytes(...cipherIds.flatMap(uint16be));

  const extensions: Uint8Array[] = [];
  extensions.push(tlsBytes(255, 1, 0, 1, 0)); // extended_master_secret

  if (serverName) {
    const serverNameBytes = textEncoder.encode(serverName);
    const serverNameList = tlsBytes(0, uint16be(serverNameBytes.length), serverNameBytes);
    extensions.push(
      tlsBytes(
        uint16be(EXT_SERVER_NAME),
        uint16be(serverNameList.length + 2),
        uint16be(serverNameList.length),
        serverNameList,
      ),
    );
  }

  extensions.push(tlsBytes(uint16be(EXT_EC_POINT_FORMATS), 0, 2, 1, 0));
  extensions.push(tlsBytes(uint16be(EXT_SUPPORTED_GROUPS), 0, 6, 0, 4, 0, 29, 0, 23));

  const signatureBytes = tlsBytes(...SUPPORTED_SIGNATURE_ALGORITHMS.flatMap(uint16be));
  extensions.push(
    tlsBytes(
      uint16be(EXT_SIGNATURE_ALGORITHMS),
      uint16be(signatureBytes.length + 2),
      uint16be(signatureBytes.length),
      signatureBytes,
    ),
  );

  const protocols = Array.isArray(alpn) ? alpn.filter(Boolean) : alpn ? [alpn] : [];
  if (protocols.length) {
    const alpnBytes = concatBytes(
      ...protocols.map((p) => {
        const pb = textEncoder.encode(p);
        return tlsBytes(pb.length, pb);
      }),
    );
    extensions.push(
      tlsBytes(
        uint16be(EXT_APPLICATION_LAYER_PROTOCOL_NEGOTIATION),
        uint16be(alpnBytes.length + 2),
        uint16be(alpnBytes.length),
        alpnBytes,
      ),
    );
  }

  if (enableTls13) {
    extensions.push(
      enableTls12
        ? tlsBytes(uint16be(EXT_SUPPORTED_VERSIONS), 0, 5, 4, 3, 4, 3, 3)
        : tlsBytes(uint16be(EXT_SUPPORTED_VERSIONS), 0, 3, 2, 3, 4),
    );
    extensions.push(tlsBytes(uint16be(EXT_PSK_KEY_EXCHANGE_MODES), 0, 2, 1, 1));

    let keyShareBytes: Uint8Array;
    if (keyShares instanceof Uint8Array) {
      keyShareBytes = tlsBytes(0, 23, uint16be(keyShares.length), keyShares);
    } else if (keyShares.x25519 && keyShares.p256) {
      keyShareBytes = concatBytes(
        tlsBytes(0, 29, uint16be(keyShares.x25519.length), keyShares.x25519),
        tlsBytes(0, 23, uint16be(keyShares.p256.length), keyShares.p256),
      );
    } else if (keyShares.x25519) {
      keyShareBytes = tlsBytes(0, 29, uint16be(keyShares.x25519.length), keyShares.x25519);
    } else if (keyShares.p256) {
      keyShareBytes = tlsBytes(0, 23, uint16be(keyShares.p256.length), keyShares.p256);
    } else {
      throw new Error('Invalid keyShares');
    }
    extensions.push(
      tlsBytes(
        uint16be(EXT_KEY_SHARE),
        uint16be(keyShareBytes.length + 2),
        uint16be(keyShareBytes.length),
        keyShareBytes,
      ),
    );
  }

  const extensionsBytes = concatBytes(...extensions);
  return buildHandshakeMessage(
    HANDSHAKE_TYPE_CLIENT_HELLO,
    tlsBytes(
      uint16be(TLS_VERSION_12),
      clientRandom,
      0,
      uint16be(cipherBytes.length),
      cipherBytes,
      1,
      0,
      uint16be(extensionsBytes.length),
      extensionsBytes,
    ),
  );
}

export interface CipherConfig {
  id: number;
  keyLen: number;
  ivLen: number;
  hash: string;
  tls13?: boolean;
  kex?: string;
  chacha?: boolean;
}

export class TlsClient {
  socket: Socket;
  serverName: string;
  supportTls13: boolean;
  supportTls12: boolean;
  alpnProtocols: string[] | null;
  allowChacha: boolean;
  timeout: number;
  clientRandom: Uint8Array;
  serverRandom: Uint8Array | null;
  handshakeChunks: Uint8Array[];
  handshakeComplete: boolean;
  negotiatedAlpn: string | null;
  cipherSuite: number | null;
  cipherConfig: CipherConfig | null;
  isTls13: boolean;
  masterSecret: Uint8Array | null;
  handshakeSecret: Uint8Array | null;
  clientWriteKey: Uint8Array | null;
  serverWriteKey: Uint8Array | null;
  clientWriteIv: Uint8Array | null;
  serverWriteIv: Uint8Array | null;
  clientHandshakeKey: Uint8Array | null;
  serverHandshakeKey: Uint8Array | null;
  clientHandshakeIv: Uint8Array | null;
  serverHandshakeIv: Uint8Array | null;
  clientAppKey: Uint8Array | null;
  serverAppKey: Uint8Array | null;
  clientAppIv: Uint8Array | null;
  serverAppIv: Uint8Array | null;
  clientWriteCryptoKey: CryptoKey | null;
  serverWriteCryptoKey: CryptoKey | null;
  clientHandshakeCryptoKey: CryptoKey | null;
  serverHandshakeCryptoKey: CryptoKey | null;
  clientAppCryptoKey: CryptoKey | null;
  serverAppCryptoKey: CryptoKey | null;
  clientSeqNum: bigint;
  serverSeqNum: bigint;
  recordParser: TlsRecordParser;
  handshakeParser: TlsHandshakeParser;
  keyPairs: Map<number, { keyPair: CryptoKeyPair; publicKeyRaw: Uint8Array }>;
  ecdhKeyPair: CryptoKeyPair | null;
  sawCert: boolean;

  constructor(
    socket: Socket,
    options: {
      serverName?: string;
      tls13?: boolean;
      tls12?: boolean;
      alpn?: string[] | string | null;
      allowChacha?: boolean;
      timeout?: number;
      insecure?: boolean;
    } = {},
  ) {
    this.socket = socket;
    this.serverName = options.serverName || '';
    this.supportTls13 = options.tls13 !== false;
    this.supportTls12 = options.tls12 !== false;
    if (!this.supportTls13 && !this.supportTls12)
      throw new Error('At least one TLS version must be enabled');
    this.alpnProtocols = Array.isArray(options.alpn)
      ? options.alpn
      : options.alpn
        ? [options.alpn]
        : null;
    this.allowChacha = options.allowChacha !== false;
    this.timeout = options.timeout ?? 30000;
    this.clientRandom = randomBytes(32);
    this.serverRandom = null;
    this.handshakeChunks = [];
    this.handshakeComplete = false;
    this.negotiatedAlpn = null;
    this.cipherSuite = null;
    this.cipherConfig = null;
    this.isTls13 = false;
    this.masterSecret = null;
    this.handshakeSecret = null;
    this.clientWriteKey = null;
    this.serverWriteKey = null;
    this.clientWriteIv = null;
    this.serverWriteIv = null;
    this.clientHandshakeKey = null;
    this.serverHandshakeKey = null;
    this.clientHandshakeIv = null;
    this.serverHandshakeIv = null;
    this.clientAppKey = null;
    this.serverAppKey = null;
    this.clientAppIv = null;
    this.serverAppIv = null;
    this.clientWriteCryptoKey = null;
    this.serverWriteCryptoKey = null;
    this.clientHandshakeCryptoKey = null;
    this.serverHandshakeCryptoKey = null;
    this.clientAppCryptoKey = null;
    this.serverAppCryptoKey = null;
    this.clientSeqNum = 0n;
    this.serverSeqNum = 0n;
    this.recordParser = new TlsRecordParser();
    this.handshakeParser = new TlsHandshakeParser();
    this.keyPairs = new Map();
    this.ecdhKeyPair = null;
    this.sawCert = false;
  }

  recordHandshake(chunk: Uint8Array) {
    this.handshakeChunks.push(chunk);
  }

  transcript(): Uint8Array {
    return this.handshakeChunks.length === 1
      ? this.handshakeChunks[0]!
      : concatBytes(...this.handshakeChunks);
  }

  getCipherConfig(cipherSuite: number): CipherConfig | null {
    return CIPHER_SUITES_BY_ID.get(cipherSuite) ?? null;
  }

  async readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.timeout) {
      return Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('TLS read timeout')), this.timeout),
        ),
      ]);
    }
    return reader.read();
  }

  async readRecordsUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    predicate: (record: {
      type: number;
      version: number;
      length: number;
      fragment: Uint8Array;
    }) => Promise<boolean | void>,
    closedError: string,
  ): Promise<void> {
    for (;;) {
      let record;
      while ((record = this.recordParser.next())) {
        if (await predicate(record)) return;
      }
      const { value, done } = await this.readChunk(reader);
      if (done) throw new Error(closedError);
      this.recordParser.feed(value);
    }
  }

  async readHandshakeUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    predicate: (message: {
      type: number;
      length: number;
      body: Uint8Array;
      raw: Uint8Array;
    }) => Promise<boolean | void>,
    closedError: string,
  ): Promise<void> {
    let message;
    while ((message = this.handshakeParser.next())) {
      if (await predicate(message)) return;
    }
    return this.readRecordsUntil(
      reader,
      async (record) => {
        if (record.type === CONTENT_TYPE_ALERT) {
          if (shouldIgnoreTlsAlert(record.fragment)) return;
          throw new Error(`TLS Alert: ${record.fragment[1]}`);
        }
        if (record.type === CONTENT_TYPE_HANDSHAKE) {
          this.handshakeParser.feed(record.fragment);
          let message;
          while ((message = this.handshakeParser.next())) {
            if (await predicate(message)) return true;
          }
        }
      },
      closedError,
    );
  }

  async acceptCertificate(certificate: Uint8Array) {
    if (!certificate?.length) throw new Error('Empty certificate');
    this.sawCert = true;
  }

  async handshake(): Promise<void> {
    const [p256Share, x25519Share] = await Promise.all([
      generateKeyShare('P-256'),
      generateKeyShare('X25519'),
    ]);
    this.keyPairs = new Map([
      [23, p256Share],
      [29, x25519Share],
    ]);
    this.ecdhKeyPair = p256Share.keyPair;

    const reader = this.socket.readable.getReader();
    const writer = this.socket.writable.getWriter();
    try {
      const clientHello = buildClientHello(
        this.clientRandom,
        this.serverName,
        { x25519: x25519Share.publicKeyRaw, p256: p256Share.publicKeyRaw },
        {
          tls13: this.supportTls13,
          tls12: this.supportTls12,
          alpn: this.alpnProtocols,
          chacha: this.allowChacha,
        },
      );
      this.recordHandshake(clientHello);
      await writer.write(buildTlsRecord(CONTENT_TYPE_HANDSHAKE, clientHello, TLS_VERSION_10));

      const serverHello = await this.receiveServerHello(reader);
      if (serverHello.isHRR) throw new Error('HelloRetryRequest is not supported');

      if (serverHello.keyShare?.group && this.keyPairs.has(serverHello.keyShare.group)) {
        const selectedKeyPair = this.keyPairs.get(serverHello.keyShare.group)!;
        this.ecdhKeyPair = selectedKeyPair.keyPair;
      }

      if (serverHello.isTls13) {
        await this.handshakeTls13(reader, writer, serverHello);
      } else {
        await this.handshakeTls12(reader, writer);
      }
      this.handshakeComplete = true;
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  }

  async receiveServerHello(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ServerHello> {
    for (;;) {
      const { value, done } = await this.readChunk(reader);
      if (done) throw new Error('Connection closed waiting for ServerHello');
      let record;
      this.recordParser.feed(value);
      while ((record = this.recordParser.next())) {
        if (record.type === CONTENT_TYPE_ALERT) {
          if (shouldIgnoreTlsAlert(record.fragment)) continue;
          throw new Error(`TLS Alert: level=${record.fragment[0]}, desc=${record.fragment[1]}`);
        }
        if (record.type !== CONTENT_TYPE_HANDSHAKE) continue;
        let message;
        this.handshakeParser.feed(record.fragment);
        while ((message = this.handshakeParser.next())) {
          if (message.type !== HANDSHAKE_TYPE_SERVER_HELLO) continue;
          this.recordHandshake(message.raw);
          const serverHello = parseServerHello(message.body);
          this.serverRandom = serverHello.serverRandom;
          this.cipherSuite = serverHello.cipherSuite;
          this.cipherConfig = this.getCipherConfig(serverHello.cipherSuite);
          this.isTls13 = serverHello.isTls13;
          this.negotiatedAlpn = serverHello.alpn || null;
          if (!this.cipherConfig)
            throw new Error(`Unsupported cipher suite: 0x${serverHello.cipherSuite.toString(16)}`);
          return serverHello;
        }
      }
    }
  }

  async handshakeTls12(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<void> {
    let serverKeyExchange: { namedCurve: number; serverPublicKey: Uint8Array } | null = null;

    await this.readHandshakeUntil(
      reader,
      async (message) => {
        switch (message.type) {
          case HANDSHAKE_TYPE_CERTIFICATE: {
            this.recordHandshake(message.raw);
            const certificate = extractLeafCertificate(message.body, 1);
            if (!certificate) throw new Error('Missing TLS 1.2 certificate');
            await this.acceptCertificate(certificate);
            break;
          }
          case HANDSHAKE_TYPE_SERVER_KEY_EXCHANGE:
            this.recordHandshake(message.raw);
            serverKeyExchange = parseServerKeyExchange(message.body);
            break;
          case HANDSHAKE_TYPE_SERVER_HELLO_DONE:
            this.recordHandshake(message.raw);
            return true;
          default:
            this.recordHandshake(message.raw);
        }
      },
      'Connection closed during TLS 1.2 handshake',
    );

    if (!this.sawCert) throw new Error('Missing TLS 1.2 leaf certificate');
    const resolvedServerKeyExchange = serverKeyExchange as ReturnType<
      typeof parseServerKeyExchange
    > | null;
    if (!resolvedServerKeyExchange) throw new Error('Missing TLS 1.2 ServerKeyExchange');

    const curveName = GROUPS_BY_ID.get(resolvedServerKeyExchange.namedCurve);
    if (!curveName) {
      throw new Error(
        `Unsupported named curve: 0x${resolvedServerKeyExchange.namedCurve.toString(16)}`,
      );
    }

    const keyShare = this.keyPairs.get(resolvedServerKeyExchange.namedCurve);
    if (!keyShare) {
      throw new Error(
        `Missing key pair for curve: 0x${resolvedServerKeyExchange.namedCurve.toString(16)}`,
      );
    }

    const preMasterSecret = await deriveSharedSecret(
      keyShare.keyPair.privateKey,
      resolvedServerKeyExchange.serverPublicKey,
      curveName,
    );

    const clientKeyExchange = buildHandshakeMessage(
      HANDSHAKE_TYPE_CLIENT_KEY_EXCHANGE,
      tlsBytes(keyShare.publicKeyRaw.length, keyShare.publicKeyRaw),
    );
    this.recordHandshake(clientKeyExchange);

    const hashName = this.cipherConfig!.hash;
    this.masterSecret = await tls12Prf(
      preMasterSecret,
      'master secret',
      concatBytes(this.clientRandom, this.serverRandom),
      48,
      hashName,
    );

    const keyLen = this.cipherConfig!.keyLen;
    const ivLen = this.cipherConfig!.ivLen;
    const keyBlock = await tls12Prf(
      this.masterSecret,
      'key expansion',
      concatBytes(this.serverRandom, this.clientRandom),
      2 * keyLen + 2 * ivLen,
      hashName,
    );

    this.clientWriteKey = keyBlock.slice(0, keyLen);
    this.serverWriteKey = keyBlock.slice(keyLen, 2 * keyLen);
    this.clientWriteIv = keyBlock.slice(2 * keyLen, 2 * keyLen + ivLen);
    this.serverWriteIv = keyBlock.slice(2 * keyLen + ivLen, 2 * keyLen + 2 * ivLen);

    if (!this.cipherConfig!.chacha) {
      [this.clientWriteCryptoKey, this.serverWriteCryptoKey] = await Promise.all([
        importAesGcmKey(this.clientWriteKey, ['encrypt']),
        importAesGcmKey(this.serverWriteKey, ['decrypt']),
      ]);
    }

    await writer.write(buildTlsRecord(CONTENT_TYPE_HANDSHAKE, clientKeyExchange));
    await writer.write(buildTlsRecord(CONTENT_TYPE_CHANGE_CIPHER_SPEC, tlsBytes(1)));

    const clientVerifyData = await tls12Prf(
      this.masterSecret,
      'client finished',
      await digestBytes(hashName, this.transcript()),
      12,
      hashName,
    );
    const finishedMessage = buildHandshakeMessage(HANDSHAKE_TYPE_FINISHED, clientVerifyData);
    this.recordHandshake(finishedMessage);
    await writer.write(
      buildTlsRecord(
        CONTENT_TYPE_HANDSHAKE,
        await this.encryptTls12(finishedMessage, CONTENT_TYPE_HANDSHAKE),
      ),
    );

    let sawChangeCipherSpec = false;
    await this.readRecordsUntil(
      reader,
      async (record) => {
        if (record.type === CONTENT_TYPE_ALERT) {
          if (shouldIgnoreTlsAlert(record.fragment)) return;
          throw new Error(`TLS Alert: ${record.fragment[1]}`);
        }
        if (record.type === CONTENT_TYPE_CHANGE_CIPHER_SPEC) {
          sawChangeCipherSpec = true;
          return;
        }
        if (record.type !== CONTENT_TYPE_HANDSHAKE || !sawChangeCipherSpec) return;
        const decrypted = await this.decryptTls12(record.fragment, CONTENT_TYPE_HANDSHAKE);
        if (decrypted[0] !== HANDSHAKE_TYPE_FINISHED) return;
        const verifyLength = readUint24(decrypted, 1);
        const verifyData = decrypted.slice(4, 4 + verifyLength);
        const expectedVerifyData = await tls12Prf(
          this.masterSecret!,
          'server finished',
          await digestBytes(hashName, this.transcript()),
          12,
          hashName,
        );
        if (!constantTimeEqual(verifyData, expectedVerifyData)) {
          throw new Error('TLS 1.2 server Finished verify failed');
        }
        return true;
      },
      'Connection closed waiting for TLS 1.2 Finished',
    );
  }

  async handshakeTls13(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    serverHello: ServerHello,
  ): Promise<void> {
    const groupName = GROUPS_BY_ID.get(serverHello.keyShare?.group ?? 0);
    if (!groupName || !serverHello.keyShare?.key?.length)
      throw new Error('Missing TLS 1.3 key_share');

    const hashName = this.cipherConfig!.hash;
    const hashLen = hashByteLength(hashName);
    const keyLen = this.cipherConfig!.keyLen;
    const ivLen = this.cipherConfig!.ivLen;

    const sharedSecret = await deriveSharedSecret(
      this.ecdhKeyPair!.privateKey,
      serverHello.keyShare.key,
      groupName,
    );
    const earlySecret = await hkdfExtract(hashName, null, new Uint8Array(hashLen));
    const derivedSecret = await hkdfExpandLabel(
      hashName,
      earlySecret,
      'derived',
      await digestBytes(hashName, EMPTY_BYTES),
      hashLen,
    );
    this.handshakeSecret = await hkdfExtract(hashName, derivedSecret, sharedSecret);

    const transcriptHash = await digestBytes(hashName, this.transcript());
    const clientHandshakeTrafficSecret = await hkdfExpandLabel(
      hashName,
      this.handshakeSecret,
      'c hs traffic',
      transcriptHash,
      hashLen,
    );
    const serverHandshakeTrafficSecret = await hkdfExpandLabel(
      hashName,
      this.handshakeSecret,
      's hs traffic',
      transcriptHash,
      hashLen,
    );

    [this.clientHandshakeKey, this.clientHandshakeIv] = await deriveTrafficKeys(
      hashName,
      clientHandshakeTrafficSecret,
      keyLen,
      ivLen,
    );
    [this.serverHandshakeKey, this.serverHandshakeIv] = await deriveTrafficKeys(
      hashName,
      serverHandshakeTrafficSecret,
      keyLen,
      ivLen,
    );

    if (!this.cipherConfig!.chacha) {
      [this.clientHandshakeCryptoKey, this.serverHandshakeCryptoKey] = await Promise.all([
        importAesGcmKey(this.clientHandshakeKey, ['encrypt']),
        importAesGcmKey(this.serverHandshakeKey, ['decrypt']),
      ]);
    }

    const serverFinishedKey = await hkdfExpandLabel(
      hashName,
      serverHandshakeTrafficSecret,
      'finished',
      EMPTY_BYTES,
      hashLen,
    );
    let serverFinishedReceived = false;

    const handleHandshakeMessage = async (message: {
      type: number;
      body: Uint8Array;
      raw: Uint8Array;
    }) => {
      switch (message.type) {
        case HANDSHAKE_TYPE_ENCRYPTED_EXTENSIONS: {
          const encryptedExtensions = parseEncryptedExtensions(message.body);
          if (encryptedExtensions.alpn) this.negotiatedAlpn = encryptedExtensions.alpn;
          this.recordHandshake(message.raw);
          break;
        }
        case HANDSHAKE_TYPE_CERTIFICATE: {
          const certificate = extractLeafCertificate(message.body);
          if (!certificate) throw new Error('Missing TLS 1.3 certificate');
          await this.acceptCertificate(certificate);
          this.recordHandshake(message.raw);
          break;
        }
        case HANDSHAKE_TYPE_FINISHED: {
          const expectedVerifyData = await hmac(
            hashName,
            serverFinishedKey,
            await digestBytes(hashName, this.transcript()),
          );
          if (!constantTimeEqual(expectedVerifyData, message.body))
            throw new Error('TLS 1.3 server Finished verify failed');
          this.recordHandshake(message.raw);
          serverFinishedReceived = true;
          break;
        }
        default:
          this.recordHandshake(message.raw);
      }
    };

    await this.readRecordsUntil(
      reader,
      async (record) => {
        if (
          record.type === CONTENT_TYPE_CHANGE_CIPHER_SPEC ||
          record.type === CONTENT_TYPE_HANDSHAKE
        )
          return;
        if (record.type === CONTENT_TYPE_ALERT) {
          if (shouldIgnoreTlsAlert(record.fragment)) return;
          throw new Error(`TLS Alert: ${record.fragment[1]}`);
        }
        if (record.type !== CONTENT_TYPE_APPLICATION_DATA) return;
        const decrypted = await this.decryptTls13Handshake(record.fragment);
        const innerType = decrypted[decrypted.length - 1];
        const plaintext = decrypted.slice(0, -1);
        if (innerType === CONTENT_TYPE_HANDSHAKE) {
          this.handshakeParser.feed(plaintext);
          let message;
          while ((message = this.handshakeParser.next())) {
            await handleHandshakeMessage(message);
            if (serverFinishedReceived) return true;
          }
        }
      },
      'Connection closed during TLS 1.3 handshake',
    );

    const applicationTranscriptHash = await digestBytes(hashName, this.transcript());
    const masterDerivedSecret = await hkdfExpandLabel(
      hashName,
      this.handshakeSecret,
      'derived',
      await digestBytes(hashName, EMPTY_BYTES),
      hashLen,
    );
    const masterSecret = await hkdfExtract(hashName, masterDerivedSecret, new Uint8Array(hashLen));
    const clientAppTrafficSecret = await hkdfExpandLabel(
      hashName,
      masterSecret,
      'c ap traffic',
      applicationTranscriptHash,
      hashLen,
    );
    const serverAppTrafficSecret = await hkdfExpandLabel(
      hashName,
      masterSecret,
      's ap traffic',
      applicationTranscriptHash,
      hashLen,
    );

    [this.clientAppKey, this.clientAppIv] = await deriveTrafficKeys(
      hashName,
      clientAppTrafficSecret,
      keyLen,
      ivLen,
    );
    [this.serverAppKey, this.serverAppIv] = await deriveTrafficKeys(
      hashName,
      serverAppTrafficSecret,
      keyLen,
      ivLen,
    );

    if (!this.cipherConfig!.chacha) {
      [this.clientAppCryptoKey, this.serverAppCryptoKey] = await Promise.all([
        importAesGcmKey(this.clientAppKey, ['encrypt']),
        importAesGcmKey(this.serverAppKey, ['decrypt']),
      ]);
    }

    const clientFinishedKey = await hkdfExpandLabel(
      hashName,
      clientHandshakeTrafficSecret,
      'finished',
      EMPTY_BYTES,
      hashLen,
    );
    const clientFinishedVerifyData = await hmac(
      hashName,
      clientFinishedKey,
      await digestBytes(hashName, this.transcript()),
    );
    const clientFinishedMessage = buildHandshakeMessage(
      HANDSHAKE_TYPE_FINISHED,
      clientFinishedVerifyData,
    );
    this.recordHandshake(clientFinishedMessage);
    await writer.write(
      buildTlsRecord(
        CONTENT_TYPE_APPLICATION_DATA,
        await this.encryptTls13Handshake(
          concatBytes(clientFinishedMessage, new Uint8Array([CONTENT_TYPE_HANDSHAKE])),
        ),
      ),
    );
    this.clientSeqNum = 0n;
    this.serverSeqNum = 0n;
  }

  async encryptTls12(plaintext: Uint8Array, contentType: number): Promise<Uint8Array> {
    const sequenceNumber = this.clientSeqNum++;
    const sequenceBytes = uint64be(sequenceNumber);
    const additionalData = concatBytes(
      sequenceBytes,
      new Uint8Array([contentType]),
      new Uint8Array(uint16be(TLS_VERSION_12)),
      new Uint8Array(uint16be(plaintext.length)),
    );
    if (this.cipherConfig!.chacha) {
      const nonce = xorSequenceIntoIv(this.clientWriteIv!, sequenceNumber);
      return chacha20Poly1305Encrypt(this.clientWriteKey!, nonce, plaintext, additionalData);
    }
    const explicitNonce = randomBytes(8);
    if (!this.clientWriteCryptoKey)
      this.clientWriteCryptoKey = await importAesGcmKey(this.clientWriteKey!, ['encrypt']);
    return concatBytes(
      explicitNonce,
      await aesGcmEncryptWithKey(
        this.clientWriteCryptoKey,
        concatBytes(this.clientWriteIv, explicitNonce),
        plaintext,
        additionalData,
      ),
    );
  }

  async decryptTls12(ciphertext: Uint8Array, contentType: number): Promise<Uint8Array> {
    const sequenceNumber = this.serverSeqNum++;
    const sequenceBytes = uint64be(sequenceNumber);
    if (this.cipherConfig!.chacha) {
      const nonce = xorSequenceIntoIv(this.serverWriteIv!, sequenceNumber);
      return chacha20Poly1305Decrypt(
        this.serverWriteKey!,
        nonce,
        ciphertext,
        concatBytes(
          sequenceBytes,
          new Uint8Array([contentType]),
          new Uint8Array(uint16be(TLS_VERSION_12)),
          new Uint8Array(uint16be(ciphertext.length - 16)),
        ),
      );
    }
    const explicitNonce = ciphertext.subarray(0, 8);
    const encryptedData = ciphertext.subarray(8);
    if (!this.serverWriteCryptoKey)
      this.serverWriteCryptoKey = await importAesGcmKey(this.serverWriteKey!, ['decrypt']);
    return aesGcmDecryptWithKey(
      this.serverWriteCryptoKey,
      concatBytes(this.serverWriteIv, explicitNonce),
      encryptedData,
      concatBytes(
        sequenceBytes,
        new Uint8Array([contentType]),
        new Uint8Array(uint16be(TLS_VERSION_12)),
        new Uint8Array(uint16be(encryptedData.length - 16)),
      ),
    );
  }

  async encryptTls13Handshake(plaintext: Uint8Array): Promise<Uint8Array> {
    const nonce = xorSequenceIntoIv(this.clientHandshakeIv!, this.clientSeqNum++);
    const additionalData = tlsBytes(
      CONTENT_TYPE_APPLICATION_DATA,
      3,
      3,
      uint16be(plaintext.length + 16),
    );
    if (this.cipherConfig!.chacha)
      return chacha20Poly1305Encrypt(this.clientHandshakeKey!, nonce, plaintext, additionalData);
    if (!this.clientHandshakeCryptoKey)
      this.clientHandshakeCryptoKey = await importAesGcmKey(this.clientHandshakeKey!, ['encrypt']);
    return aesGcmEncryptWithKey(this.clientHandshakeCryptoKey, nonce, plaintext, additionalData);
  }

  async decryptTls13Handshake(ciphertext: Uint8Array): Promise<Uint8Array> {
    const nonce = xorSequenceIntoIv(this.serverHandshakeIv!, this.serverSeqNum++);
    const additionalData = tlsBytes(
      CONTENT_TYPE_APPLICATION_DATA,
      3,
      3,
      uint16be(ciphertext.length),
    );
    const decrypted = this.cipherConfig!.chacha
      ? await chacha20Poly1305Decrypt(this.serverHandshakeKey!, nonce, ciphertext, additionalData)
      : await aesGcmDecryptWithKey(
          this.serverHandshakeCryptoKey ||
            (this.serverHandshakeCryptoKey = await importAesGcmKey(this.serverHandshakeKey!, [
              'decrypt',
            ])),
          nonce,
          ciphertext,
          additionalData,
        );
    let innerTypeIndex = decrypted.length - 1;
    while (innerTypeIndex >= 0 && !decrypted[innerTypeIndex]) innerTypeIndex--;
    return innerTypeIndex < 0 ? EMPTY_BYTES : decrypted.slice(0, innerTypeIndex + 1);
  }

  async encryptTls13(data: Uint8Array): Promise<Uint8Array> {
    const plaintext = concatBytes(data, new Uint8Array([CONTENT_TYPE_APPLICATION_DATA]));
    const nonce = xorSequenceIntoIv(this.clientAppIv!, this.clientSeqNum++);
    const additionalData = tlsBytes(
      CONTENT_TYPE_APPLICATION_DATA,
      3,
      3,
      uint16be(plaintext.length + 16),
    );
    if (this.cipherConfig!.chacha)
      return chacha20Poly1305Encrypt(this.clientAppKey!, nonce, plaintext, additionalData);
    if (!this.clientAppCryptoKey)
      this.clientAppCryptoKey = await importAesGcmKey(this.clientAppKey!, ['encrypt']);
    return aesGcmEncryptWithKey(this.clientAppCryptoKey, nonce, plaintext, additionalData);
  }

  async decryptTls13(ciphertext: Uint8Array): Promise<Uint8Array> {
    const nonce = xorSequenceIntoIv(this.serverAppIv!, this.serverSeqNum++);
    const additionalData = tlsBytes(
      CONTENT_TYPE_APPLICATION_DATA,
      3,
      3,
      uint16be(ciphertext.length),
    );
    const decrypted = this.cipherConfig!.chacha
      ? await chacha20Poly1305Decrypt(this.serverAppKey!, nonce, ciphertext, additionalData)
      : await aesGcmDecryptWithKey(
          this.serverAppCryptoKey ||
            (this.serverAppCryptoKey = await importAesGcmKey(this.serverAppKey!, ['decrypt'])),
          nonce,
          ciphertext,
          additionalData,
        );
    let innerTypeIndex = decrypted.length - 1;
    while (innerTypeIndex >= 0 && !decrypted[innerTypeIndex]) innerTypeIndex--;
    return innerTypeIndex < 0 ? EMPTY_BYTES : decrypted.slice(0, innerTypeIndex + 1);
  }

  async write(data: Uint8Array): Promise<void> {
    const writer = this.socket.writable.getWriter();
    try {
      await writer.write(
        this.isTls13
          ? await this.encryptTls13(data)
          : await this.encryptTls12(data, CONTENT_TYPE_APPLICATION_DATA),
      );
    } finally {
      writer.releaseLock();
    }
  }

  async read(): Promise<Uint8Array | null> {
    const reader = this.socket.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.readChunk(reader);
        if (done) return null;
        this.recordParser.feed(value);
        let record;
        while ((record = this.recordParser.next())) {
          if (record.type === CONTENT_TYPE_APPLICATION_DATA) {
            return this.isTls13
              ? await this.decryptTls13(record.fragment)
              : await this.decryptTls12(record.fragment, CONTENT_TYPE_APPLICATION_DATA);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  close() {
    return this.socket.close();
  }
}

async function chacha20Poly1305Encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toOwnedUint8Array(key),
    { name: 'ChaCha20-Poly1305' },
    false,
    ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'ChaCha20-Poly1305',
      iv: toOwnedUint8Array(nonce),
      additionalData: toOwnedUint8Array(additionalData),
      tagLength: 128,
    },
    cryptoKey,
    toOwnedUint8Array(plaintext),
  );
  return new Uint8Array(ciphertext);
}

async function chacha20Poly1305Decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toOwnedUint8Array(key),
    { name: 'ChaCha20-Poly1305' },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'ChaCha20-Poly1305',
      iv: toOwnedUint8Array(nonce),
      additionalData: toOwnedUint8Array(additionalData),
      tagLength: 128,
    },
    cryptoKey,
    toOwnedUint8Array(ciphertext),
  );
  return new Uint8Array(plaintext);
}
