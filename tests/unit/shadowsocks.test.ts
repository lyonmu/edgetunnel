import { describe, expect, it } from 'vitest';
import { ssDeriveKey, SS_SUPPORTED_CIPHERS } from '../../src/protocols/shadowsocks';

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
