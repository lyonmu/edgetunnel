export interface DnsAnswer {
  type: string;
  data: string;
  ttl: number;
}

const RECORD_TYPE_MAP: Record<string, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  HTTPS: 65,
};

export function encodeDnsName(name: string): Uint8Array {
  const parts = name.endsWith('.') ? name.slice(0, -1).split('.') : name.split('.');
  const bufs: Uint8Array[] = [];
  for (const label of parts) {
    const enc = new TextEncoder().encode(label);
    bufs.push(new Uint8Array([enc.length]), enc);
  }
  bufs.push(new Uint8Array([0]));
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    result.set(b, off);
    off += b.length;
  }
  return result;
}

function parseDnsName(buf: Uint8Array, pos: number): [string, number] {
  const labels: string[] = [];
  let p = pos;
  let jumped = false;
  let endPos = -1;
  let safe = 128;
  while (p < buf.length && safe-- > 0) {
    const len = buf[p]!;
    if (len === 0) {
      if (!jumped) endPos = p + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) endPos = p + 2;
      if (p + 1 >= buf.length) break;
      p = ((len & 0x3f) << 8) | buf[p + 1]!;
      jumped = true;
      continue;
    }
    labels.push(new TextDecoder().decode(buf.slice(p + 1, p + 1 + len)));
    p += len + 1;
  }
  if (endPos === -1) endPos = p + 1;
  return [labels.join('.'), endPos];
}

function parseA(rdata: Uint8Array): string {
  return `${rdata[0]!}.${rdata[1]!}.${rdata[2]!}.${rdata[3]!}`;
}

function parseAAAA(rdata: Uint8Array): string {
  const segs: string[] = [];
  for (let j = 0; j < 16; j += 2) {
    segs.push(((rdata[j]! << 8) | rdata[j + 1]!).toString(16));
  }
  return segs.join(':');
}

function parseTXT(rdata: Uint8Array): string {
  let tOff = 0;
  const parts: string[] = [];
  while (tOff < rdata.length) {
    const tLen = rdata[tOff++]!;
    parts.push(new TextDecoder().decode(rdata.slice(tOff, tOff + tLen)));
    tOff += tLen;
  }
  return parts.join('');
}

export function parseDnsResponse(buf: Uint8Array, recordType: string): DnsAnswer[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const qdcount = dv.getUint16(4);
  const ancount = dv.getUint16(6);

  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    const [, end] = parseDnsName(buf, offset);
    offset = end + 4;
  }

  const answers: DnsAnswer[] = [];
  for (let i = 0; i < ancount && offset < buf.length; i++) {
    const [, nameEnd] = parseDnsName(buf, offset);
    offset = nameEnd;
    const type = dv.getUint16(offset);
    offset += 2;
    offset += 2; // CLASS
    const ttl = dv.getUint32(offset);
    offset += 4;
    const rdlen = dv.getUint16(offset);
    offset += 2;
    const rdata = buf.slice(offset, offset + rdlen);
    offset += rdlen;

    let data: string | null = null;
    if (type === 1 && rdlen === 4) {
      data = parseA(rdata);
    } else if (type === 28 && rdlen === 16) {
      data = parseAAAA(rdata);
    } else if (type === 16) {
      data = parseTXT(rdata);
    } else if (type === 5) {
      const [cname] = parseDnsName(buf, offset - rdlen);
      data = cname;
    }

    if (data !== null) {
      const typeName = recordType.toUpperCase();
      answers.push({ type: typeName, data, ttl });
    }
  }
  return answers;
}

export async function resolveDns(
  domain: string,
  recordType: string,
  dohServer = 'https://cloudflare-dns.com/dns-query',
): Promise<DnsAnswer[]> {
  try {
    const qtype = RECORD_TYPE_MAP[recordType.toUpperCase()] || 1;
    const qname = encodeDnsName(domain);
    const query = new Uint8Array(12 + qname.length + 4);
    const qview = new DataView(query.buffer);
    qview.setUint16(0, crypto.getRandomValues(new Uint16Array(1))[0]!);
    qview.setUint16(2, 0x0100); // RD=1
    qview.setUint16(4, 1); // QDCOUNT
    query.set(qname, 12);
    qview.setUint16(12 + qname.length, qtype);
    qview.setUint16(12 + qname.length + 2, 1); // QCLASS = IN

    const response = await fetch(dohServer, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        Accept: 'application/dns-message',
      },
      body: query,
    });
    if (!response.ok) {
      return [];
    }
    const respBuf = new Uint8Array(await response.arrayBuffer());
    return parseDnsResponse(respBuf, recordType);
  } catch {
    return [];
  }
}
