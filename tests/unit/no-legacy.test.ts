import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function files(path: string): string[] {
  return readdirSync(path)
    .flatMap((name) => {
      const child = resolve(path, name);
      return statSync(child).isDirectory() ? files(child) : [child];
    })
    .filter((path) => /\.(?:ts|js|json|html|css|md)$/.test(path));
}

describe('pure Worker repository boundary', () => {
  it('contains no legacy Worker, migration scripts or compatibility assets', () => {
    for (const path of [
      '_worker.js',
      '_worker.d.ts',
      'src/config/migrate.ts',
      'src/config/legacy-defaults.ts',
      'src/config/types.ts',
      'src/networking/proxy-runtime.ts',
      'src/networking/tcp-connector.ts',
      'src/auth/legacy-session.ts',
      'src/shared/hash.ts',
      'tests/characterization',
      'tests/integration/legacy-bridge.test.ts',
      'scripts/create-worker-config.mjs',
      'scripts/sync-admin-assets.mjs',
      'public/noADMIN',
      'public/noKV',
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }
  });

  it('does not reference legacy config keys, aliases or URL credential parsing', () => {
    const sourcePaths = [
      ...files(resolve(root, 'src')),
      ...files(resolve(root, 'public')),
      resolve(root, 'package.json'),
      resolve(root, 'wrangler.jsonc'),
    ];

    for (const forbidden of [
      'migrateStoredConfig',
      'md5Twice',
      'SUBAPI',
      'GO2SOCKS5',
      'createConnectTCP',
      'parseProxyRuntime',
      'config.json',
    ]) {
      const offenders = sourcePaths
        .filter((path) => readFileSync(path, 'utf8').includes(forbidden))
        .map((path) => path.slice(root.length + 1));
      expect(offenders, forbidden).toEqual([]);
    }
  });
});
