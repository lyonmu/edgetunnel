import { describe, expect, it, vi } from 'vitest';
import {
  socks5Connect,
  httpConnect,
  httpsConnect,
  parseSocks5Address,
  isIPv4,
  isIPHostname,
  stripIPv6Brackets,
} from '../../src/networking/proxy-connectors';
import type { ProxyAddress } from '../../src/app/types';

describe('parseSocks5Address', () => {
  it('parses user:pass@host:port', () => {
    expect(parseSocks5Address('user:pass@127.0.0.1:1080', 80)).toEqual({
      username: 'user',
      password: 'pass',
      hostname: '127.0.0.1',
      port: 1080,
    });
  });

  it('parses host:port without auth', () => {
    expect(parseSocks5Address('proxy.example.com:1080', 80)).toEqual({
      hostname: 'proxy.example.com',
      port: 1080,
    });
  });

  it('uses default port when not specified', () => {
    expect(parseSocks5Address('proxy.example.com', 1080)).toEqual({
      hostname: 'proxy.example.com',
      port: 1080,
    });
  });

  it('rejects unbracketed IPv6', () => {
    expect(() => parseSocks5Address('2001:db8::1', 1080)).toThrow('IPv6');
  });

  it('parses bracketed IPv6', () => {
    expect(parseSocks5Address('[2001:db8::1]:1080', 80)).toEqual({
      hostname: '2001:db8::1',
      port: 1080,
    });
  });
});

describe('IP helpers', () => {
  it('isIPv4 detects IPv4 addresses', () => {
    expect(isIPv4('192.168.1.1')).toBe(true);
    expect(isIPv4('example.com')).toBe(false);
    expect(isIPv4('::1')).toBe(false);
  });

  it('isIPHostname detects IP addresses', () => {
    expect(isIPHostname('192.168.1.1')).toBe(true);
    expect(isIPHostname('[2001:db8::1]')).toBe(true);
    expect(isIPHostname('example.com')).toBe(false);
  });

  it('stripIPv6Brackets removes brackets', () => {
    expect(stripIPv6Brackets('[2001:db8::1]')).toBe('2001:db8::1');
    expect(stripIPv6Brackets('2001:db8::1')).toBe('2001:db8::1');
    expect(stripIPv6Brackets('example.com')).toBe('example.com');
  });
});
