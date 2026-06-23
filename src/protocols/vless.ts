import { toUint8Array, matchesUuid } from '../shared/bytes';

export type VlessParseResult =
  | { ok: true; command: 'tcp' | 'udp'; hostname: string; port: number; payload: Uint8Array }
  | { ok: false; error: string };

export function parseVlessRequest(chunk: ArrayBuffer | ArrayBufferView, uuid: string): VlessParseResult {
  const data = toUint8Array(chunk);
  const length = data.byteLength;

  if (length < 24) {
    return { ok: false, error: 'Invalid data' };
  }

  const version = data[0];

  if (!matchesUuid(data, 1, uuid)) {
    return { ok: false, error: 'Invalid uuid' };
  }

  const optLen = data[17];
  const cmdIndex = 18 + optLen;
  if (length < cmdIndex + 4) {
    return { ok: false, error: 'Invalid data' };
  }

  const cmd = data[cmdIndex];
  let command: 'tcp' | 'udp';
  if (cmd === 1) {
    command = 'tcp';
  } else if (cmd === 2) {
    command = 'udp';
  } else {
    return { ok: false, error: 'Invalid command' };
  }

  const portIdx = cmdIndex + 1;
  const port = (data[portIdx] << 8) | data[portIdx + 1];

  let addrValIdx = portIdx + 3;
  let addrLen = 0;
  let hostname = '';

  const addressType = data[portIdx + 2];
  switch (addressType) {
    case 1:
      addrLen = 4;
      if (length < addrValIdx + addrLen) {
        return { ok: false, error: 'Invalid IPv4 address length' };
      }
      hostname = `${data[addrValIdx]}.${data[addrValIdx + 1]}.${data[addrValIdx + 2]}.${data[addrValIdx + 3]}`;
      break;
    case 2:
      if (length < addrValIdx + 1) {
        return { ok: false, error: 'Invalid domain length' };
      }
      addrLen = data[addrValIdx]!;
      addrValIdx += 1;
      if (length < addrValIdx + addrLen) {
        return { ok: false, error: 'Invalid domain data' };
      }
      hostname = new TextDecoder().decode(data.subarray(addrValIdx, addrValIdx + addrLen));
      break;
    case 3:
      addrLen = 16;
      if (length < addrValIdx + addrLen) {
        return { ok: false, error: 'Invalid IPv6 address length' };
      }
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        const base = addrValIdx + i * 2;
        ipv6.push(((data[base]! << 8) | data[base + 1]!).toString(16));
      }
      hostname = ipv6.join(':');
      break;
    default:
      return { ok: false, error: `Invalid address type: ${addressType}` };
  }

  if (!hostname) {
    return { ok: false, error: 'Empty hostname' };
  }

  const payloadOffset = addrValIdx + addrLen;
  const payload = data.subarray(payloadOffset);

  return {
    ok: true,
    command,
    hostname,
    port,
    payload,
  };
}
