import { describe, expect, it } from 'vitest';
import { TlsRecordParser, TlsHandshakeParser } from '../../src/networking/tls';

describe('TlsRecordParser', () => {
  it('returns null when buffer is too small', () => {
    const parser = new TlsRecordParser();
    parser.feed(new Uint8Array([0x16, 0x03, 0x01]));
    expect(parser.next()).toBeNull();
  });

  it('parses a complete TLS record', () => {
    const parser = new TlsRecordParser();
    const fragment = new Uint8Array([0x01, 0x02, 0x03]);
    const record = new Uint8Array([
      0x16, // ContentType: Handshake
      0x03, 0x01, // Version: TLS 1.0
      0x00, 0x03, // Length: 3
      ...fragment,
    ]);
    parser.feed(record);
    const result = parser.next();
    expect(result).not.toBeNull();
    expect(result!.type).toBe(0x16);
    expect(result!.version).toBe(769); // TLS 1.0
    expect(result!.length).toBe(3);
    expect(result!.fragment).toEqual(fragment);
  });

  it('returns null when no more records', () => {
    const parser = new TlsRecordParser();
    expect(parser.next()).toBeNull();
  });

  it('parses multiple records from a single chunk', () => {
    const parser = new TlsRecordParser();
    const record1 = new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x02, 0xaa, 0xbb]);
    const record2 = new Uint8Array([0x17, 0x03, 0x03, 0x00, 0x01, 0xcc]);
    const combined = new Uint8Array([...record1, ...record2]);
    parser.feed(combined);

    const first = parser.next();
    expect(first!.type).toBe(0x16);
    expect(first!.fragment).toEqual(new Uint8Array([0xaa, 0xbb]));

    const second = parser.next();
    expect(second!.type).toBe(0x17);
    expect(second!.fragment).toEqual(new Uint8Array([0xcc]));

    expect(parser.next()).toBeNull();
  });
});

describe('TlsHandshakeParser', () => {
  it('returns null when buffer is too small', () => {
    const parser = new TlsHandshakeParser();
    parser.feed(new Uint8Array([0x01, 0x00, 0x00]));
    expect(parser.next()).toBeNull();
  });

  it('parses a complete handshake message', () => {
    const parser = new TlsHandshakeParser();
    const body = new Uint8Array([0x01, 0x02, 0x03]);
    const message = new Uint8Array([
      0x01, // HandshakeType: ClientHello
      0x00, 0x00, 0x03, // Length: 3
      ...body,
    ]);
    parser.feed(message);
    const result = parser.next();
    expect(result).not.toBeNull();
    expect(result!.type).toBe(0x01);
    expect(result!.length).toBe(3);
    expect(result!.body).toEqual(body);
    expect(result!.raw).toEqual(message);
  });

  it('returns null when no more messages', () => {
    const parser = new TlsHandshakeParser();
    expect(parser.next()).toBeNull();
  });
});
