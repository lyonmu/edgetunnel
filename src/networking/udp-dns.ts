import type { TransportBridge } from '../transports/bridge';
import { concatBytes } from '../shared/bytes';
import { cloudflareSocketConnector, type SocketConnector } from './sockets';

const DNS_SERVER = { hostname: '8.8.4.4', port: 53 } as const;
const DNS_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DNS_TIMEOUT_MS = 10_000;

export type DnsQuery = (payload: Uint8Array) => Promise<Uint8Array>;
type DnsFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), DNS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function queryDnsTcp(
  payload: Uint8Array,
  connector: SocketConnector = cloudflareSocketConnector,
): Promise<Uint8Array> {
  if (payload.byteLength > 65_535) throw new Error('DNS query is too large');
  const socket = connector.connect(DNS_SERVER, { allowHalfOpen: false });
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    await withTimeout(socket.opened, 'DNS upstream connection timed out');
    const framed = new Uint8Array(payload.byteLength + 2);
    new DataView(framed.buffer).setUint16(0, payload.byteLength);
    framed.set(payload, 2);
    writer = socket.writable.getWriter();
    await withTimeout(writer.write(framed), 'DNS upstream write timed out');
    writer.releaseLock();
    writer = null;

    reader = socket.readable.getReader();
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    while (pending.byteLength < 2) {
      const result = await withTimeout(reader.read(), 'DNS upstream response timed out');
      if (result.done) throw new Error('DNS upstream closed before response');
      if (result.value?.byteLength) {
        pending = new Uint8Array(concatBytes(pending, result.value));
      }
    }
    const responseLength = ((pending[0] ?? 0) << 8) | (pending[1] ?? 0);
    while (pending.byteLength < responseLength + 2) {
      const result = await withTimeout(reader.read(), 'DNS upstream response timed out');
      if (result.done) throw new Error('DNS upstream returned a truncated response');
      if (result.value?.byteLength) {
        pending = new Uint8Array(concatBytes(pending, result.value));
      }
    }
    return new Uint8Array(pending.slice(2, responseLength + 2));
  } finally {
    try {
      await reader?.cancel();
    } catch {
      // Best-effort query cleanup.
    }
    try {
      reader?.releaseLock();
    } catch {
      // Reader may already be released.
    }
    try {
      writer?.releaseLock();
    } catch {
      // Writer may already be released.
    }
    await socket.close().catch(() => undefined);
  }
}

export async function queryDnsDoh(
  payload: Uint8Array,
  fetcher: DnsFetcher = fetch,
): Promise<Uint8Array> {
  if (!payload.byteLength) throw new Error('DNS query is empty');
  const response = await withTimeout(
    fetcher(DNS_DOH_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/dns-message',
        'Content-Type': 'application/dns-message',
      },
      body: new Uint8Array(payload),
    }),
    'DNS-over-HTTPS query timed out',
  );
  if (!response.ok) {
    throw new Error(`DNS-over-HTTPS query failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function dnsFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.byteLength + 2);
  new DataView(frame.buffer).setUint16(0, payload.byteLength);
  frame.set(payload, 2);
  return frame;
}

function send(bridge: TransportBridge, payload: Uint8Array): void {
  if (bridge.readyState === WebSocket.OPEN && payload.byteLength) bridge.send(payload);
}

export function createDnsUdpSession(
  protocol: 'vless' | 'trojan',
  bridge: TransportBridge,
  responseHeader: Uint8Array | null,
  query: DnsQuery = queryDnsDoh,
) {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let header = responseHeader;

  const sendResponse = (payload: Uint8Array) => {
    const framed = dnsFrame(payload);
    if (!header) {
      send(bridge, framed);
      return;
    }
    send(bridge, new Uint8Array(concatBytes(header, framed)));
    header = null;
  };

  const processVless = async () => {
    while (pending.byteLength >= 2) {
      const length = ((pending[0] ?? 0) << 8) | (pending[1] ?? 0);
      if (pending.byteLength < length + 2) return;
      const payload = new Uint8Array(pending.slice(2, length + 2));
      pending = pending.slice(length + 2);
      sendResponse(await query(payload));
    }
  };

  const processTrojan = async () => {
    while (pending.byteLength > 0) {
      const addressType = pending[0];
      let addressLength: number;
      if (addressType === 1) {
        addressLength = 4;
      } else if (addressType === 4) {
        addressLength = 16;
      } else if (addressType === 3) {
        if (pending.byteLength < 2) return;
        addressLength = 1 + (pending[1] ?? 0);
      } else {
        throw new Error(`invalid trojan udp addressType: ${addressType}`);
      }

      const portOffset = 1 + addressLength;
      if (pending.byteLength < portOffset + 6) return;
      const port = ((pending[portOffset] ?? 0) << 8) | (pending[portOffset + 1] ?? 0);
      if (port !== 53) throw new Error('UDP is not supported');
      const payloadLength = ((pending[portOffset + 2] ?? 0) << 8) | (pending[portOffset + 3] ?? 0);
      if (pending[portOffset + 4] !== 13 || pending[portOffset + 5] !== 10) {
        throw new Error('invalid trojan udp delimiter');
      }
      const payloadOffset = portOffset + 6;
      if (pending.byteLength < payloadOffset + payloadLength) return;

      const addressAndPort = new Uint8Array(pending.slice(0, portOffset + 2));
      let payload = new Uint8Array(pending.slice(payloadOffset, payloadOffset + payloadLength));
      pending = pending.slice(payloadOffset + payloadLength);
      if (
        payload.byteLength >= 2 &&
        (((payload[0] ?? 0) << 8) | (payload[1] ?? 0)) === payload.byteLength - 2
      ) {
        payload = payload.slice(2);
      }
      if (!payload.byteLength) continue;

      const response = await query(payload);
      const frame = new Uint8Array(addressAndPort.byteLength + response.byteLength + 4);
      frame.set(addressAndPort);
      new DataView(frame.buffer).setUint16(addressAndPort.byteLength, response.byteLength);
      frame[addressAndPort.byteLength + 2] = 13;
      frame[addressAndPort.byteLength + 3] = 10;
      frame.set(response, addressAndPort.byteLength + 4);
      send(bridge, frame);
    }
  };

  return {
    async push(chunk: Uint8Array): Promise<void> {
      if (chunk.byteLength) pending = new Uint8Array(concatBytes(pending, chunk));
      if (protocol === 'vless') await processVless();
      else await processTrojan();
    },
  };
}
