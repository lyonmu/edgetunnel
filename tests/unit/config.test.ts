import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRequestContext } from '../../src/app/request-context';
import { applyEnvironmentOverrides, buildRuntimeConfig } from '../../src/config/runtime';
import { migrateStoredConfig } from '../../src/config/migrate';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';

describe('configuration compatibility', () => {
  it('fills missing compatibility fields and preserves unknown fields', () => {
    const migrated = migrateStoredConfig({
      HOST: 'old.example',
      UUID: uuid,
      自定义字段: { 保留: true },
      订阅转换配置: {},
      反代: { 路径模板: {} },
    });

    expect(migrated.订阅转换配置.SUBLIST).toBe(false);
    expect(migrated.反代.路径模板.HTTPS).toEqual({
      全局: 'https://{{IP:PORT}}',
      标准: 'https={{IP:PORT}}',
    });
    expect(migrated.反代.路径模板.TURN).toBeDefined();
    expect(migrated.反代.路径模板.SSTP).toBeDefined();
    expect(migrated.自定义字段).toEqual({ 保留: true });
  });

  it('applies environment overrides without mutating stored config', () => {
    const stored = migrateStoredConfig({ HOST: 'old.example', UUID: uuid, PATH: '/old' });
    const overridden = applyEnvironmentOverrides(stored, {
      KV: env.KV,
      ASSETS: env.ASSETS,
      HOST: 'one.example,two.example',
      PATH: 'new',
    });

    expect(overridden.HOSTS).toEqual(['one.example', 'two.example']);
    expect(overridden.PATH).toBe('/new');
    expect(stored.HOSTS).toEqual(['old.example']);
    expect(stored.PATH).toBe('/old');
  });

  it('builds request-derived fields without changing the stored object', async () => {
    const stored = migrateStoredConfig({ HOST: 'old.example', UUID: uuid, PATH: '/' });
    const context = await createRequestContext(
      new Request('https://runtime.example/admin', {
        headers: { 'User-Agent': 'test-agent' },
      }),
      {
        KV: env.KV,
        ASSETS: env.ASSETS,
        ADMIN: 'admin',
        UUID: uuid,
      },
      createExecutionContext(),
    );

    const runtime = buildRuntimeConfig(stored, context);

    expect(runtime.HOST).toBe('runtime.example');
    expect(runtime.UUID).toBe(uuid);
    expect(runtime.LINK).toContain('runtime.example');
    expect(stored.HOST).toBe('old.example');
    expect(stored).not.toHaveProperty('LINK');
  });
});
