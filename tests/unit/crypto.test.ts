import { describe, expect, it } from 'vitest';
import {
  decodeBase64Url,
  decryptJson,
  encodeBase64Url,
  encryptJson,
  signHmac,
  timingSafeEqual,
} from '../../src/security/crypto';

function configKey(offset = 0): string {
  return encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index + offset));
}

describe('security crypto primitives', () => {
  it('round-trips unpadded base64url values', () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const encoded = encodeBase64Url(bytes);

    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeBase64Url(encoded)).toEqual(bytes);
  });

  it('compares equal and unequal byte sequences without accepting length differences', () => {
    expect(timingSafeEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true);
    expect(timingSafeEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false);
    expect(timingSafeEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 0]))).toBe(false);
  });

  it('creates deterministic HMAC signatures for the same payload', async () => {
    const payload = new TextEncoder().encode('session:v1');

    const first = await signHmac('admin-secret', payload);
    const second = await signHmac('admin-secret', payload);
    const different = await signHmac('other-secret', payload);

    expect(first.byteLength).toBe(32);
    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
  });

  it('uses a fresh AES-GCM nonce for every encryption', async () => {
    const first = await encryptJson(configKey(), 'profile:main', { password: 'secret' });
    const second = await encryptJson(configKey(), 'profile:main', { password: 'secret' });

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    await expect(decryptJson(configKey(), 'profile:main', first)).resolves.toEqual({
      password: 'secret',
    });
  });

  it('rejects the wrong key, AAD and modified ciphertext', async () => {
    const envelope = await encryptJson(configKey(), 'profile:main', { password: 'secret' });
    const modifiedBytes = decodeBase64Url(envelope.ciphertext);
    modifiedBytes[0] = (modifiedBytes[0] ?? 0) ^ 1;
    const modified = {
      ...envelope,
      ciphertext: encodeBase64Url(modifiedBytes),
    };

    await expect(decryptJson(configKey(1), 'profile:main', envelope)).rejects.toThrow();
    await expect(decryptJson(configKey(), 'profile:other', envelope)).rejects.toThrow();
    await expect(decryptJson(configKey(), 'profile:main', modified)).rejects.toThrow();
  });

  it('rejects CONFIG_KEY values that are not exactly 32 bytes', async () => {
    await expect(
      encryptJson(encodeBase64Url(new Uint8Array(31)), 'profile:main', { password: 'secret' }),
    ).rejects.toThrow(/32/);
  });
});
