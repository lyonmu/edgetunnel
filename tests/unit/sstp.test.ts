import { describe, expect, it } from 'vitest';
import {
  buildSstpDataPacket,
  internetChecksum,
  readSstpUint16,
  readSstpUint32,
} from '../../src/networking/sstp';

describe('SSTP/PPP wire helpers', () => {
  it('reads network-order integers', () => {
    const bytes = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    expect(readSstpUint16(bytes)).toBe(0x1234);
    expect(readSstpUint32(bytes)).toBe(0x12345678);
  });

  it('wraps a PPP frame in an SSTP data packet', () => {
    expect(buildSstpDataPacket(new Uint8Array([0xc0, 0x21]))).toEqual(
      new Uint8Array([0x10, 0, 0x80, 8, 0xff, 3, 0xc0, 0x21]),
    );
  });

  it('computes the RFC 1071 internet checksum', () => {
    expect(internetChecksum(new Uint8Array([0, 1, 0xf2, 3, 0xf4, 0xf5, 0xf6, 0xf7]), 0, 8)).toBe(
      0x220d,
    );
  });
});
