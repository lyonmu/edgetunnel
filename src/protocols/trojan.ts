import { toUint8Array } from '../shared/bytes';

export type TrojanParseResult =
  | { ok: true; command: 'tcp' | 'udp'; hostname: string; port: number; payload: Uint8Array }
  | { ok: false; error: string };

function sha224Hex(s: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const r = (n: number, b: number) => ((n >>> b) | (n << (32 - b))) >>> 0;
  s = unescape(encodeURIComponent(s));
  const l = s.length * 8;
  s += String.fromCharCode(0x80);
  while ((s.length * 8) % 512 !== 448) s += String.fromCharCode(0);
  const h = [
    0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4,
  ];
  const hi = Math.floor(l / 0x100000000);
  const lo = l & 0xffffffff;
  s += String.fromCharCode(
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  );
  const w: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    w.push(
      (s.charCodeAt(i) << 24) |
        (s.charCodeAt(i + 1) << 16) |
        (s.charCodeAt(i + 2) << 8) |
        s.charCodeAt(i + 3),
    );
  }
  for (let i = 0; i < w.length; i += 16) {
    const x = new Array(64).fill(0);
    for (let j = 0; j < 16; j++) x[j] = w[i + j];
    for (let j = 16; j < 64; j++) {
      const s0 = r(x[j - 15], 7) ^ r(x[j - 15], 18) ^ (x[j - 15] >>> 3);
      const s1 = r(x[j - 2], 17) ^ r(x[j - 2], 19) ^ (x[j - 2] >>> 10);
      x[j] = (x[j - 16] + s0 + x[j - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h0] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let j = 0; j < 64; j++) {
      const S1 = r(e, 6) ^ r(e, 11) ^ r(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h0 + S1 + ch + K[j]! + x[j]!) >>> 0;
      const S0 = r(a, 2) ^ r(a, 13) ^ r(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h0 = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    for (let j = 0; j < 8; j++) {
      h[j] =
        (h[j]! +
          (j === 0
            ? a
            : j === 1
              ? b
              : j === 2
                ? c
                : j === 3
                  ? d
                  : j === 4
                    ? e
                    : j === 5
                      ? f
                      : j === 6
                        ? g
                        : h0)) >>>
        0;
    }
  }
  let hex = '';
  for (let i = 0; i < 7; i++) {
    for (let j = 24; j >= 0; j -= 8) hex += ((h[i]! >>> j) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

const textDecoder = new TextDecoder();

export function parseTrojanRequest(
  buffer: ArrayBuffer | ArrayBufferView,
  password: string,
): TrojanParseResult {
  const data = toUint8Array(buffer);
  const sha224Password = sha224Hex(password);

  if (data.byteLength < 58) {
    return { ok: false, error: 'invalid data' };
  }

  const crLfIndex = 56;
  if (data[crLfIndex] !== 0x0d || data[crLfIndex + 1] !== 0x0a) {
    return { ok: false, error: 'invalid header format' };
  }

  for (let i = 0; i < crLfIndex; i++) {
    if (data[i] !== sha224Password.charCodeAt(i)) {
      return { ok: false, error: 'invalid password' };
    }
  }

  const socks5Index = crLfIndex + 2;
  if (data.byteLength < socks5Index + 6) {
    return { ok: false, error: 'invalid S5 request data' };
  }

  const cmd = data[socks5Index]!;
  if (cmd !== 1 && cmd !== 3) {
    return { ok: false, error: 'unsupported command, only TCP/UDP is allowed' };
  }
  const command: 'tcp' | 'udp' = cmd === 1 ? 'tcp' : 'udp';

  const atype = data[socks5Index + 1]!;
  let addressLength: number;
  let addressIndex = socks5Index + 2;
  let hostname: string;

  switch (atype) {
    case 1:
      addressLength = 4;
      if (data.byteLength < addressIndex + addressLength + 4) {
        return { ok: false, error: 'invalid S5 request data' };
      }
      hostname = `${data[addressIndex]}.${data[addressIndex + 1]}.${data[addressIndex + 2]}.${data[addressIndex + 3]}`;
      break;
    case 3:
      if (data.byteLength < addressIndex + 1) {
        return { ok: false, error: 'invalid S5 request data' };
      }
      addressLength = data[addressIndex]!;
      addressIndex += 1;
      if (data.byteLength < addressIndex + addressLength + 4) {
        return { ok: false, error: 'invalid S5 request data' };
      }
      hostname = textDecoder.decode(data.subarray(addressIndex, addressIndex + addressLength));
      break;
    case 4: {
      addressLength = 16;
      if (data.byteLength < addressIndex + addressLength + 4) {
        return { ok: false, error: 'invalid S5 request data' };
      }
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        const partIndex = addressIndex + i * 2;
        ipv6.push(((data[partIndex]! << 8) | data[partIndex + 1]!).toString(16));
      }
      hostname = ipv6.join(':');
      break;
    }
    default:
      return { ok: false, error: `invalid addressType is ${atype}` };
  }

  if (!hostname) {
    return { ok: false, error: `address is empty, addressType is ${atype}` };
  }

  const portIndex = addressIndex + addressLength;
  if (data.byteLength < portIndex + 4) {
    return { ok: false, error: 'invalid S5 request data' };
  }

  const port = (data[portIndex]! << 8) | data[portIndex + 1]!;
  const payload = data.subarray(portIndex + 4);

  return {
    ok: true,
    command,
    hostname,
    port,
    payload,
  };
}
