import { createDefaultConfig } from './defaults';
import { migrateStoredConfig } from './migrate';
import type { StoredConfig } from './types';

export async function readStoredConfig(kv: KVNamespace): Promise<unknown> {
  const text = await kv.get('config.json');
  return text ? (JSON.parse(text) as unknown) : null;
}

export async function loadStoredConfig(
  kv: KVNamespace,
  host: string,
  userId: string,
): Promise<StoredConfig> {
  const raw = await readStoredConfig(kv);
  if (raw !== null) {
    return migrateStoredConfig(raw);
  }
  const defaults = createDefaultConfig(host, userId);
  await kv.put('config.json', JSON.stringify(defaults, null, 2));
  return defaults;
}

export async function saveStoredConfig(kv: KVNamespace, config: unknown): Promise<void> {
  await kv.put('config.json', JSON.stringify(config, null, 2));
}
