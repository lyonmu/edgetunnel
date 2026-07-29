import { describe, expect, it } from 'vitest';
import { parseVlessRequest } from '../../src/protocols/vless';

describe('parseVlessRequest', () => {
  const testUuid = '12345678-1234-1234-1234-123456789abc';

  function createVlessPacket(
    uuid: string,
    command: number,
    addressType: number,
    address: Uint8Array,
    port: number,
    payload: Uint8Array,
  ): Uint8Array {
    const optLen = 0;
    const parts: Uint8Array[] = [];

    parts.push(new Uint8Array([0x00]));

    const uuidBytes = new Uint8Array(16);
    const clean = uuid.replace(/-/g, '');
    for (let i = 0; i < 16; i++) {
      const high = parseInt(clean[i * 2]!, 16);
      const low = parseInt(clean[i * 2 + 1]!, 16);
      uuidBytes[i] = (high << 4) | low;
    }
    parts.push(uuidBytes);

    parts.push(new Uint8Array([optLen]));

    const portBytes = new Uint8Array([(port >> 8) & 0xff, port & 0xff]);
    parts.push(new Uint8Array([command]));
    parts.push(portBytes);
    parts.push(new Uint8Array([addressType]));

    if (addressType === 1) {
      parts.push(address);
    } else if (addressType === 2) {
      parts.push(new Uint8Array([address.length]));
      parts.push(address);
    } else if (addressType === 3) {
      parts.push(address);
    }

    parts.push(payload);

    let totalLength = 0;
    for (const part of parts) totalLength += part.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  it('parses IPv4 address', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const packet = createVlessPacket(
      testUuid,
      1,
      1,
      new Uint8Array([192, 168, 1, 1]),
      443,
      payload,
    );

    const result = parseVlessRequest(packet, testUuid);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostname).toBe('192.168.1.1');
      expect(result.port).toBe(443);
      expect(result.command).toBe('tcp');
    }
  });

  it('parses domain address', () => {
    const domain = new TextEncoder().encode('example.com');
    const payload = new Uint8Array([1, 2, 3, 4]);
    const packet = createVlessPacket(testUuid, 1, 2, domain, 80, payload);

    const result = parseVlessRequest(packet, testUuid);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostname).toBe('example.com');
      expect(result.port).toBe(80);
    }
  });

  it('rejects invalid uuid', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const packet = createVlessPacket(
      testUuid,
      1,
      1,
      new Uint8Array([192, 168, 1, 1]),
      443,
      payload,
    );

    const result = parseVlessRequest(packet, '00000000-0000-0000-0000-000000000000');

    expect(result.ok).toBe(false);
  });

  it('rejects short packet', () => {
    const packet = new Uint8Array([1, 2, 3]);

    const result = parseVlessRequest(packet, testUuid);

    expect(result.ok).toBe(false);
  });

  it('recognizes Single XUDP carried by the VLESS Mux command', () => {
    const payload = new Uint8Array([0, 4, 0, 0, 4, 0]);
    const packet = createVlessPacket(testUuid, 3, 0, new Uint8Array(), 0, payload).slice(
      0,
      19 + payload.byteLength,
    );
    packet.set(payload, 19);

    const result = parseVlessRequest(packet, testUuid);

    expect(result).toMatchObject({
      ok: true,
      command: 'xudp',
      hostname: 'v1.mux.cool',
      port: 0,
      payload,
    });
  });
});
