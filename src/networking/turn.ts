import type { ProxyAddress } from './connectors/types';
import { concatBytes } from '../shared/bytes';
import { resolveDns, type DnsAnswer } from './dns';
import { isIPv4, stripIPv6Brackets } from './proxy-connectors';
import type { SocketConnector } from './sockets';

const CONNECT_TIMEOUT_MS = 10_000;
const STUN_COOKIE = new Uint8Array([0x21, 0x12, 0xa4, 0x42]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const STUN_TYPE = {
  ALLOCATE_REQUEST: 0x0003,
  ALLOCATE_SUCCESS: 0x0103,
  ALLOCATE_ERROR: 0x0113,
  CREATE_PERMISSION_REQUEST: 0x0008,
  CREATE_PERMISSION_SUCCESS: 0x0108,
  CONNECT_REQUEST: 0x000a,
  CONNECT_SUCCESS: 0x010a,
  CONNECTION_BIND_REQUEST: 0x000b,
  CONNECTION_BIND_SUCCESS: 0x010b,
} as const;

const STUN_ATTRIBUTE = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  XOR_PEER_ADDRESS: 0x0012,
  REALM: 0x0014,
  NONCE: 0x0015,
  REQUESTED_TRANSPORT: 0x0019,
  CONNECTION_ID: 0x002a,
} as const;

type TurnReader = ReadableStreamDefaultReader<Uint8Array>;
type TurnWriter = WritableStreamDefaultWriter<Uint8Array>;
type TurnAttributes = Record<number, Uint8Array>;
type DnsResolver = (domain: string, recordType: string) => Promise<DnsAnswer[]>;

interface TurnResponse {
  message: { type: number; attributes: TurnAttributes };
  extraData: Uint8Array | null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function stunPadding(length: number): number {
  return -length & 3;
}

export function createTurnStunAttribute(type: number, value: Uint8Array): Uint8Array {
  const attribute = new Uint8Array(4 + value.byteLength + stunPadding(value.byteLength));
  const view = new DataView(attribute.buffer);
  view.setUint16(0, type);
  view.setUint16(2, value.byteLength);
  attribute.set(value, 4);
  return attribute;
}

export function createTurnStunMessage(
  type: number,
  transactionId: Uint8Array,
  attributes: readonly Uint8Array[],
): Uint8Array {
  const body = new Uint8Array(concatBytes(...attributes));
  const header = new Uint8Array(20);
  const view = new DataView(header.buffer);
  view.setUint16(0, type);
  view.setUint16(2, body.byteLength);
  header.set(STUN_COOKIE, 4);
  header.set(transactionId, 8);
  return new Uint8Array(concatBytes(header, body));
}

export function parseTurnErrorCode(data: Uint8Array | undefined): number {
  return data && data.byteLength >= 4 ? ((data[2] ?? 0) & 7) * 100 + (data[3] ?? 0) : 0;
}

function randomTransactionId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

async function addMessageIntegrity(message: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const signedMessage = new Uint8Array(message);
  const view = new DataView(signedMessage.buffer);
  view.setUint16(2, view.getUint16(2) + 24);
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key).buffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, signedMessage));
  return new Uint8Array(
    concatBytes(
      signedMessage,
      createTurnStunAttribute(STUN_ATTRIBUTE.MESSAGE_INTEGRITY, signature),
    ),
  );
}

async function readStunMessage(
  reader: TurnReader,
  bufferedData: Uint8Array | null = null,
  timeoutMessage = 'TURN response timed out',
): Promise<TurnResponse> {
  let buffer = bufferedData?.byteLength ? new Uint8Array(bufferedData) : new Uint8Array(0);
  const pull = async () => {
    const { done, value } = await withTimeout(reader.read(), CONNECT_TIMEOUT_MS, timeoutMessage);
    if (done) throw new Error('TURN server closed connection');
    if (value?.byteLength) buffer = new Uint8Array(concatBytes(buffer, value));
  };
  while (buffer.byteLength < 20) await pull();

  const messageLength = 20 + (((buffer[2] ?? 0) << 8) | (buffer[3] ?? 0));
  if (messageLength > 65_555) throw new Error('TURN response is too large');
  while (buffer.byteLength < messageLength) await pull();
  const messageBuffer = buffer.subarray(0, messageLength);
  if (STUN_COOKIE.some((value, index) => messageBuffer[4 + index] !== value)) {
    throw new Error('Invalid TURN/STUN response');
  }

  const view = new DataView(
    messageBuffer.buffer,
    messageBuffer.byteOffset,
    messageBuffer.byteLength,
  );
  const attributes: TurnAttributes = {};
  for (let offset = 20; offset + 4 <= messageLength; ) {
    const type = view.getUint16(offset);
    const length = view.getUint16(offset + 2);
    if (offset + 4 + length > messageBuffer.byteLength) break;
    attributes[type] = messageBuffer.slice(offset + 4, offset + 4 + length);
    offset += 4 + length + stunPadding(length);
  }
  return {
    message: { type: view.getUint16(0), attributes },
    extraData: buffer.byteLength > messageLength ? buffer.subarray(messageLength) : null,
  };
}

async function writeBytes(
  writer: TurnWriter,
  bytes: Uint8Array,
  timeoutMessage: string,
): Promise<void> {
  await withTimeout(writer.write(bytes), CONNECT_TIMEOUT_MS, timeoutMessage);
}

function releaseLock(lock: { releaseLock(): void } | null): void {
  try {
    lock?.releaseLock();
  } catch {
    // A failed TURN handshake may already have released the lock.
  }
}

export async function turnConnect(
  proxy: ProxyAddress,
  targetHost: string,
  targetPort: number,
  connector: SocketConnector,
  dnsResolver: DnsResolver = resolveDns,
): Promise<Socket> {
  const resolvedTargetHost = stripIPv6Brackets(targetHost);
  let targetIp: string | null = isIPv4(resolvedTargetHost) ? resolvedTargetHost : null;
  if (!targetIp) {
    const records = await dnsResolver(resolvedTargetHost, 'A');
    targetIp =
      records.find((record) => record.type.toUpperCase() === 'A' && isIPv4(record.data))?.data ??
      null;
  }
  if (!targetIp) {
    throw new Error(`Could not resolve ${targetHost} to an IPv4 address for TURN CONNECT`);
  }

  const turnHost = stripIPv6Brackets(proxy.hostname);
  let controlSocket: Socket | null = null;
  let dataSocket: Socket | null = null;
  let controlWriter: TurnWriter | null = null;
  let controlReader: TurnReader | null = null;
  let dataWriter: TurnWriter | null = null;
  let dataReader: TurnReader | null = null;
  let dataReaderReleased = false;
  const close = async () => {
    await Promise.allSettled([controlSocket?.close(), dataSocket?.close()]);
  };
  const releaseDataReader = () => {
    if (dataReaderReleased) return;
    dataReaderReleased = true;
    releaseLock(dataReader);
  };

  try {
    controlSocket = connector.connect(
      { hostname: turnHost, port: proxy.port },
      { allowHalfOpen: true },
    );
    await withTimeout(controlSocket.opened, CONNECT_TIMEOUT_MS, 'TURN server connection timed out');
    controlWriter = controlSocket.writable.getWriter();
    controlReader = controlSocket.readable.getReader();

    const xorPeerAddress = new Uint8Array(8);
    xorPeerAddress[1] = 1;
    new DataView(xorPeerAddress.buffer).setUint16(2, targetPort ^ 0x2112);
    targetIp.split('.').forEach((value, index) => {
      xorPeerAddress[4 + index] = Number(value) ^ (STUN_COOKIE[index] ?? 0);
    });
    const peerAddress = createTurnStunAttribute(STUN_ATTRIBUTE.XOR_PEER_ADDRESS, xorPeerAddress);
    const requestedTransport = new Uint8Array([6, 0, 0, 0]);
    await writeBytes(
      controlWriter,
      createTurnStunMessage(STUN_TYPE.ALLOCATE_REQUEST, randomTransactionId(), [
        createTurnStunAttribute(STUN_ATTRIBUTE.REQUESTED_TRANSPORT, requestedTransport),
      ]),
      'TURN Allocate request timed out',
    );

    let response = await readStunMessage(controlReader, null, 'TURN Allocate response timed out');
    let { message } = response;
    let bufferedData = response.extraData;
    let integrityKey: Uint8Array | null = null;
    let authAttributes: Uint8Array[] = [];
    const sign = (messageToSign: Uint8Array) =>
      integrityKey
        ? addMessageIntegrity(messageToSign, integrityKey)
        : Promise.resolve(messageToSign);

    if (
      message.type === STUN_TYPE.ALLOCATE_ERROR &&
      proxy.username !== undefined &&
      proxy.password !== undefined &&
      parseTurnErrorCode(message.attributes[STUN_ATTRIBUTE.ERROR_CODE]) === 401
    ) {
      const realmBytes = message.attributes[STUN_ATTRIBUTE.REALM];
      const nonce = message.attributes[STUN_ATTRIBUTE.NONCE];
      if (!realmBytes || !nonce?.byteLength) {
        throw new Error('TURN authentication challenge is missing realm or nonce');
      }

      const realm = textDecoder.decode(realmBytes);
      integrityKey = new Uint8Array(
        await crypto.subtle.digest(
          'MD5',
          textEncoder.encode(`${proxy.username}:${realm}:${proxy.password}`),
        ),
      );
      authAttributes = [
        createTurnStunAttribute(STUN_ATTRIBUTE.USERNAME, textEncoder.encode(proxy.username)),
        createTurnStunAttribute(STUN_ATTRIBUTE.REALM, textEncoder.encode(realm)),
        createTurnStunAttribute(STUN_ATTRIBUTE.NONCE, nonce),
      ];

      const allocateRequest = await addMessageIntegrity(
        createTurnStunMessage(STUN_TYPE.ALLOCATE_REQUEST, randomTransactionId(), [
          createTurnStunAttribute(STUN_ATTRIBUTE.REQUESTED_TRANSPORT, requestedTransport),
          ...authAttributes,
        ]),
        integrityKey,
      );
      const pipelined = await Promise.all([
        sign(
          createTurnStunMessage(STUN_TYPE.CREATE_PERMISSION_REQUEST, randomTransactionId(), [
            peerAddress,
            ...authAttributes,
          ]),
        ),
        sign(
          createTurnStunMessage(STUN_TYPE.CONNECT_REQUEST, randomTransactionId(), [
            peerAddress,
            ...authAttributes,
          ]),
        ),
      ]);
      await writeBytes(
        controlWriter,
        new Uint8Array(concatBytes(allocateRequest, ...pipelined)),
        'TURN authenticated Allocate request timed out',
      );
      response = await readStunMessage(
        controlReader,
        bufferedData,
        'TURN authenticated Allocate response timed out',
      );
      message = response.message;
      bufferedData = response.extraData;
    } else if (message.type === STUN_TYPE.ALLOCATE_SUCCESS) {
      const pipelined = await Promise.all([
        sign(
          createTurnStunMessage(STUN_TYPE.CREATE_PERMISSION_REQUEST, randomTransactionId(), [
            peerAddress,
            ...authAttributes,
          ]),
        ),
        sign(
          createTurnStunMessage(STUN_TYPE.CONNECT_REQUEST, randomTransactionId(), [
            peerAddress,
            ...authAttributes,
          ]),
        ),
      ]);
      await writeBytes(
        controlWriter,
        new Uint8Array(concatBytes(...pipelined)),
        'TURN pipelined request timed out',
      );
    }

    if (message.type !== STUN_TYPE.ALLOCATE_SUCCESS) {
      const errorCode = parseTurnErrorCode(message.attributes[STUN_ATTRIBUTE.ERROR_CODE]);
      throw new Error(
        errorCode ? `TURN Allocate failed with ${errorCode}` : 'TURN Allocate failed',
      );
    }

    dataSocket = connector.connect(
      { hostname: turnHost, port: proxy.port },
      { allowHalfOpen: true },
    );
    response = await readStunMessage(
      controlReader,
      bufferedData,
      'TURN CreatePermission response timed out',
    );
    message = response.message;
    bufferedData = response.extraData;
    if (message.type !== STUN_TYPE.CREATE_PERMISSION_SUCCESS) {
      throw new Error('TURN CreatePermission failed');
    }

    response = await readStunMessage(
      controlReader,
      bufferedData,
      'TURN CONNECT response timed out',
    );
    message = response.message;
    const connectionId = message.attributes[STUN_ATTRIBUTE.CONNECTION_ID];
    if (message.type !== STUN_TYPE.CONNECT_SUCCESS || !connectionId) {
      throw new Error('TURN CONNECT failed');
    }

    await withTimeout(dataSocket.opened, CONNECT_TIMEOUT_MS, 'TURN data connection timed out');
    dataWriter = dataSocket.writable.getWriter();
    dataReader = dataSocket.readable.getReader();
    await writeBytes(
      dataWriter,
      await sign(
        createTurnStunMessage(STUN_TYPE.CONNECTION_BIND_REQUEST, randomTransactionId(), [
          createTurnStunAttribute(STUN_ATTRIBUTE.CONNECTION_ID, connectionId),
          ...authAttributes,
        ]),
      ),
      'TURN ConnectionBind request timed out',
    );

    response = await readStunMessage(dataReader, null, 'TURN ConnectionBind response timed out');
    message = response.message;
    const extraPayload = response.extraData;
    if (message.type !== STUN_TYPE.CONNECTION_BIND_SUCCESS) {
      throw new Error('TURN ConnectionBind failed');
    }

    releaseLock(controlWriter);
    controlWriter = null;
    releaseLock(controlReader);
    controlReader = null;
    releaseLock(dataWriter);
    dataWriter = null;

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        if (extraPayload?.byteLength) controller.enqueue(extraPayload);
      },
      async pull(controller) {
        const result = await dataReader!.read();
        if (result.done) {
          releaseDataReader();
          controller.close();
        } else if (result.value?.byteLength) {
          controller.enqueue(new Uint8Array(result.value));
        }
      },
      async cancel() {
        try {
          await dataReader?.cancel();
        } finally {
          releaseDataReader();
          await close();
        }
      },
    });

    const result: Socket = {
      readable,
      writable: dataSocket.writable,
      closed: dataSocket.closed,
      opened: Promise.resolve({}),
      upgraded: false,
      secureTransport: 'off',
      close,
      startTls() {
        throw new Error('TURN tunnel does not support startTls');
      },
    };
    return result;
  } catch (error) {
    releaseLock(controlWriter);
    releaseLock(controlReader);
    releaseLock(dataWriter);
    releaseDataReader();
    await close();
    throw error;
  }
}
