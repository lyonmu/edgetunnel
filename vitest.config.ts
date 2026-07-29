import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    exclude: [
      'tests/integration/connectors/**/*.test.ts',
      'tests/unit/no-legacy.test.ts',
      'tests/unit/wrangler-config.test.ts',
    ],
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/concurrency/**/*.test.ts',
    ],
  },
});
