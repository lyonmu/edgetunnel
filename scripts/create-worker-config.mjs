import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';

const inventory = await readFile('docs/worker-migration-inventory.md', 'utf8');

function readInventoryValue(label) {
  const match = inventory.match(new RegExp(`^- ${label}: (.+)$`, 'm'));
  if (!match?.[1]?.trim()) {
    throw new Error(`Missing inventory value: ${label}`);
  }
  return match[1].trim();
}

const productionKvId = readInventoryValue('Production KV namespace ID');
const previewKvId = readInventoryValue('Preview KV namespace ID');

const config = {
  $schema: 'node_modules/wrangler/config-schema.json',
  name: 'edgetunnel',
  main: 'src/index.ts',
  compatibility_date: '2026-06-23',
  workers_dev: true,
  preview_urls: true,
  assets: {
    directory: './public',
    binding: 'ASSETS',
    run_worker_first: true,
  },
  kv_namespaces: [
    {
      binding: 'KV',
      id: productionKvId,
      preview_id: previewKvId,
    },
  ],
  observability: {
    enabled: true,
    head_sampling_rate: 0.1,
  },
};

const content = await format(JSON.stringify(config), {
  parser: 'jsonc',
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
});

await writeFile('wrangler.jsonc', content);
