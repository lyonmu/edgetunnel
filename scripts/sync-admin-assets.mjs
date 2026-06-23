import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repository = 'https://github.com/EDT-Pages/EDT-Pages.github.io.git';
const commit = '630d006e82d72685067b1fa32f84d839d7ae32d2';
const checkout = join(tmpdir(), `edgetunnel-admin-${commit}`);

await rm(checkout, { recursive: true, force: true });
execFileSync('git', ['clone', repository, checkout], { stdio: 'inherit' });
execFileSync('git', ['checkout', commit], { cwd: checkout, stdio: 'inherit' });

for (const directory of ['admin', 'login', 'noADMIN', 'noKV']) {
  const destination = join('public', directory);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(join(checkout, directory), destination, { recursive: true });
}

await cp(join(checkout, 'index.html'), join('public', 'index.html'));
await writeFile(
  join('public', 'UPSTREAM.md'),
  [
    '# 后台静态资源来源',
    '',
    `- Repository: ${repository}`,
    `- Commit: ${commit}`,
    '- Synced: 2026-06-23',
    '- Local changes: none',
    '',
  ].join('\n'),
);
