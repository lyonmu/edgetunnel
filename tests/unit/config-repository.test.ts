import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../src/config/defaults';
import {
  CONFIG_KEY,
  ConfigRevisionConflict,
  loadConfig,
  saveConfig,
} from '../../src/config/repository';

class MemoryKv {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];

  async get(key: string): Promise<string | null> {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.writes.push(key);
    this.values.set(key, value);
  }

  namespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}

describe('v1 configuration repository', () => {
  it('initializes an absent namespace with revision one defaults', async () => {
    const kv = new MemoryKv();

    const config = await loadConfig(kv.namespace());

    expect(config).toEqual(createDefaultConfig());
    expect(JSON.parse(kv.values.get(CONFIG_KEY) ?? '')).toEqual(createDefaultConfig());
    expect(kv.reads).toEqual([CONFIG_KEY]);
    expect(kv.writes).toEqual([CONFIG_KEY]);
  });

  it('does not read the legacy config key', async () => {
    const kv = new MemoryKv();
    kv.values.set('config.json', JSON.stringify({ legacy: true }));

    await loadConfig(kv.namespace());

    expect(kv.reads).not.toContain('config.json');
  });

  it('rejects invalid persisted JSON without replacing it', async () => {
    const kv = new MemoryKv();
    kv.values.set(CONFIG_KEY, '{invalid');

    await expect(loadConfig(kv.namespace())).rejects.toBeInstanceOf(SyntaxError);
    expect(kv.writes).toEqual([]);
    expect(kv.values.get(CONFIG_KEY)).toBe('{invalid');
  });

  it('rejects a stale revision without writing', async () => {
    const kv = new MemoryKv();
    kv.values.set(CONFIG_KEY, JSON.stringify(createDefaultConfig()));

    await expect(saveConfig(kv.namespace(), createDefaultConfig(), 0)).rejects.toMatchObject({
      name: 'ConfigRevisionConflict',
      expectedRevision: 0,
      actualRevision: 1,
    });
    expect(kv.writes).toEqual([]);
  });

  it('increments the persisted revision after a successful save', async () => {
    const kv = new MemoryKv();
    kv.values.set(CONFIG_KEY, JSON.stringify(createDefaultConfig()));
    const updated = structuredClone(createDefaultConfig());
    updated.inbound.trojan.enabled = true;

    const saved = await saveConfig(kv.namespace(), updated, 1);

    expect(saved.revision).toBe(2);
    expect(saved.inbound.trojan.enabled).toBe(true);
    expect(JSON.parse(kv.values.get(CONFIG_KEY) ?? '')).toEqual(saved);
    expect(kv.writes).toEqual([CONFIG_KEY]);
  });

  it('exposes conflict revisions for the admin API', () => {
    const error = new ConfigRevisionConflict(4, 7);

    expect(error.name).toBe('ConfigRevisionConflict');
    expect(error.expectedRevision).toBe(4);
    expect(error.actualRevision).toBe(7);
  });
});
