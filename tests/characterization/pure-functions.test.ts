import { describe, expect, it } from 'vitest';
import { loadLegacyWorker } from './helpers/load-legacy-worker';

type ProxyAddress = {
  username?: string;
  password?: string;
  hostname: string;
  port: number;
};

describe('legacy pure functions', () => {
  it('parses authenticated IPv4 proxy', async () => {
    const legacy = await loadLegacyWorker();
    const parse = legacy.获取SOCKS5账号 as (address: string, defaultPort: number) => ProxyAddress;

    expect(parse('user:pass@127.0.0.1:1080', 80)).toEqual({
      username: 'user',
      password: 'pass',
      hostname: '127.0.0.1',
      port: 1080,
    });
  });

  it('rejects unbracketed IPv6', async () => {
    const legacy = await loadLegacyWorker();
    const parse = legacy.获取SOCKS5账号 as (address: string, defaultPort: number) => ProxyAddress;

    expect(() => parse('2001:db8::1', 1080)).toThrow('IPv6');
  });

  it('normalizes delimited text into an array', async () => {
    const legacy = await loadLegacyWorker();
    const normalize = legacy.整理成数组 as (value: string) => Promise<string[]>;

    await expect(normalize('a,\n\'b\'\t"c"')).resolves.toEqual(['a', 'b', 'c']);
  });
});
