import { describe, expect, it } from 'vitest';
import { parseTrojanRequest } from '../../src/protocols/trojan';

describe('parseTrojanRequest', () => {
  const testPassword = 'test-password';
  const standardSha224 = 'b42338ef718bb33b88d3c2bf0cb6130499a1dc05e5c101b3722b09c7';

  it('parses a request authenticated with the standard SHA-224 hash', () => {
    const host = new TextEncoder().encode('example.com');
    const packet = new Uint8Array([
      ...new TextEncoder().encode(standardSha224),
      0x0d,
      0x0a,
      0x01,
      0x03,
      host.length,
      ...host,
      0x01,
      0xbb,
      0x0d,
      0x0a,
      0x01,
      0x02,
    ]);

    const result = parseTrojanRequest(packet, testPassword);

    expect(result).toEqual({
      ok: true,
      command: 'tcp',
      hostname: 'example.com',
      port: 443,
      payload: new Uint8Array([1, 2]),
    });
  });

  it('rejects short packet', () => {
    const packet = new Uint8Array([1, 2, 3]);
    const result = parseTrojanRequest(packet, testPassword);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid CRLF', () => {
    const packet = new Uint8Array(60);
    packet[56] = 0x00;
    packet[57] = 0x00;
    const result = parseTrojanRequest(packet, testPassword);
    expect(result.ok).toBe(false);
  });
});
