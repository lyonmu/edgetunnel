import { createDefaultConfig } from './defaults';
import { createLegacyDefaultConfig } from './legacy-defaults';
import type { WorkerConfigV1 } from './schema';
import { migrateStoredConfig } from './migrate';
import type { StoredConfig } from './types';
import { parseWorkerConfig } from './validate';

export const CONFIG_KEY = 'edgetunnel:config:v1';

export class ConfigRevisionConflict extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`配置 revision 冲突：期望 ${expectedRevision}，实际 ${actualRevision}`);
    this.name = 'ConfigRevisionConflict';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export async function loadConfig(kv: KVNamespace): Promise<WorkerConfigV1> {
  const text = await kv.get(CONFIG_KEY);
  if (text !== null) {
    return parseWorkerConfig(JSON.parse(text) as unknown);
  }

  const defaults = createDefaultConfig();
  await kv.put(CONFIG_KEY, JSON.stringify(defaults));
  return defaults;
}

export async function saveConfig(
  kv: KVNamespace,
  config: WorkerConfigV1,
  expectedRevision: number,
): Promise<WorkerConfigV1> {
  const current = await loadConfig(kv);
  if (current.revision !== expectedRevision) {
    throw new ConfigRevisionConflict(expectedRevision, current.revision);
  }

  const next = parseWorkerConfig({
    ...structuredClone(config),
    revision: current.revision + 1,
  });
  await kv.put(CONFIG_KEY, JSON.stringify(next));
  return next;
}

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
  const defaults = createLegacyDefaultConfig(host, userId);
  await kv.put('config.json', JSON.stringify(defaults, null, 2));
  return defaults;
}

export async function saveStoredConfig(kv: KVNamespace, config: unknown): Promise<void> {
  await kv.put('config.json', JSON.stringify(config, null, 2));
}
