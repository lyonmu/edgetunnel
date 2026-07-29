import { describe, expect, it } from 'vitest';
import {
  createShadowsocksDecryptor,
  createShadowsocksEncryptor,
  createShadowsocksAddressReader,
  parseShadowsocksAddress,
  ssDeriveKey,
  SS_SUPPORTED_CIPHERS,
} from '../../src/protocols/shadowsocks';

describe('ssDeriveKey', () => {
  it('derives correct key length for aes-128-gcm', () => {
    const key = ssDeriveKey('test-password', 16);
    expect(key.length).toBe(16);
  });

  it('derives correct key length for aes-256-gcm', () => {
    const key = ssDeriveKey('test-password', 32);
    expect(key.length).toBe(32);
  });

  it('produces deterministic output', () => {
    const key1 = ssDeriveKey('test-password', 16);
    const key2 = ssDeriveKey('test-password', 16);
    expect(key1).toEqual(key2);
  });
});

describe('SS_SUPPORTED_CIPHERS', () => {
  it('contains aes-128-gcm', () => {
    expect(SS_SUPPORTED_CIPHERS['aes-128-gcm']).toBeDefined();
    expect(SS_SUPPORTED_CIPHERS['aes-128-gcm']!.keyLen).toBe(16);
  });

  it('contains aes-256-gcm', () => {
    expect(SS_SUPPORTED_CIPHERS['aes-256-gcm']).toBeDefined();
    expect(SS_SUPPORTED_CIPHERS['aes-256-gcm']!.keyLen).toBe(32);
  });
});

describe('Shadowsocks AEAD stream', () => {
  it('decrypts fragmented AES-128-GCM frames and preserves chunk order', async () => {
    const encryptor = await createShadowsocksEncryptor('test-password', 'aes-128-gcm');
    const decryptor = createShadowsocksDecryptor('test-password', 'aes-128-gcm');
    const first = await encryptor.encrypt(new Uint8Array([1, 2, 3]));
    const second = await encryptor.encrypt(new Uint8Array([4, 5]));
    const encrypted = new Uint8Array(first.byteLength + second.byteLength);
    encrypted.set(first);
    encrypted.set(second, first.byteLength);

    expect(await decryptor.push(encrypted.subarray(0, 11))).toEqual([]);
    const plaintext = [
      ...(await decryptor.push(encrypted.subarray(11, 31))),
      ...(await decryptor.push(encrypted.subarray(31))),
    ];

    expect(plaintext).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  });

  it('parses a domain target from the first plaintext chunk', () => {
    const host = new TextEncoder().encode('example.com');
    const result = parseShadowsocksAddress(
      new Uint8Array([0x03, host.length, ...host, 0x01, 0xbb, 0xaa, 0xbb]),
    );

    expect(result).toEqual({
      hostname: 'example.com',
      port: 443,
      payload: new Uint8Array([0xaa, 0xbb]),
    });
  });
});

describe('createShadowsocksAddressReader', () => {
  it('waits for a domain address split across plaintext frames', () => {
    const reader = createShadowsocksAddressReader();
    const host = new TextEncoder().encode('example.com');
    const packet = new Uint8Array([3, host.length, ...host, 1, 187, 9]);

    expect(reader.push(packet.slice(0, 5))).toEqual({ status: 'need_more' });
    const result = reader.push(packet.slice(5));

    expect(result).toEqual({
      status: 'ok',
      target: {
        hostname: 'example.com',
        port: 443,
        payload: new Uint8Array([9]),
      },
    });
  });
});
