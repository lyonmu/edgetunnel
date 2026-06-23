import { describe, expect, it } from 'vitest';
import { parseTrojanRequest } from '../../src/protocols/trojan';

describe('parseTrojanRequest', () => {
  const testPassword = 'test-password';

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
