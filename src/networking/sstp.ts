import type { ProxyAddress } from '../app/types';
import { concatBytes } from '../shared/bytes';
import { resolveDns, type DnsAnswer } from './dns';
import { isIPv4, stripIPv6Brackets } from './proxy-connectors';
import type { SocketConnector } from './sockets';

const CONNECT_TIMEOUT_MS = 10_000;
const TCP_MSS = 1400;
const EMPTY_BYTES = new Uint8Array(0);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type DnsResolver = (domain: string, recordType: string) => Promise<DnsAnswer[]>;
type Reader = ReadableStreamDefaultReader<Uint8Array>;
type Writer = WritableStreamDefaultWriter<Uint8Array>;

interface PppOption {
  type: number;
  data: Uint8Array;
}

interface ParsedPppFrame {
  protocol: number;
  ipPacket?: Uint8Array;
  code?: number;
  id?: number;
  payload?: Uint8Array;
  rawPacket?: Uint8Array;
}

export function readSstpUint16(bytes: Uint8Array, offset = 0): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

export function readSstpUint32(bytes: Uint8Array, offset = 0): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function randomUint16(): number {
  return readSstpUint16(crypto.getRandomValues(new Uint8Array(2)));
}

export function internetChecksum(bytes: Uint8Array, offset: number, length: number): number {
  let sum = 0;
  for (let index = offset; index < offset + length - 1; index += 2) {
    sum += readSstpUint16(bytes, index);
  }
  if (length & 1) sum += (bytes[offset + length - 1] ?? 0) << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
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

export function buildSstpDataPacket(pppFrame: Uint8Array): Uint8Array {
  const packetLength = 6 + pppFrame.byteLength;
  const packet = new Uint8Array(packetLength);
  packet.set([0x10, 0, ((packetLength >> 8) & 0x0f) | 0x80, packetLength & 0xff, 0xff, 3]);
  packet.set(pppFrame, 6);
  return packet;
}

function buildPppConfigurePacket(
  protocol: number,
  code: number,
  id: number,
  options: readonly PppOption[] = [],
): Uint8Array {
  const optionsLength = options.reduce((size, option) => size + 2 + option.data.byteLength, 0);
  const frame = new Uint8Array(6 + optionsLength);
  const view = new DataView(frame.buffer);
  view.setUint16(0, protocol);
  frame[2] = code;
  frame[3] = id;
  view.setUint16(4, 4 + optionsLength);
  options.reduce((offset, option) => {
    frame[offset] = option.type;
    frame[offset + 1] = 2 + option.data.byteLength;
    frame.set(option.data, offset + 2);
    return offset + 2 + option.data.byteLength;
  }, 6);
  return frame;
}

function parsePppFrame(data: Uint8Array): ParsedPppFrame | null {
  const offset = data.byteLength >= 2 && data[0] === 0xff && data[1] === 3 ? 2 : 0;
  if (data.byteLength - offset < 4) return null;
  const protocol = readSstpUint16(data, offset);
  if (protocol === 0x0021) return { protocol, ipPacket: data.subarray(offset + 2) };
  if (data.byteLength - offset < 6) return null;
  return {
    protocol,
    code: data[offset + 2] ?? 0,
    id: data[offset + 3] ?? 0,
    payload: data.subarray(offset + 6),
    rawPacket: data.subarray(offset),
  };
}

function parsePppOptions(data: Uint8Array): PppOption[] {
  const options: PppOption[] = [];
  for (let offset = 0; offset + 2 <= data.byteLength; ) {
    const type = data[offset] ?? 0;
    const length = data[offset + 1] ?? 0;
    if (length < 2 || offset + length > data.byteLength) break;
    options.push({ type, data: data.subarray(offset + 2, offset + length) });
    offset += length;
  }
  return options;
}

function releaseLock(lock: { releaseLock(): void } | null): void {
  try {
    lock?.releaseLock();
  } catch {
    // A failed SSTP handshake may already have released the lock.
  }
}

export async function sstpConnect(
  proxy: ProxyAddress,
  targetHost: string,
  targetPort: number,
  connector: SocketConnector,
  dnsResolver: DnsResolver = resolveDns,
): Promise<Socket> {
  let bufferedBytes: Uint8Array<ArrayBufferLike> = EMPTY_BYTES;
  let pppIdentifier = 1;
  let socket: Socket | null = null;
  let reader: Reader | null = null;
  let writer: Writer | null = null;
  let closing = false;
  let closedSettled = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (reason?: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const settleClosed = (settle: (value?: unknown) => void, value?: unknown) => {
    if (closedSettled) return;
    closedSettled = true;
    settle(value);
  };
  const close = async () => {
    closing = true;
    try {
      await reader?.cancel();
    } catch {
      // Best-effort tunnel shutdown.
    }
    releaseLock(reader);
    try {
      await writer?.close();
    } catch {
      // Best-effort tunnel shutdown.
    }
    releaseLock(writer);
    try {
      await socket?.close();
    } catch {
      // Best-effort tunnel shutdown.
    }
    settleClosed(resolveClosed);
  };

  const readSocketChunk = async (): Promise<Uint8Array> => {
    const { value, done } = await reader!.read();
    if (done || !value) throw new Error('SSTP socket closed');
    return new Uint8Array(value);
  };
  const readBytes = async (length: number): Promise<Uint8Array> => {
    while (bufferedBytes.byteLength < length) {
      const chunk = await readSocketChunk();
      bufferedBytes = bufferedBytes.byteLength
        ? new Uint8Array(concatBytes(bufferedBytes, chunk))
        : chunk;
    }
    const result = bufferedBytes.subarray(0, length);
    bufferedBytes = bufferedBytes.subarray(length);
    return result;
  };
  const readHttpLine = async (): Promise<string> => {
    while (true) {
      const lineEnd = bufferedBytes.indexOf(10);
      if (lineEnd >= 0) {
        const line = textDecoder.decode(bufferedBytes.subarray(0, lineEnd));
        bufferedBytes = bufferedBytes.subarray(lineEnd + 1);
        return line.replace(/\r$/, '');
      }
      const chunk = await readSocketChunk();
      bufferedBytes = bufferedBytes.byteLength
        ? new Uint8Array(concatBytes(bufferedBytes, chunk))
        : chunk;
    }
  };
  const readPacket = async (timeoutMs = CONNECT_TIMEOUT_MS) => {
    const header = await withTimeout(readBytes(4), timeoutMs, 'SSTP read timeout');
    const length = readSstpUint16(header, 2) & 0x0fff;
    if (length < 4) throw new Error('Invalid SSTP packet length');
    return {
      isControl: ((header[1] ?? 0) & 1) !== 0,
      body:
        length > 4
          ? await withTimeout(readBytes(length - 4), timeoutMs, 'SSTP packet body read timeout')
          : EMPTY_BYTES,
    };
  };

  try {
    const serverHost = stripIPv6Brackets(proxy.hostname);
    const serverPort = proxy.port;
    socket = connector.connect(
      { hostname: serverHost, port: serverPort },
      { secureTransport: 'on', allowHalfOpen: false },
    );
    await withTimeout(socket.opened, CONNECT_TIMEOUT_MS, 'SSTP server connection timed out');
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();

    const displayHost = serverHost.includes(':') ? `[${serverHost}]` : serverHost;
    const httpRequest = textEncoder.encode(
      `SSTP_DUPLEX_POST /sra_{BA195980-CD49-458b-9E23-C84EE0ADCD75}/ HTTP/1.1\r\n` +
        `Host: ${serverPort === 443 ? displayHost : `${displayHost}:${serverPort}`}\r\n` +
        'Content-Length: 18446744073709551615\r\n' +
        `SSTPCORRELATIONID: {${crypto.randomUUID()}}\r\n\r\n`,
    );
    const encapsulatedProtocol = new Uint8Array(2);
    new DataView(encapsulatedProtocol.buffer).setUint16(0, 1);
    const maximumReceiveUnit = new Uint8Array(2);
    new DataView(maximumReceiveUnit.buffer).setUint16(0, 1500);
    const connectRequest = new Uint8Array(12 + encapsulatedProtocol.byteLength);
    const connectView = new DataView(connectRequest.buffer);
    connectRequest[0] = 0x10;
    connectRequest[1] = 1;
    connectView.setUint16(2, connectRequest.byteLength | 0x8000);
    connectView.setUint16(4, 1);
    connectView.setUint16(6, 1);
    connectRequest[9] = 1;
    connectView.setUint16(10, 4 + encapsulatedProtocol.byteLength);
    connectRequest.set(encapsulatedProtocol, 12);

    await withTimeout(
      writer.write(
        new Uint8Array(
          concatBytes(
            httpRequest,
            connectRequest,
            buildSstpDataPacket(
              buildPppConfigurePacket(0xc021, 1, pppIdentifier++, [
                { type: 1, data: maximumReceiveUnit },
              ]),
            ),
          ),
        ),
      ),
      CONNECT_TIMEOUT_MS,
      'SSTP HTTP handshake request timed out',
    );

    const statusLine = await withTimeout(
      readHttpLine(),
      CONNECT_TIMEOUT_MS,
      'SSTP HTTP handshake timed out',
    );
    while (
      (await withTimeout(readHttpLine(), CONNECT_TIMEOUT_MS, 'SSTP HTTP header read timed out')) !==
      ''
    ) {
      // Consume response headers.
    }
    if (!/HTTP\/\d(?:\.\d)?\s+2\d\d/i.test(statusLine)) {
      throw new Error(`SSTP HTTP handshake failed: ${statusLine || 'invalid status'}`);
    }

    let localLcpAcked = false;
    let peerLcpAcked = false;
    let papRequired = false;
    let papSent = false;
    let papDone = false;
    let ipcpStarted = false;
    let ipcpFinished = false;
    let sourceIp: string | null = null;
    const sendPapIfReady = async () => {
      if (!localLcpAcked || !peerLcpAcked || !papRequired || papSent) return;
      if (proxy.username === undefined || proxy.password === undefined) {
        throw new Error('SSTP server requires PAP authentication');
      }
      const username = textEncoder.encode(proxy.username);
      const password = textEncoder.encode(proxy.password);
      if (username.byteLength > 255 || password.byteLength > 255) {
        throw new Error('SSTP username/password is too long');
      }
      const papLength = 6 + username.byteLength + password.byteLength;
      const frame = new Uint8Array(2 + papLength);
      const view = new DataView(frame.buffer);
      view.setUint16(0, 0xc023);
      frame[2] = 1;
      frame[3] = pppIdentifier++;
      view.setUint16(4, papLength);
      frame[6] = username.byteLength;
      frame.set(username, 7);
      frame[7 + username.byteLength] = password.byteLength;
      frame.set(password, 8 + username.byteLength);
      await withTimeout(
        writer!.write(buildSstpDataPacket(frame)),
        CONNECT_TIMEOUT_MS,
        'SSTP PAP authentication request timed out',
      );
      papSent = true;
    };
    const startIpcpIfReady = async () => {
      if (!localLcpAcked || !peerLcpAcked || ipcpStarted || (papRequired && !papDone)) return;
      await withTimeout(
        writer!.write(
          buildSstpDataPacket(
            buildPppConfigurePacket(0x8021, 1, pppIdentifier++, [
              { type: 3, data: new Uint8Array(4) },
            ]),
          ),
        ),
        CONNECT_TIMEOUT_MS,
        'SSTP IPCP request timed out',
      );
      ipcpStarted = true;
    };

    for (let round = 0; round < 50 && !ipcpFinished; round++) {
      const packet = await readPacket();
      if (packet.isControl) continue;
      const ppp = parsePppFrame(packet.body);
      if (!ppp) continue;

      if (ppp.protocol === 0xc021) {
        if (ppp.code === 1) {
          const authOption = parsePppOptions(ppp.payload!).find((option) => option.type === 3);
          if (authOption?.data.byteLength && authOption.data.byteLength >= 2) {
            const authProtocol = readSstpUint16(authOption.data);
            if (authProtocol !== 0xc023) {
              throw new Error(
                `SSTP unsupported PPP authentication protocol: 0x${authProtocol.toString(16)}`,
              );
            }
            papRequired = true;
          }
          const ack = new Uint8Array(ppp.rawPacket!);
          ack[2] = 2;
          await withTimeout(
            writer.write(buildSstpDataPacket(ack)),
            CONNECT_TIMEOUT_MS,
            'SSTP LCP Configure-Ack timed out',
          );
          peerLcpAcked = true;
          await sendPapIfReady();
          await startIpcpIfReady();
        } else if (ppp.code === 2) {
          localLcpAcked = true;
          await sendPapIfReady();
          await startIpcpIfReady();
        }
        continue;
      }

      if (ppp.protocol === 0xc023) {
        if (ppp.code === 2) {
          papDone = true;
          await startIpcpIfReady();
        } else if (ppp.code === 3) {
          throw new Error('SSTP PAP authentication failed');
        }
        continue;
      }

      if (ppp.protocol === 0x8021) {
        if (ppp.code === 1) {
          const ack = new Uint8Array(ppp.rawPacket!);
          ack[2] = 2;
          await withTimeout(
            writer.write(buildSstpDataPacket(ack)),
            CONNECT_TIMEOUT_MS,
            'SSTP IPCP Configure-Ack timed out',
          );
          await startIpcpIfReady();
        } else if (ppp.code === 3) {
          const addressOption = parsePppOptions(ppp.payload!).find((option) => option.type === 3);
          if (addressOption?.data.byteLength === 4) {
            sourceIp = [...addressOption.data].join('.');
            await withTimeout(
              writer.write(
                buildSstpDataPacket(
                  buildPppConfigurePacket(0x8021, 1, pppIdentifier++, [
                    { type: 3, data: addressOption.data },
                  ]),
                ),
              ),
              CONNECT_TIMEOUT_MS,
              'SSTP IPCP address request timed out',
            );
            ipcpStarted = true;
          }
        } else if (ppp.code === 2) {
          const addressOption = parsePppOptions(ppp.payload!).find((option) => option.type === 3);
          if (addressOption?.data.byteLength === 4) {
            sourceIp = [...addressOption.data].join('.');
          }
          ipcpFinished = true;
        }
      }
    }
    if (!sourceIp) throw new Error('SSTP did not assign an IPv4 address');

    const target = stripIPv6Brackets(targetHost);
    let targetIp: string | null = isIPv4(target) ? target : null;
    if (!targetIp) {
      const records = await dnsResolver(target, 'A');
      targetIp =
        records.find((record) => record.type.toUpperCase() === 'A' && isIPv4(record.data))?.data ??
        null;
    }
    if (!targetIp) {
      throw new Error(`Could not resolve ${targetHost} to an IPv4 address for SSTP`);
    }

    const sourcePort = 10_000 + (randomUint16() % 50_000);
    const sourceAddress = new Uint8Array(sourceIp.split('.').map(Number));
    const destinationAddress = new Uint8Array(targetIp.split('.').map(Number));
    let sequenceNumber = readSstpUint32(crypto.getRandomValues(new Uint8Array(4)));
    let acknowledgementNumber = 0;
    const ipHeaderTemplate = new Uint8Array(20);
    ipHeaderTemplate.set([0x45, 0, 0, 0, 0, 0, 0x40, 0, 64, 6]);
    ipHeaderTemplate.set(sourceAddress, 12);
    ipHeaderTemplate.set(destinationAddress, 16);
    const tcpPseudoHeader = new Uint8Array(1432);
    tcpPseudoHeader.set(sourceAddress);
    tcpPseudoHeader.set(destinationAddress, 4);
    tcpPseudoHeader[9] = 6;
    const buildTcpFrame = (flags: number, payload = EMPTY_BYTES): Uint8Array => {
      const bytes = new Uint8Array(payload);
      const payloadLength = bytes.byteLength;
      const tcpLength = 20 + payloadLength;
      const ipLength = 20 + tcpLength;
      const sstpLength = 8 + ipLength;
      const frame = new Uint8Array(sstpLength);
      const view = new DataView(frame.buffer);
      frame.set([0x10, 0, ((sstpLength >> 8) & 0x0f) | 0x80, sstpLength & 0xff, 0xff, 3, 0, 0x21]);
      frame.set(ipHeaderTemplate, 8);
      view.setUint16(10, ipLength);
      view.setUint16(12, randomUint16());
      view.setUint16(18, internetChecksum(frame, 8, 20));
      view.setUint16(28, sourcePort);
      view.setUint16(30, targetPort);
      view.setUint32(32, sequenceNumber);
      view.setUint32(36, acknowledgementNumber);
      frame[40] = 0x50;
      frame[41] = flags;
      view.setUint16(42, 65_535);
      if (payloadLength) frame.set(bytes, 48);
      tcpPseudoHeader[10] = tcpLength >> 8;
      tcpPseudoHeader[11] = tcpLength & 0xff;
      tcpPseudoHeader.set(frame.subarray(28, 28 + tcpLength), 12);
      view.setUint16(44, internetChecksum(tcpPseudoHeader, 0, 12 + tcpLength));
      return frame;
    };
    const matchIncomingIpPacket = (ipPacket: Uint8Array) => {
      if (ipPacket.byteLength < 40 || ipPacket[9] !== 6) return null;
      const ipHeaderLength = ((ipPacket[0] ?? 0) & 0x0f) * 4;
      if (ipPacket.byteLength < ipHeaderLength + 20) return null;
      if (readSstpUint16(ipPacket, ipHeaderLength) !== targetPort) return null;
      if (readSstpUint16(ipPacket, ipHeaderLength + 2) !== sourcePort) return null;
      return {
        flags: ipPacket[ipHeaderLength + 13] ?? 0,
        sequence: readSstpUint32(ipPacket, ipHeaderLength + 4),
        payloadOffset: ipHeaderLength + (((ipPacket[ipHeaderLength + 12] ?? 0) >> 4) & 0x0f) * 4,
      };
    };

    await withTimeout(
      writer.write(buildTcpFrame(2)),
      CONNECT_TIMEOUT_MS,
      'SSTP TCP SYN write timed out',
    );
    sequenceNumber = (sequenceNumber + 1) >>> 0;
    let tcpReady = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const packet = await readPacket();
      if (packet.isControl) continue;
      const ppp = parsePppFrame(packet.body);
      if (!ppp?.ipPacket || ppp.protocol !== 0x0021) continue;
      const tcp = matchIncomingIpPacket(ppp.ipPacket);
      if (!tcp || (tcp.flags & 0x12) !== 0x12) continue;
      acknowledgementNumber = (tcp.sequence + 1) >>> 0;
      await withTimeout(
        writer.write(buildTcpFrame(0x10)),
        CONNECT_TIMEOUT_MS,
        'SSTP TCP ACK write timed out',
      );
      tcpReady = true;
      break;
    }
    if (!tcpReady) throw new Error('TCP handshake through SSTP timed out');

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      async cancel() {
        await close();
      },
    });
    const activeStreamController = () => {
      if (!streamController) throw new Error('SSTP readable stream is not ready');
      return streamController as ReadableStreamDefaultController<Uint8Array>;
    };

    void (async () => {
      try {
        let pendingChunks: Uint8Array[] = [];
        let pendingLength = 0;
        const flush = () => {
          if (!pendingLength) return;
          activeStreamController().enqueue(
            pendingChunks.length === 1
              ? pendingChunks[0]!
              : new Uint8Array(concatBytes(...pendingChunks)),
          );
          pendingChunks = [];
          pendingLength = 0;
          void writer!.write(buildTcpFrame(0x10)).catch(() => undefined);
        };

        while (true) {
          const packet = await readPacket(60_000);
          if (packet.isControl) continue;
          const ppp = parsePppFrame(packet.body);
          if (!ppp?.ipPacket || ppp.protocol !== 0x0021) continue;
          const incoming = matchIncomingIpPacket(ppp.ipPacket);
          if (!incoming) continue;

          if (incoming.payloadOffset < ppp.ipPacket.byteLength) {
            const payload = ppp.ipPacket.subarray(incoming.payloadOffset);
            if (payload.byteLength) {
              acknowledgementNumber = (incoming.sequence + payload.byteLength) >>> 0;
              pendingChunks.push(new Uint8Array(payload));
              pendingLength += payload.byteLength;
            }
          }

          if (incoming.flags & 1) {
            flush();
            acknowledgementNumber = (acknowledgementNumber + 1) >>> 0;
            void writer!.write(buildTcpFrame(0x11)).catch(() => undefined);
            activeStreamController().close();
            await close();
            return;
          }
          if (bufferedBytes.byteLength < 4 || pendingLength >= 32_768) flush();
        }
      } catch (error) {
        if (closing) {
          settleClosed(resolveClosed);
          return;
        }
        try {
          activeStreamController().error(error);
        } catch {
          // Stream may already be closed.
        }
        settleClosed(rejectClosed, error);
        try {
          await socket?.close();
        } catch {
          // Best-effort tunnel shutdown.
        }
      }
    })();

    const writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        const bytes = new Uint8Array(chunk);
        if (!bytes.byteLength) return;
        if (bytes.byteLength <= TCP_MSS) {
          await writer!.write(buildTcpFrame(0x18, bytes));
          sequenceNumber = (sequenceNumber + bytes.byteLength) >>> 0;
          return;
        }
        const frames: Uint8Array[] = [];
        for (let offset = 0; offset < bytes.byteLength; offset += TCP_MSS) {
          const segment = bytes.subarray(offset, Math.min(offset + TCP_MSS, bytes.byteLength));
          frames.push(buildTcpFrame(0x18, segment));
          sequenceNumber = (sequenceNumber + segment.byteLength) >>> 0;
        }
        await writer!.write(new Uint8Array(concatBytes(...frames)));
      },
      async close() {
        await writer!.write(buildTcpFrame(0x11));
      },
      async abort(error) {
        await close();
        if (error) settleClosed(rejectClosed, error);
      },
    });

    const result: Socket = {
      readable,
      writable,
      closed,
      opened: Promise.resolve({}),
      upgraded: false,
      secureTransport: 'off',
      close,
      startTls() {
        throw new Error('SSTP tunnel does not support startTls');
      },
    };
    return result;
  } catch (error) {
    await close();
    throw error;
  }
}
