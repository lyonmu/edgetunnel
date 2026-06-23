# edgetunnel 纯 Cloudflare Worker 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Pages Functions Advanced Mode 项目渐进迁移为由 Workers Builds 部署的纯 Cloudflare Worker，在保持现有代理、订阅、管理 API、配置和 KV 数据兼容的前提下完成 TypeScript 模块化、Static Assets、自定义 Socket 接口、请求状态隔离和完整验证。

**Architecture:** 迁移期间保留 `_worker.js` 作为行为基准，新实现从 `src/index.ts` 开始按模块替换。所有出站 TCP 连接统一封装在 `src/networking/sockets.ts`，每个请求创建独立 `RequestContext`；后台快照放入 `public/` 并通过 `env.ASSETS.fetch()` 提供。每一阶段必须先建立失败测试，再实现最小迁移，最后通过类型、测试、格式和 Wrangler dry-run 后提交。

**Tech Stack:** TypeScript、Cloudflare Workers、`cloudflare:sockets`、Workers Static Assets、Workers KV、Wrangler、Workers Builds、Vitest、`@cloudflare/vitest-pool-workers`、ESLint、Prettier、npm

---

## 实施前约束

- 执行计划前使用 `superpowers:using-git-worktrees` 创建隔离 worktree。
- 不直接在 `main` 上实施，分支使用 `codex/worker-migration`。
- 不修改现有 Pages 项目、自定义域和生产 KV 数据，直到 Task 16 的切换门禁通过。
- 每个任务只提交本任务涉及的文件。
- `_worker.js` 在 Task 15 前必须保留，作为特征测试和人工对照基准。
- 任何真实代理 E2E 失败都阻止自定义域切换，但不要求在普通单元测试中访问外部代理。
- 现有用户可见响应、URL、环境变量别名、Cookie 和 KV key 在本计划内保持兼容。

## 文件职责映射

### 工程与部署

- `package.json`：开发、检查、构建和同步脚本。
- `package-lock.json`：锁定 Workers Builds 与本地依赖解析。
- `tsconfig.json`：严格 TypeScript 检查。
- `eslint.config.mjs`：静态检查和 Promise 规则。
- `.prettierrc.json`：统一格式。
- `vitest.config.ts`：Workers 测试池配置。
- `wrangler.jsonc`：Worker、KV、Static Assets、Observability 和部署配置事实源。
- `worker-configuration.d.ts`：由 `wrangler types` 生成的 binding 类型。

### Worker 入口与请求状态

- `src/index.ts`：Worker 入口和顶层异常边界。
- `src/app/router.ts`：保持原入口路由优先级。
- `src/app/request-context.ts`：从 Request 和 Env 创建请求私有状态。
- `src/app/response.ts`：兼容响应和错误响应工具。
- `src/app/types.ts`：`Env`、`RequestContext`、代理运行时类型。

### 认证、管理与配置

- `src/auth/session.ts`：保持现有 Cookie 计算和验证行为。
- `src/admin/routes.ts`：管理 API 路由。
- `src/admin/assets.ts`：认证后读取 Static Assets。
- `src/config/defaults.ts`：默认配置。
- `src/config/migrate.ts`：旧配置补齐，不删除未知字段。
- `src/config/repository.ts`：KV 原始配置读写。
- `src/config/runtime.ts`：环境变量覆盖和运行时派生字段。
- `src/storage/log-repository.ts`：兼容 `log.json` 数组格式。

### 订阅

- `src/subscription/routes.ts`：`/sub` 入口和目标格式判定。
- `src/subscription/generate.ts`：mixed/base64 节点生成。
- `src/subscription/clash.ts`：Clash 热补丁。
- `src/subscription/singbox.ts`：Sing-box 热补丁。
- `src/subscription/surge.ts`：Surge 热补丁。
- `src/subscription/upstream.ts`：外部订阅、优选 API、超时和大小限制。

### 网络与代理

- `src/networking/sockets.ts`：唯一允许直接调用 `cloudflare:sockets.connect()` 的模块。
- `src/networking/proxy-runtime.ts`：解析 ProxyIP 和链式代理请求参数。
- `src/networking/proxy-connectors.ts`：SOCKS5、HTTP、HTTPS 分发。
- `src/networking/dns.ts`：DoH 和 UDP DNS。
- `src/networking/tls.ts`：现有 TLS 客户端迁移。
- `src/networking/turn.ts`：TURN 连接。
- `src/networking/sstp.ts`：SSTP 连接。
- `src/networking/stream-pump.ts`：Socket 到 WebSocket 的下行传输。
- `src/networking/upload-queue.ts`：有界上行队列。

### 协议与传输

- `src/protocols/vless.ts`：VLESS 首包解析。
- `src/protocols/trojan.ts`：Trojan 首包解析。
- `src/protocols/shadowsocks.ts`：Shadowsocks AEAD。
- `src/transports/websocket.ts`：WebSocket 入口。
- `src/transports/xhttp.ts`：XHTTP 入口。
- `src/transports/grpc.ts`：gRPC 入口。

### 静态资源与测试

- `public/`：固定版本后台页面快照。
- `public/UPSTREAM.md`：快照来源、提交、同步日期和本地变更。
- `scripts/sync-admin-assets.mjs`：显式同步指定上游提交。
- `tests/unit/`：纯逻辑测试。
- `tests/characterization/`：旧实现行为特征。
- `tests/integration/`：Worker、KV、Static Assets 和路由测试。
- `tests/concurrency/`：请求状态隔离测试。
- `tests/fixtures/`：固定输入、配置和订阅输出。
- `docs/worker-migration-runbook.md`：Workers Builds、KV 绑定、预览验证、切换和回滚手册。

---

### Task 1: 记录生产依赖并建立迁移清单

**Files:**
- Create: `docs/worker-migration-inventory.md`
- Modify: `.gitignore`

- [ ] **Step 1: 创建生产依赖清单模板**

写入：

```markdown
# Worker 迁移生产依赖清单

## Cloudflare 资源

- Pages project: edgetunnel
- Worker project: edgetunnel
- Production KV binding: KV
- Production KV namespace ID: 从当前 Pages 项目绑定记录
- Preview KV namespace ID: 单独创建并记录
- Production custom domains: 从 Pages 项目记录
- Production variables and secrets: ADMIN, KEY, UUID, PROXYIP, URL, GO2SOCKS5, DEBUG, OFF_LOG, BEST_SUB, PRELOAD_RACE_DIAL, HOST, PATH

## KV key 备份

- config.json
- tg.json
- cf.json
- ADD.txt
- log.json

## 切换前检查

- Pages 项目保持运行
- Worker 使用 workers.dev 验证
- 临时测试域验证通过
- 自定义域回退步骤已演练
```

- [ ] **Step 2: 查询并填写现有 Cloudflare 资源**

运行：

```bash
npx wrangler whoami
npx wrangler kv namespace list
```

预期：第一条显示正确账户；第二条列出当前 Pages 使用的 KV namespace。将实际 namespace ID 和自定义域写入 `docs/worker-migration-inventory.md`，不得记录 Secret 值。

- [ ] **Step 3: 导出 KV 关键配置用于离线备份**

先从清单读取生产 namespace ID，再执行备份：

```bash
mkdir -p .migration-backup
PROD_KV_ID="$(sed -n 's/^- Production KV namespace ID: //p' docs/worker-migration-inventory.md)"
test -n "$PROD_KV_ID"
npx wrangler kv key get config.json --namespace-id "$PROD_KV_ID" --remote > .migration-backup/config.json
npx wrangler kv key get tg.json --namespace-id "$PROD_KV_ID" --remote > .migration-backup/tg.json
npx wrangler kv key get cf.json --namespace-id "$PROD_KV_ID" --remote > .migration-backup/cf.json
npx wrangler kv key get ADD.txt --namespace-id "$PROD_KV_ID" --remote > .migration-backup/ADD.txt
npx wrangler kv key get log.json --namespace-id "$PROD_KV_ID" --remote > .migration-backup/log.json
```

预期：五个文件生成；不存在的 key 记录为空文件并在清单中注明。

- [ ] **Step 4: 忽略本地迁移备份**

在 `.gitignore` 添加：

```gitignore
# 本地迁移备份，可能包含敏感配置
.migration-backup/
```

- [ ] **Step 5: 验证未提交敏感文件**

运行：

```bash
git status --short
git check-ignore -v .migration-backup/config.json
```

预期：备份文件不出现在 `git status`，`git check-ignore` 指向 `.gitignore`。

- [ ] **Step 6: 提交迁移清单**

```bash
git add .gitignore docs/worker-migration-inventory.md
git commit -m "docs: 记录 Worker 迁移资源"
```

---

### Task 2: 建立 TypeScript、测试与质量检查工程

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/app/types.ts`
- Create: `tests/unit/smoke.test.ts`

- [ ] **Step 1: 初始化 npm 并安装固定开发依赖**

运行：

```bash
npm init -y
npm install --save-dev typescript wrangler vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types eslint @eslint/js typescript-eslint eslint-plugin-promise prettier
```

预期：生成 `package-lock.json`，安装无错误。

- [ ] **Step 2: 写入工程脚本**

将 `package.json` 的核心内容调整为：

```json
{
  "name": "edgetunnel",
  "private": true,
  "type": "module",
  "scripts": {
    "types": "wrangler types",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "build": "wrangler deploy --dry-run --outdir dist",
    "check": "npm run types && npm run typecheck && npm run test && npm run lint && npm run format:check && npm run build"
  }
}
```

保留 npm 自动写入的精确依赖版本。

- [ ] **Step 3: 写入严格 TypeScript 配置**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "WebWorker"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "useDefineForClassFields": true,
    "types": ["@cloudflare/workers-types"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts", "worker-configuration.d.ts"]
}
```

- [ ] **Step 4: 写入 ESLint 与 Prettier 配置**

`eslint.config.mjs`：

```js
import js from "@eslint/js";
import promise from "eslint-plugin-promise";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "public/**", "_worker.js", "worker-configuration.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: { promise },
    rules: {
      ...promise.configs["flat/recommended"].rules,
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error"
    }
  }
);
```

`.prettierrc.json`：

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 5: 写入基础 Vitest 配置**

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 6: 写入初始类型和失败测试**

`src/app/types.ts`：

```ts
export interface Env {
  KV: KVNamespace;
  ASSETS: Fetcher;
  ADMIN?: string;
}
```

`tests/unit/smoke.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import worker from '../../src/index';
import type { Env } from '../../src/app/types';

describe('Worker smoke', () => {
  it('serves robots.txt', async () => {
    const env = {
      KV: {} as KVNamespace,
      ASSETS: {} as Fetcher,
    } satisfies Env;
    const response = await worker.fetch(new Request('https://example.com/robots.txt'), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('User-agent: *\nDisallow: /');
  });
});
```

- [ ] **Step 7: 运行测试确认失败**

运行：

```bash
npm test
```

预期：因为 `src/index.ts` 尚未建立而失败。

- [ ] **Step 8: 写入最小 Worker 入口**

`src/index.ts`：

```ts
import type { Env } from './app/types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /', {
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 9: 运行基础测试和类型检查**

```bash
npm test
npm run typecheck
```

预期：全部通过。

- [ ] **Step 10: 提交工程基础**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.mjs .prettierrc.json vitest.config.ts src tests
git commit -m "chore: 建立 Worker TypeScript 工程"
```

---

### Task 3: 建立 Wrangler、KV 与 Static Assets 配置

**Files:**
- Create: `wrangler.jsonc`
- Create: `scripts/create-worker-config.mjs`
- Create: `public/index.html`
- Modify: `vitest.config.ts`
- Generate: `worker-configuration.d.ts`
- Delete at completion of task: `wrangler.toml`

- [ ] **Step 1: 从 Task 1 清单读取生产和预览 KV ID**

运行：

```bash
rg -n "Production KV namespace ID|Preview KV namespace ID" docs/worker-migration-inventory.md
```

预期：两项均有实际 ID。若没有 Preview namespace，先运行 `npx wrangler kv namespace create edgetunnel-preview` 并记录返回 ID。

- [ ] **Step 2: 写入确定性 Worker 配置生成器**

`scripts/create-worker-config.mjs`：

```js
import { readFile, writeFile } from 'node:fs/promises';

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

await writeFile('wrangler.jsonc', `${JSON.stringify(config, null, 2)}\n`);
```

- [ ] **Step 3: 生成 Worker 配置**

运行：

```bash
node scripts/create-worker-config.mjs
```

预期：生成 `wrangler.jsonc`，其中两个 KV ID 与清单完全一致。

- [ ] **Step 4: 写入测试池配置**

`vitest.config.ts`：

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          kvNamespaces: ['KV'],
        },
      },
    },
  },
});
```

- [ ] **Step 5: 写入最小静态首页**

`public/index.html`：

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Welcome to nginx!</title>
  </head>
  <body>
    <h1>Welcome to nginx!</h1>
  </body>
</html>
```

- [ ] **Step 6: 生成绑定类型并运行基础验证**

运行：

```bash
npm run types
npm run typecheck
npm test
npm run build
```

预期：全部通过；dry-run 输出 Worker bundle 和 assets manifest。

- [ ] **Step 7: 删除旧 Worker 风格配置**

删除 `wrangler.toml`，避免两个 Wrangler 配置互相冲突。

- [ ] **Step 8: 提交 Worker 配置**

```bash
git add wrangler.jsonc scripts/create-worker-config.mjs vitest.config.ts worker-configuration.d.ts public/index.html wrangler.toml
git commit -m "build: 配置 Worker 与静态资源"
```

---

### Task 4: 固定并导入后台静态资源快照

**Files:**
- Create: `scripts/sync-admin-assets.mjs`
- Create: `public/UPSTREAM.md`
- Create/Replace: `public/admin/index.html`
- Create: `public/login/index.html`
- Create: `public/noADMIN/index.html`
- Create: `public/noKV/index.html`
- Create: `tests/integration/assets.test.ts`

- [ ] **Step 1: 写入失败的静态资源测试**

```ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('admin assets', () => {
  it.each([
    ['/login', 'edgetunnel'],
    ['/admin', '优选'],
    ['/noADMIN', 'ADMIN'],
    ['/noKV', 'KV'],
  ])('serves %s from local assets', async (path, marker) => {
    const response = await SELF.fetch(`https://example.com${path}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(marker);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：

```bash
npx vitest run tests/integration/assets.test.ts
```

预期：四个资源断言失败。

- [ ] **Step 3: 写入可复现同步脚本**

`scripts/sync-admin-assets.mjs` 必须：

```js
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repository = 'https://github.com/EDT-Pages/EDT-Pages.github.io.git';
const commit = '630d006e82d72685067b1fa32f84d839d7ae32d2';
const checkout = join(tmpdir(), `edgetunnel-admin-${commit}`);

await rm(checkout, { recursive: true, force: true });
execFileSync('git', ['clone', repository, checkout], { stdio: 'inherit' });
execFileSync('git', ['checkout', commit], { cwd: checkout, stdio: 'inherit' });

for (const directory of ['admin', 'login', 'noADMIN', 'noKV']) {
  await mkdir(join('public', directory), { recursive: true });
  await cp(join(checkout, directory), join('public', directory), { recursive: true });
}
await cp(join(checkout, 'index.html'), join('public', 'index.html'));
await writeFile(
  join('public', 'UPSTREAM.md'),
  `# 后台静态资源来源\n\n- Repository: ${repository}\n- Commit: ${commit}\n- Synced: 2026-06-23\n- Local changes: none\n`,
);
```

- [ ] **Step 4: 执行同步并验证快照**

运行：

```bash
node scripts/sync-admin-assets.mjs
npx vitest run tests/integration/assets.test.ts
```

预期：静态资源测试通过，`public/UPSTREAM.md` 记录固定提交。

- [ ] **Step 5: 检查后台仍调用现有相对 API**

运行：

```bash
rg -n "fetch\\('/(login|admin|version|logout)|fetch\\(`/admin" public/admin/index.html public/login/index.html
```

预期：后台继续调用当前域名下现有 API，不包含对旧 Pages 项目的硬编码。

- [ ] **Step 6: 提交后台快照**

```bash
git add scripts/sync-admin-assets.mjs public tests/integration/assets.test.ts
git commit -m "feat: 内置后台静态资源"
```

---

### Task 5: 建立旧实现特征测试工具

**Files:**
- Create: `tests/characterization/helpers/load-legacy-worker.ts`
- Create: `tests/characterization/pure-functions.test.ts`
- Create: `tests/fixtures/legacy/`
- Modify: `_worker.js` only if export hooks are required, without changing runtime behavior

- [ ] **Step 1: 写入旧实现提取器**

`load-legacy-worker.ts` 使用 Node `vm` 读取 `_worker.js`，把 `export default` 替换为局部变量，并在源码末尾附加测试导出：

```ts
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const exportedNames = [
  '整理成数组',
  '获取SOCKS5账号',
  '获取代理默认端口',
  '数据转Uint8Array',
  '拼接字节数据',
  '解析木马请求',
  '解析魏烈思请求',
  '获取传输协议配置',
  '获取传输路径参数值',
] as const;

export async function loadLegacyWorker(): Promise<Record<(typeof exportedNames)[number], unknown>> {
  const source = await readFile('_worker.js', 'utf8');
  const transformed = source.replace('export default {', 'const legacyWorker = {');
  const exportSource = `\n;globalThis.__legacy = { ${exportedNames.join(', ')} };`;
  const context = vm.createContext({
    URL,
    Proxy,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    crypto,
    atob,
    btoa,
    console,
  });
  vm.runInContext(`${transformed}${exportSource}`, context);
  return (context as Record<string, unknown>).__legacy as Record<
    (typeof exportedNames)[number],
    unknown
  >;
}
```

第一批固定函数：

```text
整理成数组
获取SOCKS5账号
获取代理默认端口
数据转Uint8Array
拼接字节数据
解析木马请求
解析魏烈思请求
获取传输协议配置
获取传输路径参数值
```

测试工具不暴露 `legacyWorker.fetch`，因此不会执行真实网络请求。

- [ ] **Step 2: 写入固定输入输出测试**

覆盖至少：

```ts
it('parses authenticated IPv4 proxy', () => {
  expect(legacy.获取SOCKS5账号('user:pass@127.0.0.1:1080', 80)).toEqual({
    username: 'user',
    password: 'pass',
    hostname: '127.0.0.1',
    port: 1080,
  });
});

it('rejects unbracketed IPv6', () => {
  expect(() => legacy.获取SOCKS5账号('2001:db8::1', 1080)).toThrow('IPv6');
});
```

- [ ] **Step 3: 运行特征测试**

```bash
npx vitest run tests/characterization/pure-functions.test.ts
```

预期：全部通过，证明测试捕获当前行为。

- [ ] **Step 4: 提交特征测试框架**

```bash
git add tests/characterization tests/fixtures _worker.js
git commit -m "test: 建立旧实现行为基线"
```

---

### Task 6: 创建请求上下文并消除入口级全局状态

**Files:**
- Create: `src/app/request-context.ts`
- Create: `src/networking/proxy-runtime.ts`
- Create: `tests/unit/request-context.test.ts`
- Create: `tests/concurrency/request-state.test.ts`
- Modify: `src/app/types.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 写入失败的上下文测试**

测试必须断言：

```ts
const cmcc = await createRequestContext(cmccRequest, env, execution);
const normal = await createRequestContext(normalRequest, env, execution);
expect(cmcc.dialConcurrency).toBe(1);
expect(normal.dialConcurrency).toBe(2);
expect(cmcc.debug).toBe(false);
expect(normal.proxy.address).not.toBe(cmcc.proxy.address);
```

并发测试同时创建带不同 `proxyip`、`socks5`、`globalproxy` 的上下文，断言对象互不共享引用。

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/unit/request-context.test.ts tests/concurrency/request-state.test.ts
```

预期：`createRequestContext` 不存在而失败。

- [ ] **Step 3: 定义运行时类型**

`src/app/types.ts` 增加：

```ts
export type ProxyType = 'proxyip' | 'socks5' | 'http' | 'https' | 'turn' | 'sstp';

export interface ProxyAddress {
  username?: string;
  password?: string;
  hostname: string;
  port: number;
}

export interface ProxyRuntimeConfig {
  type: ProxyType;
  address?: ProxyAddress;
  proxyIp: string;
  global: boolean;
  fallback: boolean;
  whitelist: readonly string[];
}

export interface RequestContext {
  request: Request;
  env: Env;
  execution: ExecutionContext;
  url: URL;
  userId: string;
  host: string;
  clientIp: string;
  userAgent: string;
  debug: boolean;
  preloadRaceDial: boolean;
  dialConcurrency: number;
  proxy: ProxyRuntimeConfig;
}
```

- [ ] **Step 4: 实现纯代理参数解析**

`parseProxyRuntime(url, defaults)` 返回新对象，不修改模块级变量。保持现有路径和查询别名：

```text
proxyip
socks5
http
https
turn
sstp
globalproxy
/video/<encoded>
/g?s5=
/g?http=
/g?https=
/g?turn=
/g?sstp=
/proxyip=
/pyip=
/ip=
```

- [ ] **Step 5: 实现请求上下文**

`createRequestContext()` 必须每次重新计算：

```ts
const dialConcurrency = identifyCarrier(request) === 'cmcc' ? 1 : 2;
const debug = ['1', 'true'].includes(env.DEBUG ?? '');
const preloadRaceDial = ['1', 'true'].includes(env.PRELOAD_RACE_DIAL ?? '');
```

禁止使用 `|| 原值` 持久化开关。

- [ ] **Step 6: 运行隔离测试**

```bash
npx vitest run tests/unit/request-context.test.ts tests/concurrency/request-state.test.ts
```

预期：全部通过。

- [ ] **Step 7: 提交请求状态隔离**

```bash
git add src/app src/networking/proxy-runtime.ts tests/unit tests/concurrency
git commit -m "refactor: 隔离请求运行状态"
```

---

### Task 7: 建立官方 Socket 适配层

**Files:**
- Create: `src/networking/sockets.ts`
- Create: `tests/unit/sockets.test.ts`
- Modify: `src/app/types.ts`

- [ ] **Step 1: 写入失败测试**

通过注入 `SocketConnector` 测试：

- 单候选成功。
- 两个候选竞速只保留胜者。
- 失败候选全部关闭。
- 超时关闭 Socket。
- 首包只写一次。

接口固定为：

```ts
export interface SocketConnector {
  connect(address: SocketAddress, options?: SocketOptions): Socket;
}

export interface DialCandidate extends SocketAddress {
  index?: number;
  resolvedFrom?: string;
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/unit/sockets.test.ts
```

- [ ] **Step 3: 实现唯一官方连接入口**

`src/networking/sockets.ts` 顶层仅此文件允许：

```ts
import { connect } from 'cloudflare:sockets';

export const cloudflareSocketConnector: SocketConnector = {
  connect(address, options) {
    return connect(address, options);
  },
};
```

并实现：

```ts
export async function openSocket(
  connector: SocketConnector,
  candidate: DialCandidate,
  timeoutMs: number,
): Promise<Socket>;

export async function raceSockets(
  connector: SocketConnector,
  candidates: readonly DialCandidate[],
  timeoutMs: number,
): Promise<{ socket: Socket; candidate: DialCandidate }>;
```

- [ ] **Step 4: 运行测试和类型检查**

```bash
npx vitest run tests/unit/sockets.test.ts
npm run typecheck
```

预期：通过，项目中除 `src/networking/sockets.ts` 外没有 `cloudflare:sockets` 导入。

- [ ] **Step 5: 提交 Socket 适配层**

```bash
git add src/networking/sockets.ts src/app/types.ts tests/unit/sockets.test.ts
git commit -m "refactor: 封装官方 Socket 接口"
```

---

### Task 8: 迁移配置、KV、认证和后台动态路由

**Files:**
- Create: `src/config/defaults.ts`
- Create: `src/config/migrate.ts`
- Create: `src/config/repository.ts`
- Create: `src/config/runtime.ts`
- Create: `src/auth/session.ts`
- Create: `src/admin/assets.ts`
- Create: `src/admin/routes.ts`
- Create: `src/storage/log-repository.ts`
- Create: `tests/unit/config.test.ts`
- Create: `tests/integration/admin.test.ts`
- Create: `src/app/router.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 写入失败的配置兼容测试**

固定断言：

- 缺失 `订阅转换配置.SUBLIST` 时补为 `false`。
- 缺失 HTTPS、TURN、SSTP 路径模板时补齐。
- 未知字段原样保留。
- `HOST`、`PATH` 环境变量覆盖行为与旧实现一致。
- 运行时 `LINK` 和脱敏字段不写回 KV。

- [ ] **Step 2: 写入失败的后台路由测试**

覆盖：

```text
GET /login
POST /login
GET /admin
GET /admin/config.json
POST /admin/config.json
GET /admin/ADD.txt
POST /admin/ADD.txt
GET /admin/log.json
GET /admin/cf.json
GET /logout
```

使用内存 KV，断言现有状态码、JSON 字段、重定向位置和 Cookie 属性。

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run tests/unit/config.test.ts tests/integration/admin.test.ts
```

- [ ] **Step 4: 实现配置四阶段处理**

接口固定为：

```ts
export async function readStoredConfig(kv: KVNamespace): Promise<unknown>;
export function migrateStoredConfig(value: unknown): StoredConfig;
export function applyEnvironmentOverrides(config: StoredConfig, env: Env): StoredConfig;
export async function buildRuntimeConfig(
  config: StoredConfig,
  context: RequestContext,
): Promise<RuntimeConfig>;
```

迁移函数必须复制对象后补齐字段，不得删除未知字段。

- [ ] **Step 5: 迁移现有认证行为**

`session.ts` 保持：

```ts
export async function createAuthToken(
  userAgent: string,
  key: string,
  admin: string,
): Promise<string>;
```

Cookie 仍为 `auth=<token>; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`。

- [ ] **Step 6: 实现 Static Assets 受保护访问**

`admin/assets.ts` 将 `/admin` 和 `/login` 映射到本地资源 Request；动态 API 在调用该函数前已经匹配。

- [ ] **Step 7: 运行配置和后台测试**

```bash
npx vitest run tests/unit/config.test.ts tests/integration/admin.test.ts
```

预期：全部通过。

- [ ] **Step 8: 提交管理与配置迁移**

```bash
git add src/config src/auth src/admin src/storage src/app src/index.ts tests
git commit -m "refactor: 迁移配置与后台路由"
```

---

### Task 9: 迁移订阅生成与外部请求边界

**Files:**
- Create: `src/subscription/routes.ts`
- Create: `src/subscription/generate.ts`
- Create: `src/subscription/clash.ts`
- Create: `src/subscription/singbox.ts`
- Create: `src/subscription/surge.ts`
- Create: `src/subscription/upstream.ts`
- Create: `src/shared/fetch-limited.ts`
- Create: `tests/characterization/subscription.test.ts`
- Create: `tests/unit/fetch-limited.test.ts`
- Modify: `src/app/router.ts`

- [ ] **Step 1: 固定旧订阅输出**

为 mixed、base64、Clash、Sing-box、Surge 创建 fixtures。对时间、随机 Host 和加载耗时进行确定性注入，不得删除协议字段或用模糊快照替代。

- [ ] **Step 2: 写入受限 fetch 失败测试**

覆盖：

- 超时触发 `AbortController`。
- `Content-Length` 超限时不读取 body。
- 流式读取超过最大字节后取消 reader。
- 非 2xx 响应保留状态。

- [ ] **Step 3: 运行测试确认新实现缺失**

```bash
npx vitest run tests/characterization/subscription.test.ts tests/unit/fetch-limited.test.ts
```

- [ ] **Step 4: 实现统一外部读取接口**

```ts
export interface FetchLimit {
  timeoutMs: number;
  maxBytes: number;
}

export async function fetchTextLimited(
  input: RequestInfo,
  init: RequestInit,
  limit: FetchLimit,
): Promise<ResponseTextResult>;
```

订阅转换、优选 API、CIDR、Usage API 和后台外部请求全部通过该接口。

- [ ] **Step 5: 逐个迁移订阅热补丁**

按以下顺序迁移并逐文件运行特征测试：

```text
Surge订阅配置文件热补丁
Clash订阅配置文件热补丁
Singbox订阅配置文件热补丁
mixed 节点生成
base64 输出
订阅转换入口
```

- [ ] **Step 6: 运行全部订阅测试**

```bash
npx vitest run tests/characterization/subscription.test.ts tests/unit/fetch-limited.test.ts
```

预期：新旧输出一致。

- [ ] **Step 7: 提交订阅迁移**

```bash
git add src/subscription src/shared src/app/router.ts tests
git commit -m "refactor: 迁移订阅生成逻辑"
```

---

### Task 10: 迁移协议解析与字节工具

**Files:**
- Create: `src/shared/bytes.ts`
- Create: `src/protocols/vless.ts`
- Create: `src/protocols/trojan.ts`
- Create: `src/protocols/shadowsocks.ts`
- Create: `tests/unit/vless.test.ts`
- Create: `tests/unit/trojan.test.ts`
- Create: `tests/unit/shadowsocks.test.ts`

- [ ] **Step 1: 写入协议 fixture**

固定：

- VLESS IPv4、域名、IPv6 首包。
- UUID 不匹配和短包。
- Trojan CRLF、域名、IPv4、IPv6、UDP DNS。
- Shadowsocks AES-128-GCM、AES-256-GCM、ChaCha20-Poly1305 加解密。

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/unit/vless.test.ts tests/unit/trojan.test.ts tests/unit/shadowsocks.test.ts
```

- [ ] **Step 3: 迁移纯字节工具**

迁移并保持签名：

```ts
export function toUint8Array(value: ArrayBuffer | ArrayBufferView): Uint8Array;
export function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array;
export function decodeUuid(uuid: string): Uint8Array;
export function matchesUuid(data: Uint8Array, offset: number, uuid: Uint8Array): boolean;
```

- [ ] **Step 4: 迁移三类协议解析**

使用可判别联合：

```ts
export type ParsedProxyRequest =
  | { ok: true; command: 'tcp' | 'udp'; hostname: string; port: number; payload: Uint8Array }
  | { ok: false; error: string };
```

保持旧实现错误判定和首包偏移。

- [ ] **Step 5: 运行协议测试**

```bash
npx vitest run tests/unit/vless.test.ts tests/unit/trojan.test.ts tests/unit/shadowsocks.test.ts
```

- [ ] **Step 6: 提交协议解析**

```bash
git add src/shared/bytes.ts src/protocols tests/unit
git commit -m "refactor: 迁移代理协议解析"
```

---

### Task 11: 迁移 DNS、TLS 与代理连接器

**Files:**
- Create: `src/networking/dns.ts`
- Create: `src/networking/tls.ts`
- Create: `src/networking/proxy-connectors.ts`
- Create: `src/networking/turn.ts`
- Create: `src/networking/sstp.ts`
- Create: `tests/unit/dns.test.ts`
- Create: `tests/unit/tls.test.ts`
- Create: `tests/unit/proxy-connectors.test.ts`

- [ ] **Step 1: 写入 DNS 和 TLS 解析失败测试**

覆盖：

- DNS A、AAAA、TXT、CNAME。
- DNS 压缩指针越界。
- TLS record 拆包和多包。
- TLS 1.2、1.3 ServerHello。
- AES-GCM 和 ChaCha20-Poly1305。

- [ ] **Step 2: 写入代理握手失败测试**

使用模拟 Socket 验证：

- SOCKS5 无认证和用户名密码认证。
- HTTP CONNECT 2xx 和非 2xx。
- HTTPS 代理先 TLS 后 CONNECT。
- TURN challenge、MESSAGE-INTEGRITY 和数据连接。
- SSTP 控制流和数据流。

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run tests/unit/dns.test.ts tests/unit/tls.test.ts tests/unit/proxy-connectors.test.ts
```

- [ ] **Step 4: 原行为迁移，不做算法重写**

按 `_worker.js` 中现有函数边界迁移：

```text
DoH查询
TlsRecordParser
TlsHandshakeParser
TlsClient
socks5Connect
httpConnect
httpsConnect
turnConnect
sstpConnect
```

仅把全局依赖改成显式参数；不得在同一任务中改变密码套件、超时或代理回退策略。

- [ ] **Step 5: 运行网络单元测试**

```bash
npx vitest run tests/unit/dns.test.ts tests/unit/tls.test.ts tests/unit/proxy-connectors.test.ts
npm run typecheck
```

- [ ] **Step 6: 提交网络底层迁移**

```bash
git add src/networking tests/unit
git commit -m "refactor: 迁移网络连接模块"
```

---

### Task 12: 迁移上传队列与下行流转发

**Files:**
- Create: `src/networking/upload-queue.ts`
- Create: `src/networking/stream-pump.ts`
- Create: `tests/unit/upload-queue.test.ts`
- Create: `tests/unit/stream-pump.test.ts`

- [ ] **Step 1: 写入背压和资源释放测试**

覆盖：

- 小包合并达到 16 KiB 后刷新。
- 队列超过 16 MiB 或 4096 项时失败。
- 写入保持顺序。
- retry 期间不重复发送首包。
- BYOB 不可用时回退普通 reader。
- WebSocket 关闭时取消 reader 并关闭 Socket。

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/unit/upload-queue.test.ts tests/unit/stream-pump.test.ts
```

- [ ] **Step 3: 迁移队列和 Grain 下行发送器**

迁移：

```text
创建上行写入队列
创建下行Grain发送器
connectStreams
WebSocket发送并等待
closeSocketQuietly
```

用类或闭包封装连接私有状态，不使用模块级可变变量。

- [ ] **Step 4: 运行背压测试**

```bash
npx vitest run tests/unit/upload-queue.test.ts tests/unit/stream-pump.test.ts
```

- [ ] **Step 5: 提交流处理模块**

```bash
git add src/networking tests/unit
git commit -m "refactor: 迁移代理流处理"
```

---

### Task 13: 分别迁移 WebSocket、XHTTP 和 gRPC

**Files:**
- Create: `src/transports/websocket.ts`
- Create: `src/transports/xhttp.ts`
- Create: `src/transports/grpc.ts`
- Create: `tests/integration/websocket.test.ts`
- Create: `tests/integration/xhttp.test.ts`
- Create: `tests/integration/grpc.test.ts`
- Modify: `src/app/router.ts`

- [ ] **Step 1: 写入 WebSocket 失败测试**

覆盖：

- 101 Upgrade。
- early data 8 KiB 上限。
- 非 early-data 子协议不注入首包。
- VLESS、Trojan、Shadowsocks 分派。
- 每条连接持有自己的 `RequestContext`。

- [ ] **Step 2: 迁移 WebSocket 并运行测试**

```bash
npx vitest run tests/integration/websocket.test.ts
```

预期：通过后提交：

```bash
git add src/transports/websocket.ts src/app/router.ts tests/integration/websocket.test.ts
git commit -m "refactor: 迁移 WebSocket 传输"
```

- [ ] **Step 3: 写入并迁移 XHTTP**

测试覆盖：

- 无 body 返回 400。
- 无效首包返回 400。
- 禁止测速站点返回 403。
- 上下行流保持顺序。
- 中断时释放 reader、writer 和 Socket。

运行：

```bash
npx vitest run tests/integration/xhttp.test.ts
```

通过后提交：

```bash
git add src/transports/xhttp.ts src/app/router.ts tests/integration/xhttp.test.ts
git commit -m "refactor: 迁移 XHTTP 传输"
```

- [ ] **Step 4: 写入并迁移 gRPC**

测试覆盖：

- `application/grpc` 路由。
- gRPC frame 拆包与合包。
- trailer 和关闭行为。
- 首包、重试和背压。

运行：

```bash
npx vitest run tests/integration/grpc.test.ts
```

通过后提交：

```bash
git add src/transports/grpc.ts src/app/router.ts tests/integration/grpc.test.ts
git commit -m "refactor: 迁移 gRPC 传输"
```

---

### Task 14: 完成入口路由兼容并建立全量集成测试

**Files:**
- Modify: `src/index.ts`
- Modify: `src/app/router.ts`
- Create: `src/app/response.ts`
- Create: `tests/integration/routes.test.ts`
- Create: `tests/concurrency/live-connections.test.ts`

- [ ] **Step 1: 固定路由优先级测试**

测试顺序：

```text
/version
WebSocket Upgrade
POST gRPC/XHTTP
HTTP → HTTPS redirect
缺少 ADMIN
KV 管理路由
/sub
/locations
/robots.txt
伪装页反代
nginx fallback
```

- [ ] **Step 2: 写入长连接隔离测试**

建立两个模拟长连接：

```text
连接 A：socks5 + globalproxy + dialConcurrency=1
连接 B：proxyip + fallback=true + dialConcurrency=2
```

在 A 建立后创建 B，再触发 A 重连，断言 A 仍使用自己的代理配置。

- [ ] **Step 3: 运行测试确认失败或差异**

```bash
npx vitest run tests/integration/routes.test.ts tests/concurrency/live-connections.test.ts
```

- [ ] **Step 4: 完成顶层路由接线**

`src/index.ts` 最终保持：

```ts
import { createRequestContext } from './app/request-context';
import { routeRequest } from './app/router';
import type { Env } from './app/types';

export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    try {
      const context = await createRequestContext(request, env, execution);
      return await routeRequest(context);
    } catch (error) {
      console.error({ event: 'request_failed', error: String(error) });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
```

具体兼容错误响应由 `routeRequest` 和领域错误映射处理，顶层 500 只处理未分类异常。

- [ ] **Step 5: 运行全部自动化检查**

```bash
npm run check
```

预期：类型、测试、lint、格式和 dry-run 构建全部通过。

- [ ] **Step 6: 提交完整入口**

```bash
git add src tests
git commit -m "refactor: 完成 Worker 路由迁移"
```

---

### Task 15: 建立 Workers Builds 和迁移运行手册

**Files:**
- Create: `docs/worker-migration-runbook.md`
- Modify: `README.md`
- Modify: `CHANGELOG`

- [ ] **Step 1: 写入 Workers Builds 配置说明**

运行手册必须明确：

```text
Production branch: main
Build command: npm run check
Deploy command: npx wrangler deploy
Non-production branch command: npx wrangler versions upload
Root directory: /
```

并记录 Cloudflare 控制台变量和 Secret 名称，不记录值。

- [ ] **Step 2: 写入预览和正式绑定规则**

说明：

- Production 绑定现有 KV。
- Preview 绑定独立 KV。
- Preview 使用独立 `ADMIN`、`KEY` 等 Secret。
- Preview 默认设置 `OFF_LOG=true`。
- Static Assets 与 Worker 同版本部署。

- [ ] **Step 3: 写入完整验证矩阵**

运行手册包含表格：

```text
管理后台 / 登录 / 配置保存 / 日志
订阅 mixed / base64 / Clash / Sing-box / Surge
WebSocket / XHTTP / gRPC
VLESS / Trojan / Shadowsocks
直连 / ProxyIP / SOCKS5 / HTTP / HTTPS / TURN / SSTP
上传 / 下载 / 重连 / DNS
```

- [ ] **Step 4: 更新 README**

删除 Pages 上传、Pages Git 和 Pages KV 说明，改为：

- Fork 或连接 GitHub。
- 在 Workers Builds 中创建 `edgetunnel`。
- 配置 KV、Static Assets 和 Secrets。
- 通过预览 URL 验证。
- 绑定 Worker Custom Domain。

- [ ] **Step 5: 更新 CHANGELOG**

在未发布区记录：

- 平台迁移为纯 Worker。
- 内置后台 Static Assets。
- TypeScript 模块化。
- 官方 Socket API。
- 外部行为保持兼容。

- [ ] **Step 6: 检查文档不再推荐 Pages**

```bash
rg -n "Pages 上传|Pages \\+ GitHub|Pages Functions|_worker.js" README.md docs/worker-migration-runbook.md
```

预期：仅迁移背景或回滚说明可以出现 Pages，不再作为新部署方式。

- [ ] **Step 7: 提交部署文档**

```bash
git add README.md CHANGELOG docs/worker-migration-runbook.md
git commit -m "docs: 更新纯 Worker 部署流程"
```

---

### Task 16: 预览部署与真实代理 E2E 门禁

**Files:**
- Create: `docs/e2e/worker-preview-results.md`
- Modify: code only when a reproduced incompatibility requires a scoped fix

- [ ] **Step 1: 推送非生产分支并等待 Workers Builds**

运行：

```bash
git push -u origin codex/worker-migration
```

预期：Workers Builds 执行 `npm run check` 和 `wrangler versions upload`，生成预览 URL。

- [ ] **Step 2: 验证后台和 KV**

在预览 URL 验证：

```text
/login
/admin
/admin/config.json
/admin/ADD.txt
/admin/log.json
/sub
/version
```

只使用 Preview KV，不修改生产 KV。

- [ ] **Step 3: 运行真实代理矩阵**

使用现有客户端和授权测试目标验证：

```text
VLESS × WebSocket/XHTTP/gRPC
Trojan × WebSocket/XHTTP/gRPC
Shadowsocks × WebSocket
直连
ProxyIP
SOCKS5
HTTP
HTTPS
TURN
SSTP
UDP DNS
大文件上传和下载
断线重连
```

- [ ] **Step 4: 记录证据**

`docs/e2e/worker-preview-results.md` 每项记录：

- 日期。
- 预览版本 ID。
- 客户端及版本。
- 测试路径。
- 结果。
- 失败日志摘要。
- 是否阻止切换。

- [ ] **Step 5: 对失败执行系统化调试**

若出现任何失败，先使用 `superpowers:systematic-debugging`，复现并定位后新增回归测试，再做最小修复。禁止通过改变协议输出或降低测试要求绕过失败。

- [ ] **Step 6: 提交 E2E 结果和必要修复**

```bash
git add docs/e2e src tests
git commit -m "test: 记录 Worker 预览验证"
```

---

### Task 17: 删除旧实现并完成最终验证

**Files:**
- Delete: `_worker.js`
- Delete: obsolete legacy test loader if no longer needed
- Modify: `tests/characterization/`
- Modify: `README.md`

- [ ] **Step 1: 将仍依赖旧文件的特征 fixture 固化**

运行：

```bash
rg -n "_worker\\.js|load-legacy-worker" tests src package.json
```

将需要长期保留的旧输出转为已审阅 fixture，新实现测试不得在运行时读取 `_worker.js`。

- [ ] **Step 2: 删除旧实现**

删除 `_worker.js` 以及仅用于动态加载旧文件的测试工具。

- [ ] **Step 3: 运行全量检查**

```bash
npm ci
npm run check
git diff --check
git status --short
```

预期：全部通过，仓库不再包含 `_worker.js`，只有预期修改。

- [ ] **Step 4: 检查非公开 Socket 接口已清除**

```bash
rg -n "request\\.fetcher|fetcher\\.connect|Pages静态页面" src public README.md
```

预期：无匹配。

- [ ] **Step 5: 提交旧实现删除**

```bash
git add -A
git commit -m "refactor: 删除旧 Pages 实现"
```

---

### Task 18: 正式切换、自定义域验证与回滚演练

**Files:**
- Modify: `docs/e2e/worker-production-results.md`
- Modify: `docs/worker-migration-inventory.md`

- [ ] **Step 1: 合并前执行最终审查**

使用 `superpowers:requesting-code-review` 审查：

- 外部行为兼容。
- 请求状态隔离。
- Socket 生命周期。
- KV 数据兼容。
- Secret 泄露。
- 测试覆盖和部署配置。

- [ ] **Step 2: 请求正式切换授权**

向用户提交以下证据并等待明确批准：

```text
npm run check 结果
Workers Builds 预览版本 ID
真实代理 E2E 结果
生产 KV 备份状态
自定义域切换步骤
回滚步骤
预计影响窗口
```

未获得用户明确批准，不得合并到生产分支、修改自定义域或停用 Pages。

- [ ] **Step 3: 合并并等待生产部署**

合并到 `main` 后确认 Workers Builds：

```text
npm run check 成功
npx wrangler deploy 成功
Worker 版本 ID 已记录
Static Assets 版本与 Worker 一致
```

- [ ] **Step 4: 在 workers.dev 做生产绑定只读验证**

验证配置读取、订阅生成和后台读取。切换域名前不要执行会破坏生产配置的写操作。

- [ ] **Step 5: 切换自定义域**

将正式自定义域从 Pages 项目迁移到 Worker Custom Domain。记录切换时间、旧 Pages 项目和 Worker 版本 ID。

- [ ] **Step 6: 执行生产冒烟测试**

验证：

```text
登录
后台资源
订阅读取
WebSocket
XHTTP
gRPC
至少一个直连节点
至少一个链式代理节点
KV 配置读取
```

- [ ] **Step 7: 执行回滚演练**

在不影响正式用户的测试域或维护窗口内确认：

- Worker 可回滚到上一版本。
- 自定义域可重新绑定 Pages。
- Pages 原项目仍可响应。

- [ ] **Step 8: 记录生产结果**

写入 `docs/e2e/worker-production-results.md`，并在清单中标记：

```text
正式切换完成
回滚路径已验证
Pages 停止自动部署
Pages 项目保留观察期
```

- [ ] **Step 9: 提交切换记录**

```bash
git add docs/e2e/worker-production-results.md docs/worker-migration-inventory.md
git commit -m "docs: 记录 Worker 正式切换"
```

---

## 最终验收命令

```bash
npm ci
npm run types
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
git diff --check
rg -n "request\\.fetcher|fetcher\\.connect|Pages静态页面" src public README.md
```

预期：

- 所有命令成功。
- 最后一条 `rg` 无匹配。
- Workers Builds 生产部署成功。
- Worker 和 Static Assets 同版本。
- 现有生产 KV 数据可读写。
- 真实代理 E2E 矩阵全部通过。
- 自定义域切换和回滚路径均已验证。
