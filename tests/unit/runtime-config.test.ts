import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../src/config/defaults';
import { CONFIG_KEY } from '../../src/config/repository';
import { RuntimeConfigurationError, loadRuntimeSnapshot } from '../../src/config/runtime';
import { createRequestMetadata, type RuntimeEnv } from '../../src/app/request-context';
import { encodeBase64Url } from '../../src/security/crypto';

class MemoryKv {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  namespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const configKey = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index));

interface RuntimeOverrides {
  ADMIN?: string | undefined;
  UUID?: string | undefined;
  CONFIG_KEY?: string | undefined;
}

function runtimeEnv(kv: MemoryKv, overrides: RuntimeOverrides = {}): RuntimeEnv {
  const result = {
    KV: kv.namespace(),
    ASSETS: { fetch: async () => new Response() } as unknown as Fetcher,
    ADMIN: 'admin-secret',
    UUID: uuid,
    CONFIG_KEY: configKey,
  } as RuntimeEnv;
  const mutable = result as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete mutable[key];
    else mutable[key] = value;
  }
  return result;
}

function execution(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

describe('RuntimeSnapshot', () => {
  it('loads a frozen v1 configuration and explicit identities', async () => {
    const kv = new MemoryKv();
    const metadata = createRequestMetadata(
      new Request('https://worker.example/ws', {
        headers: { 'User-Agent': 'runtime-test', 'CF-Connecting-IP': '203.0.113.10' },
      }),
      runtimeEnv(kv),
      execution(),
    );

    const snapshot = await loadRuntimeSnapshot(metadata);

    expect(snapshot.config).toEqual(createDefaultConfig());
    expect(Object.isFrozen(snapshot.config)).toBe(true);
    expect(Object.isFrozen(snapshot.config.inbound)).toBe(true);
    expect(snapshot.identity.vlessUuid).toBe(uuid);
    expect(snapshot.requestId).toBe(metadata.requestId);
    expect(JSON.stringify(snapshot.config)).not.toContain('admin-secret');
    expect(JSON.stringify(snapshot.config)).not.toContain(configKey);
  });

  it('keeps an established snapshot unchanged after KV is updated', async () => {
    const kv = new MemoryKv();
    const metadata = createRequestMetadata(
      new Request('https://worker.example/ws'),
      runtimeEnv(kv),
      execution(),
    );
    const first = await loadRuntimeSnapshot(metadata);
    const changed = structuredClone(createDefaultConfig());
    changed.revision = 2;
    changed.observability.logLevel = 'info';
    kv.values.set(CONFIG_KEY, JSON.stringify(changed));

    const second = await loadRuntimeSnapshot(metadata);

    expect(first.config.revision).toBe(1);
    expect(first.config.observability.logLevel).toBe('error');
    expect(second.config.revision).toBe(2);
    expect(second.config.observability.logLevel).toBe('info');
  });

  it.each([
    ['ADMIN', { ADMIN: undefined }],
    ['UUID', { UUID: undefined }],
    ['CONFIG_KEY', { CONFIG_KEY: undefined }],
  ] as const)('rejects a missing %s secret', async (name, overrides) => {
    const kv = new MemoryKv();
    const metadata = createRequestMetadata(
      new Request('https://worker.example/ws'),
      runtimeEnv(kv, overrides),
      execution(),
    );

    await expect(loadRuntimeSnapshot(metadata)).rejects.toMatchObject({
      name: 'RuntimeConfigurationError',
      code: 'MISSING_SECRET',
      secretName: name,
    } satisfies Partial<RuntimeConfigurationError>);
  });

  it('does not treat legacy aliases as required secrets', async () => {
    const kv = new MemoryKv();
    const env = {
      KV: kv.namespace(),
      ASSETS: { fetch: async () => new Response() } as unknown as Fetcher,
      admin: 'legacy-admin',
      uuid,
      KEY: configKey,
      HOST: 'legacy.example',
      PATH: '/legacy',
      PROXYIP: 'proxy.example',
    } as unknown as RuntimeEnv;
    const metadata = createRequestMetadata(
      new Request('https://worker.example/ws'),
      env,
      execution(),
    );

    await expect(loadRuntimeSnapshot(metadata)).rejects.toMatchObject({
      code: 'MISSING_SECRET',
      secretName: 'ADMIN',
    });
  });
});
