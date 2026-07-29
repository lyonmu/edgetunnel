import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/characterization/**/*.test.ts', 'tests/integration/connectors/**/*.test.ts'],
  },
});
