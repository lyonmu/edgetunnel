import { concatBytes } from '../shared/bytes';

const XUDP_STATUS_NEW = 1;
const XUDP_STATUS_KEEP = 2;
const XUDP_OPTION_DATA = 1;
const XUDP_NETWORK_UDP = 2;
const XUDP_GLOBAL_ID_LENGTH = 8;

export interface XudpDestination {
  hostname: string;
  port: number;
  addressType: 1 | 2 | 3;
  addressBytes: Uint8Array;
}

export interface XudpDatagram {
  status: 'new' | 'keep';
  destination: XudpDestination;
  globalId?: Uint8Array;
  payload: Uint8Array;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('XUDP port is invalid');
  }
}

function encodeAddress(destination: XudpDestination): Uint8Array {
  const { addressType, addressBytes } = destination;
  if (addressType === 1 && addressBytes.byteLength !== 4) {
    throw new Error('XUDP IPv4 address is invalid');
  }
  if (addressType === 3 && addressBytes.byteLength !== 16) {
    throw new Error('XUDP IPv6 address is invalid');
  }
  if (addressType === 2) {
    if (!addressBytes.byteLength || addressBytes.byteLength > 255) {
      throw new Error('XUDP domain address is invalid');
    }
    return new Uint8Array([addressType, addressBytes.byteLength, ...addressBytes]);
  }
  return new Uint8Array([addressType, ...addressBytes]);
}

export function encodeXudpDatagram(datagram: XudpDatagram): Uint8Array {
  validatePort(datagram.destination.port);
  if (datagram.payload.byteLength > 65_535) throw new Error('XUDP payload is too large');

  const address = encodeAddress(datagram.destination);
  const isNew = datagram.status === 'new';
  if (isNew && datagram.globalId?.byteLength !== XUDP_GLOBAL_ID_LENGTH) {
    throw new Error('XUDP New frame requires an 8-byte global ID');
  }
  if (!isNew && datagram.globalId) {
    throw new Error('XUDP Keep frame cannot contain a global ID');
  }

  const metadataLength = 7 + address.byteLength + (isNew ? XUDP_GLOBAL_ID_LENGTH : 0);
  const frame = new Uint8Array(2 + metadataLength + 2 + datagram.payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint16(0, metadataLength);
  frame[2] = 0;
  frame[3] = 0;
  frame[4] = isNew ? XUDP_STATUS_NEW : XUDP_STATUS_KEEP;
  frame[5] = XUDP_OPTION_DATA;
  frame[6] = XUDP_NETWORK_UDP;
  view.setUint16(7, datagram.destination.port);
  frame.set(address, 9);
  let cursor = 9 + address.byteLength;
  if (isNew) {
    frame.set(datagram.globalId!, cursor);
    cursor += XUDP_GLOBAL_ID_LENGTH;
  }
  view.setUint16(cursor, datagram.payload.byteLength);
  frame.set(datagram.payload, cursor + 2);
  return frame;
}

function ipv6Hostname(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let index = 0; index < bytes.byteLength; index += 2) {
    groups.push(((bytes[index]! << 8) | bytes[index + 1]!).toString(16));
  }
  return groups.join(':');
}

function decodeAddress(
  metadata: Uint8Array,
  cursor: number,
): { destination: Omit<XudpDestination, 'port'>; cursor: number } {
  const addressType = metadata[cursor] as 1 | 2 | 3 | undefined;
  cursor += 1;
  let addressBytes: Uint8Array;

  if (addressType === 1) {
    if (metadata.byteLength < cursor + 4) throw new Error('XUDP IPv4 address is truncated');
    addressBytes = metadata.slice(cursor, cursor + 4);
    cursor += 4;
  } else if (addressType === 2) {
    const length = metadata[cursor];
    if (!length || metadata.byteLength < cursor + 1 + length) {
      throw new Error('XUDP domain address is truncated');
    }
    cursor += 1;
    addressBytes = metadata.slice(cursor, cursor + length);
    cursor += length;
  } else if (addressType === 3) {
    if (metadata.byteLength < cursor + 16) throw new Error('XUDP IPv6 address is truncated');
    addressBytes = metadata.slice(cursor, cursor + 16);
    cursor += 16;
  } else {
    throw new Error(`XUDP address type is invalid: ${addressType}`);
  }

  const hostname =
    addressType === 1
      ? Array.from(addressBytes).join('.')
      : addressType === 2
        ? new TextDecoder().decode(addressBytes)
        : ipv6Hostname(addressBytes);
  return { destination: { hostname, addressType, addressBytes }, cursor };
}

export class XudpDecoder {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(private readonly maxBufferedBytes = 65_535) {}

  push(chunk: Uint8Array): XudpDatagram[] {
    if (this.pending.byteLength + chunk.byteLength > this.maxBufferedBytes) {
      throw new Error('XUDP 缓冲区超过上限');
    }
    if (chunk.byteLength) this.pending = new Uint8Array(concatBytes(this.pending, chunk));

    const datagrams: XudpDatagram[] = [];
    while (this.pending.byteLength >= 2) {
      const metadataLength = ((this.pending[0] ?? 0) << 8) | (this.pending[1] ?? 0);
      if (metadataLength < 8) throw new Error('XUDP metadata is invalid');
      if (this.pending.byteLength < metadataLength + 4) break;

      const payloadLengthOffset = 2 + metadataLength;
      const payloadLength =
        ((this.pending[payloadLengthOffset] ?? 0) << 8) |
        (this.pending[payloadLengthOffset + 1] ?? 0);
      const frameLength = payloadLengthOffset + 2 + payloadLength;
      if (frameLength > this.maxBufferedBytes) throw new Error('XUDP 帧超过上限');
      if (this.pending.byteLength < frameLength) break;

      const metadata = this.pending.slice(2, payloadLengthOffset);
      if (metadata[0] !== 0 || metadata[1] !== 0) {
        throw new Error('XUDP session ID must be zero');
      }
      const statusByte = metadata[2];
      if (statusByte !== XUDP_STATUS_NEW && statusByte !== XUDP_STATUS_KEEP) {
        throw new Error('XUDP status is invalid');
      }
      if (metadata[3] !== XUDP_OPTION_DATA) throw new Error('XUDP option is invalid');
      if (metadata[4] !== XUDP_NETWORK_UDP) throw new Error('XUDP only supports UDP');

      const port = ((metadata[5] ?? 0) << 8) | (metadata[6] ?? 0);
      validatePort(port);
      const decoded = decodeAddress(metadata, 7);
      let cursor = decoded.cursor;
      let globalId: Uint8Array | undefined;
      if (statusByte === XUDP_STATUS_NEW) {
        if (metadata.byteLength < cursor + XUDP_GLOBAL_ID_LENGTH) {
          throw new Error('XUDP global ID is truncated');
        }
        globalId = metadata.slice(cursor, cursor + XUDP_GLOBAL_ID_LENGTH);
        cursor += XUDP_GLOBAL_ID_LENGTH;
      }
      if (cursor !== metadata.byteLength) throw new Error('XUDP metadata length is invalid');

      const datagram: XudpDatagram = {
        status: statusByte === XUDP_STATUS_NEW ? 'new' : 'keep',
        destination: { ...decoded.destination, port },
        payload: this.pending.slice(payloadLengthOffset + 2, frameLength),
      };
      if (globalId) datagram.globalId = globalId;
      datagrams.push(datagram);
      this.pending = this.pending.slice(frameLength);
    }
    return datagrams;
  }

  finish(): void {
    if (this.pending.byteLength) throw new Error('XUDP 帧残缺');
  }
}
