import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface WranglerConfig {
  main: string;
  compatibility_date: string;
  workers_dev: boolean;
  preview_urls: boolean;
  assets: { directory: string; binding: string; run_worker_first: boolean };
  secrets: { required: string[] };
  kv_namespaces: Array<{ binding: string; id: string; preview_id?: string }>;
  env: Record<
    string,
    {
      name: string;
      vars?: Record<string, unknown>;
      secrets: { required: string[] };
      kv_namespaces: Array<{ binding: string; id: string }>;
    }
  >;
  observability: { enabled: boolean; head_sampling_rate: number };
}

function readConfig(): WranglerConfig {
  const path = resolve(import.meta.dirname, '../../wrangler.jsonc');
  const json = readFileSync(path, 'utf8').replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(json) as WranglerConfig;
}

describe('Wrangler production boundary', () => {
  it('builds exclusively from the module Worker entry with local assets', () => {
    const config = readConfig();

    expect(config.main).toBe('src/index.ts');
    expect(config.compatibility_date).toBe('2026-07-29');
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(true);
    expect(config.assets).toEqual({
      directory: './public',
      binding: 'ASSETS',
      run_worker_first: true,
    });
  });

  it('isolates Preview storage and declares secrets without plaintext vars', () => {
    const config = readConfig();
    const productionKv = config.kv_namespaces.find(({ binding }) => binding === 'KV');
    const preview = config.env.preview;
    const previewKv = preview?.kv_namespaces.find(({ binding }) => binding === 'KV');
    const requiredSecrets = [
      'ADMIN',
      'UUID',
      'CONFIG_KEY',
      'TROJAN_PASSWORD',
      'SHADOWSOCKS_PASSWORD',
    ];

    expect(preview?.name).toBe('edgetunnel-preview');
    expect(productionKv?.id).toBeTruthy();
    expect(previewKv?.id).toBeTruthy();
    expect(previewKv?.id).not.toBe(productionKv?.id);
    expect(preview?.vars).toBeUndefined();
    expect(config.secrets.required).toEqual(requiredSecrets);
    expect(preview?.secrets.required).toEqual(requiredSecrets);
    expect(config.observability).toEqual({ enabled: true, head_sampling_rate: 0.1 });
  });
});
