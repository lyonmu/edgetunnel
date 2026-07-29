import { CONFIG_SCHEMA_VERSION, type WorkerConfigV1 } from './schema';

export function createDefaultConfig(): WorkerConfigV1 {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    revision: 1,
    inbound: {
      vless: { enabled: true },
      trojan: { enabled: false },
      shadowsocks: {
        enabled: false,
        method: 'aes-128-gcm',
      },
    },
    transports: {
      websocket: { enabled: true, path: '/ws' },
      grpc: { enabled: false, serviceName: 'edgetunnel' },
      xhttp: { enabled: false, path: '/xhttp', mode: 'stream-one' },
    },
    dns: {
      enabled: true,
      dohUrl: 'https://1.1.1.1/dns-query',
      timeoutMs: 5_000,
      maxMessageBytes: 4_096,
    },
    routing: {
      defaultProfileId: 'direct',
      rules: [],
      blockPrivateTargets: true,
    },
    egressProfiles: [
      {
        id: 'direct',
        type: 'direct',
        enabled: true,
        timeoutMs: 10_000,
      },
    ],
    subscription: {
      enabled: true,
      formats: ['mixed', 'base64', 'clash', 'singbox', 'surge'],
    },
    site: {},
    observability: {
      logLevel: 'error',
      retention: 100,
    },
  };
}
