import { describe, expect, it, vi } from 'vitest';
import { resolveProxyCandidates } from '../../src/networking/proxy-ip';

describe('resolveProxyCandidates', () => {
  it('parses comma-separated IPv4 and bracketed IPv6 candidates', async () => {
    await expect(
      resolveProxyCandidates('192.0.2.1:8443,[2001:db8::1]:9443', 'www.example.com', 'user-id'),
    ).resolves.toEqual([
      { hostname: '[2001:db8::1]', port: 9443 },
      { hostname: '192.0.2.1', port: 8443 },
    ]);
  });

  it('uses the tp marker as the candidate port', async () => {
    await expect(
      resolveProxyCandidates(
        'proxy.example.tp2053.example',
        'target.example',
        'user-id',
        async () => [{ type: 'A', data: '192.0.2.2', ttl: 60 }],
      ),
    ).resolves.toEqual([{ hostname: '192.0.2.2', port: 2053 }]);
  });

  it('prefers TXT candidates over A and AAAA records', async () => {
    const resolve = vi.fn(async (_domain: string, type: string) => {
      if (type === 'TXT') {
        return [{ type: 'TXT', data: '198.51.100.1:8443,198.51.100.2', ttl: 60 }];
      }
      return [{ type, data: type === 'A' ? '192.0.2.1' : '2001:db8::1', ttl: 60 }];
    });

    const result = await resolveProxyCandidates(
      'proxy.example',
      'target.example',
      'user-id',
      resolve,
    );

    expect(result).toEqual([
      { hostname: '198.51.100.1', port: 8443 },
      { hostname: '198.51.100.2', port: 443 },
    ]);
    expect(resolve).toHaveBeenCalledWith('proxy.example', 'TXT');
    expect(resolve).toHaveBeenCalledWith('proxy.example', 'A');
    expect(resolve).not.toHaveBeenCalledWith('proxy.example', 'AAAA');
  });

  it('falls back to the original hostname when DNS has no usable answer', async () => {
    await expect(
      resolveProxyCandidates('proxy.example', 'target.example', 'user-id', async () => []),
    ).resolves.toEqual([{ hostname: 'proxy.example', port: 443 }]);
  });
});
