import { createDefaultConfig } from './defaults';
import type { WorkerConfigV1 } from './schema';
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
