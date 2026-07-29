import type { RequestMetadata } from '../app/types';
import { decodeBase64Url } from '../security/crypto';
import { loadConfig } from './repository';
import type { WorkerConfigV1 } from './schema';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RuntimeConfigurationErrorCode = 'MISSING_SECRET' | 'INVALID_SECRET';

export class RuntimeConfigurationError extends Error {
  constructor(
    readonly code: RuntimeConfigurationErrorCode,
    readonly secretName: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeConfigurationError';
  }
}

export interface RuntimeSnapshot {
  readonly config: WorkerConfigV1;
  readonly secrets: {
    readonly admin: string;
    readonly configKey: string;
    readonly trojanPassword?: string;
    readonly shadowsocksPassword?: string;
  };
  readonly identity: {
    readonly vlessUuid: string;
  };
  readonly requestId: string;
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value) {
    throw new RuntimeConfigurationError('MISSING_SECRET', name, `缺少 Worker Secret ${name}`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export async function loadRuntimeSnapshot(metadata: RequestMetadata): Promise<RuntimeSnapshot> {
  const config = deepFreeze(await loadConfig(metadata.env.KV));
  const admin = requiredSecret(metadata.env.ADMIN, 'ADMIN');
  const configKey = requiredSecret(metadata.env.CONFIG_KEY, 'CONFIG_KEY');
  try {
    if (decodeBase64Url(configKey).byteLength !== 32) throw new Error('invalid length');
  } catch {
    throw new RuntimeConfigurationError(
      'INVALID_SECRET',
      'CONFIG_KEY',
      'CONFIG_KEY 必须是 32 字节 base64url',
    );
  }
  const vlessUuid = requiredSecret(metadata.env.UUID, 'UUID').toLowerCase();
  if (!UUID_V4.test(vlessUuid)) {
    throw new RuntimeConfigurationError('INVALID_SECRET', 'UUID', 'UUID 必须是有效的 v4 UUID');
  }

  const trojanPassword = config.inbound.trojan.enabled
    ? requiredSecret(metadata.env.TROJAN_PASSWORD, 'TROJAN_PASSWORD')
    : metadata.env.TROJAN_PASSWORD;
  const shadowsocksPassword = config.inbound.shadowsocks.enabled
    ? requiredSecret(metadata.env.SHADOWSOCKS_PASSWORD, 'SHADOWSOCKS_PASSWORD')
    : metadata.env.SHADOWSOCKS_PASSWORD;

  return deepFreeze({
    config,
    secrets: {
      admin,
      configKey,
      ...(trojanPassword ? { trojanPassword } : {}),
      ...(shadowsocksPassword ? { shadowsocksPassword } : {}),
    },
    identity: { vlessUuid },
    requestId: metadata.requestId,
  });
}
