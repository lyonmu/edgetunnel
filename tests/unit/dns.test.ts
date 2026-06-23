import { describe, expect, it, vi } from 'vitest';
import { resolveDns, encodeDnsName, parseDnsResponse } from '../../src/networking/dns';

describe('DNS wire format encoding', () => {
  it('encodes a simple domain name', () => {
    const encoded = encodeDnsName('example.com');
    expect(encoded[0]).toBe(7); // "example".length
    expect(new TextDecoder().decode(encoded.slice(1, 8))).toBe('example');
    expect(encoded[8]).toBe(3); // "com".length
    expect(new TextDecoder().decode(encoded.slice(9, 12))).toBe('com');
    expect(encoded[12]).toBe(0); // root label
  });

  it('encodes a domain with trailing dot', () => {
    const encoded = encodeDnsName('example.com.');
    expect(encoded[encoded.length - 1]).toBe(0);
  });

  it('encodes a single-label domain', () => {
    const encoded = encodeDnsName('localhost');
    expect(encoded[0]).toBe(9);
    expect(new TextDecoder().decode(encoded.slice(1, 10))).toBe('localhost');
    expect(encoded[10]).toBe(0);
  });
});

describe('DNS response parsing', () => {
  it('parses an A record response', () => {
    const buf = new Uint8Array([
      0x00, 0x01, // ID
      0x81, 0x80, // Flags: response, recursion available
      0x00, 0x01, // QDCOUNT = 1
      0x00, 0x01, // ANCOUNT = 1
      0x00, 0x00, 0x00, 0x00, // NSCOUNT, ARCOUNT
      // Question: example.com A IN
      0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, // "example"
      0x03, 0x63, 0x6f, 0x6d, // "com"
      0x00, // root
      0x00, 0x01, // Type A
      0x00, 0x01, // Class IN
      // Answer: example.com A 93.184.216.34
      0xc0, 0x0c, // pointer to offset 12 (example.com)
      0x00, 0x01, // Type A
      0x00, 0x01, // Class IN
      0x00, 0x00, 0x0e, 0x10, // TTL = 3600
      0x00, 0x04, // RDLENGTH = 4
      0x5d, 0xb8, 0xd8, 0x22, // 93.184.216.34
    ]);
    const answers = parseDnsResponse(buf, 'A');
    expect(answers).toEqual([{ type: 'A', data: '93.184.216.34', ttl: 3600 }]);
  });

  it('parses an AAAA record response', () => {
    const buf = new Uint8Array([
      0x00, 0x01, // ID
      0x81, 0x80, // Flags
      0x00, 0x01, 0x00, 0x01, // QDCOUNT=1, ANCOUNT=1
      0x00, 0x00, 0x00, 0x00,
      // Question: example.com AAAA IN
      0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65,
      0x03, 0x63, 0x6f, 0x6d, 0x00,
      0x00, 0x1c, // Type AAAA
      0x00, 0x01,
      // Answer
      0xc0, 0x0c, // pointer
      0x00, 0x1c, // Type AAAA
      0x00, 0x01,
      0x00, 0x00, 0x0e, 0x10, // TTL
      0x00, 0x10, // RDLENGTH = 16
      0x26, 0x06, 0x28, 0x00, 0x02, 0x20, 0x00, 0x01,
      0x02, 0x48, 0x18, 0x93, 0x25, 0xc8, 0x19, 0x46,
    ]);
    const answers = parseDnsResponse(buf, 'AAAA');
    expect(answers).toEqual([{ type: 'AAAA', data: '2606:2800:220:1:248:1893:25c8:1946', ttl: 3600 }]);
  });

  it('parses a TXT record response', () => {
    const txtData = 'v=spf1 include:example.com ~all';
    const txtBytes = new TextEncoder().encode(txtData);
    const buf = new Uint8Array([
      0x00, 0x01, 0x81, 0x80,
      0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
      // Question
      0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65,
      0x03, 0x63, 0x6f, 0x6d, 0x00,
      0x00, 0x10, 0x00, 0x01,
      // Answer
      0xc0, 0x0c,
      0x00, 0x10, // Type TXT
      0x00, 0x01,
      0x00, 0x00, 0x0e, 0x10,
      0x00, txtBytes.length + 1, // RDLENGTH
      txtBytes.length, // TXT length prefix
      ...txtBytes,
    ]);
    const answers = parseDnsResponse(buf, 'TXT');
    expect(answers).toEqual([{ type: 'TXT', data: txtData, ttl: 3600 }]);
  });

  it('returns empty array for empty response', () => {
    const buf = new Uint8Array([
      0x00, 0x01, 0x81, 0x80,
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // Question only
      0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65,
      0x03, 0x63, 0x6f, 0x6d, 0x00,
      0x00, 0x01, 0x00, 0x01,
    ]);
    const answers = parseDnsResponse(buf, 'A');
    expect(answers).toEqual([]);
  });
});

describe('resolveDns', () => {
  it('returns empty array on fetch failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    try {
      const result = await resolveDns('example.com', 'A');
      expect(result).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
