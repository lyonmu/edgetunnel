import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../src/config/defaults';
import type { RuntimeSnapshot } from '../../src/config/runtime';
import {
  buildSubscriptionNodes,
  serializeBase64,
  serializeClash,
  serializeMixed,
  serializeSingBox,
  serializeSurge,
} from '../../src/subscription/model';

function snapshot(): RuntimeSnapshot {
  const config = createDefaultConfig();
  config.inbound.trojan.enabled = true;
  config.inbound.shadowsocks.enabled = true;
  config.transports.grpc.enabled = true;
  config.transports.xhttp.enabled = true;
  config.subscription.publicBaseUrl = 'https://edge.example:8443';
  return {
    config,
    secrets: {
      admin: 'admin-must-not-leak',
      configKey: 'config-key-must-not-leak',
      trojanPassword: 'trojan-pass',
      shadowsocksPassword: 'ss-pass',
    },
    identity: { vlessUuid: '90cd4a77-141a-43c9-991b-08263cfe9c10' },
    requestId: 'request-id',
  };
}

describe('subscription node model', () => {
  it('builds only supported enabled protocol and transport combinations', () => {
    const nodes = buildSubscriptionNodes(snapshot(), new URL('https://fallback.example/sub'));

    expect(nodes.map((node) => `${node.protocol}:${node.transport}`)).toEqual([
      'vless:ws',
      'vless:grpc',
      'vless:xhttp',
      'trojan:ws',
      'trojan:grpc',
      'shadowsocks:ws',
    ]);
    expect(nodes.every((node) => node.server === 'edge.example' && node.port === 8443)).toBe(true);
    expect(nodes.find((node) => node.transport === 'grpc')?.serviceName).toBe('edgetunnel');
    expect(nodes.find((node) => node.transport === 'xhttp')?.path).toBe('/xhttp');
  });

  it('serializes all native formats without leaking runtime or connector secrets', () => {
    const nodes = buildSubscriptionNodes(snapshot(), new URL('https://fallback.example/sub'));
    const mixed = serializeMixed(nodes);
    const outputs = [
      mixed,
      serializeBase64(nodes),
      serializeClash(nodes),
      serializeSingBox(nodes),
      serializeSurge(nodes),
    ];

    expect(atob(outputs[1]!)).toBe(mixed);
    expect(() => JSON.parse(outputs[2]!)).not.toThrow();
    expect(() => JSON.parse(outputs[3]!)).not.toThrow();
    expect(mixed).toContain('packetEncoding=xudp');
    expect(mixed).toContain('serviceName=edgetunnel');
    expect(mixed).toContain('mode=stream-one');
    expect(decodeURIComponent(mixed)).toContain('mux=0');
    expect(decodeURIComponent(mixed)).toContain('path=/ws?enc=aes-128-gcm');
    for (const output of outputs) {
      expect(output).not.toContain('admin-must-not-leak');
      expect(output).not.toContain('config-key-must-not-leak');
      expect(output).not.toContain('credentialRef');
    }
  });

  it('rejects a Surge document when no supported node remains', () => {
    const configSnapshot = snapshot();
    configSnapshot.config.inbound.trojan.enabled = false;
    const nodes = buildSubscriptionNodes(configSnapshot, new URL('https://fallback.example/sub'));

    expect(() => serializeSurge(nodes)).toThrow('没有 Surge 支持');
  });
});
