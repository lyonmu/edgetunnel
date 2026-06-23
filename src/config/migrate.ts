import { createDefaultConfig } from './defaults';
import type { StoredConfig } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeDefaults(defaults: unknown, value: unknown): unknown {
  if (!isRecord(defaults) || !isRecord(value)) {
    return value === undefined ? structuredClone(defaults) : structuredClone(value);
  }
  const result: Record<string, unknown> = structuredClone(defaults);
  for (const [key, child] of Object.entries(value)) {
    result[key] = key in defaults ? mergeDefaults(defaults[key], child) : structuredClone(child);
  }
  return result;
}

export function migrateStoredConfig(value: unknown): StoredConfig {
  const input = isRecord(value) ? value : {};
  const host = typeof input.HOST === 'string' ? input.HOST : '';
  const userId = typeof input.UUID === 'string' ? input.UUID : '';
  return mergeDefaults(createDefaultConfig(host, userId), input) as StoredConfig;
}
