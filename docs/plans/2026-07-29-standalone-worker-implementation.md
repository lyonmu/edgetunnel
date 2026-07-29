# EdgeTunnel 独立 Worker 工具实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `codex/worker-migration` 成果上完成独立 Cloudflare Worker 代理工具，保留已验证的数据面能力，替换旧配置、安全和后台边界，并删除 Pages 兼容实现。

**Architecture:** 现有 transport、protocol、networking 和 subscription 模块作为迁移基线。新实现先建立 `WorkerConfigV1`、加密 Secret Store 和 HMAC 会话，再通过不可变 `RuntimeSnapshot` 将已有数据面接入统一 profile/dialer；最后替换后台、删除旧桥并执行 Preview 验证。

**Tech Stack:** TypeScript 6、Cloudflare Workers、`cloudflare:sockets`、Workers KV、Static Assets、Web Crypto、Wrangler 4、Vitest、`@cloudflare/vitest-pool-workers`、ESLint、Prettier

## Global Constraints

- 只在 `/Users/lyonmu/workspace/code/my/github/edgetunnel/.worktrees/worker-migration` 和分支 `codex/worker-migration` 中实施。
- 复用现有协议、传输、连接器、订阅和测试实现，不重新搭建项目。
- 不修改、部署、删除原 Pages 项目，不修改 Pages 自定义域或生产 KV。
- 不兼容旧 KV key、旧中文配置字段、旧环境变量别名、旧 Cookie 或 URL 内嵌代理凭据。
- Production 不在本计划中部署；Preview 上传必须保持零 Production 流量。
- `docs/superpowers/` 是本地工具产物，不得修改、暂存或提交。
- 所有行为变更先写失败测试，再写最小实现。
- 每个任务形成一个职责单一的 Conventional Commit，提交描述使用中文且不超过 50 字。
- 每次提交前运行该任务的定向测试、`npm run typecheck` 和 `git diff --check`。
- 最终运行 `npm run check`，不得弱化测试或忽略真实失败。

## 文件职责映射

### 配置与安全

- `src/config/schema.ts`：`WorkerConfigV1`、profile、路由和订阅判别联合类型。
- `src/config/validate.ts`：严格解析未知 JSON、字段范围、路径冲突和引用完整性。
- `src/config/defaults.ts`：不含秘密的 v1 默认配置。
- `src/config/repository.ts`：`edgetunnel:config:v1` 的读取、初始化和 revision 并发写入。
- `src/config/runtime.ts`：从已验证配置和 Worker Secrets 构造不可变快照。
- `src/security/crypto.ts`：base64url、HMAC、固定耗时比较和 AES-GCM 基元。
- `src/security/secret-store.ts`：`edgetunnel:secrets:v1` 加密凭据存储。
- `src/auth/session.ts`：版本化、限时 HMAC 管理会话。

### 应用与后台

- `src/app/types.ts`：只保留生成的 `Env` 所需之外的应用类型。
- `src/app/request-context.ts`：创建请求元数据，不再解析旧环境变量或 URL 代理。
- `src/app/router.ts`：明确管理、订阅、数据面、健康和伪装页顺序。
- `src/app/response.ts`：稳定 JSON 成功/错误结构和 request ID。
- `src/admin/routes.ts`：`/api/admin/v1/*` 路由、Origin 与会话校验。
- `src/admin/service.ts`：配置、profile 测试、订阅预览和日志服务。
- `public/admin/*`：精简、无远程依赖的管理页面。
- `public/login/*`：使用 JSON session API 的登录页面。

### 数据面

- `src/networking/dialer.ts`：路由规则匹配和 profile 连接分发。
- `src/networking/connectors/types.ts`：统一 `Connector` 接口。
- `src/networking/connectors/registry.ts`：复用现有 direct/ProxyIP/SOCKS5/HTTP(S)/TURN/SSTP。
- `src/networking/xudp.ts`：XUDP 帧解析和编码。
- `src/networking/udp-dns.ts`：PacketAddr/XUDP 到 DoH 的统一数据报会话。
- `src/transports/bridge.ts`：只保留通用首包会话和流桥，不含旧迁移语义。
- `src/transports/websocket.ts`、`grpc.ts`、`xhttp.ts`：消费统一 runtime/dialer。

### 订阅、日志和交付

- `src/subscription/model.ts`：规范化 `SubscriptionNode`。
- `src/subscription/generate.ts`：入站和传输组合到节点模型。
- `src/subscription/clash.ts`、`singbox.ts`、`surge.ts`：原生序列化。
- `src/subscription/routes.ts`：HMAC token、格式选择和安全响应。
- `src/storage/log-repository.ts`：有界、脱敏结构化事件。
- `wrangler.jsonc`：新 Env、Preview 隔离、当前兼容日期。
- `README.md`、`docs/worker-migration-runbook.md`：独立 Worker 部署和验收。

---

### Task 1: 建立 WorkerConfigV1 与严格校验

**Files:**

- Create: `src/config/schema.ts`
- Create: `src/config/validate.ts`
- Modify: `src/config/defaults.ts`
- Create: `src/config/legacy-defaults.ts`
- Modify: `src/config/migrate.ts`
- Modify: `src/config/repository.ts`
- Modify: `src/admin/routes.ts`
- Modify: `tests/integration/subscription.test.ts`
- Test: `tests/unit/config-schema.test.ts`

**Interfaces:**

- Produces: `WorkerConfigV1`、`EgressProfile`、`RoutingRule`、`SubscriptionFormat`
- Produces: `createDefaultConfig(): WorkerConfigV1`
- Produces: `parseWorkerConfig(value: unknown): WorkerConfigV1`
- Produces: `ConfigValidationError`，含 `issues: readonly ConfigIssue[]`

- [x] **Step 1: 写配置模型失败测试**

覆盖默认配置、未知字段、错误 schemaVersion、端口越界、重复 profile ID、缺失默认 profile、
管理/订阅/传输路径冲突和规则引用不存在 profile。

```ts
expect(parseWorkerConfig(createDefaultConfig())).toEqual(createDefaultConfig());
expect(() => parseWorkerConfig({ ...createDefaultConfig(), extra: true })).toThrow(
  ConfigValidationError,
);
expect(() =>
  parseWorkerConfig({
    ...createDefaultConfig(),
    routing: { defaultProfileId: 'missing', rules: [], blockPrivateTargets: true },
  }),
).toThrow(/defaultProfileId/);
```

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run --config vitest.config.ts tests/unit/config-schema.test.ts`

Expected: FAIL，提示 `src/config/schema.ts` 或 `parseWorkerConfig` 不存在。

- [x] **Step 3: 定义判别联合与默认配置**

`EgressProfile` 必须用 `type` 区分 `direct`、`proxyip`、`socks5`、`http-connect`、
`https-connect`、`turn`、`sstp`；所有 credential 只保留 `credentialRef`，不得包含 password。
默认配置仅启用 VLESS + WebSocket、direct profile、DoH `https://1.1.1.1/dns-query`。

- [x] **Step 4: 实现无依赖严格解析器**

逐层检查 plain object、必填键、未知键、字符串长度、数值范围、URL scheme、路径唯一性、ID 唯一性和
引用完整性。错误路径使用 JSON Pointer，例如 `/egressProfiles/1/port`。

- [x] **Step 5: 运行配置测试和类型检查**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/config-schema.test.ts
npm run typecheck
git diff --check
```

Expected: 全部通过。

- [x] **Step 6: 提交**

```bash
git add src/config/schema.ts src/config/validate.ts src/config/defaults.ts tests/unit/config-schema.test.ts
git commit -m "feat(config): 建立版本化配置模型"
```

### Task 2: 实现 revision 配置仓库

**Files:**

- Modify: `src/config/repository.ts`
- Test: `tests/unit/config-repository.test.ts`

**Interfaces:**

- Consumes: `parseWorkerConfig(value): WorkerConfigV1`
- Produces: `CONFIG_KEY = 'edgetunnel:config:v1'`
- Produces: `loadConfig(kv): Promise<WorkerConfigV1>`
- Produces: `saveConfig(kv, config, expectedRevision): Promise<WorkerConfigV1>`
- Produces: `ConfigRevisionConflict`

- [x] **Step 1: 写 KV 初始化和并发冲突测试**

使用内存 KV fixture 验证：缺 key 时写入 revision 1 默认配置；读取非法 JSON 时拒绝；expectedRevision
不一致时不写；成功保存 revision 增加 1；`config.json` 永远不读取。

- [x] **Step 2: 运行定向测试确认失败**

Run: `npx vitest run --config vitest.config.ts tests/unit/config-repository.test.ts`

Expected: FAIL，旧 Repository 仍访问 `config.json`。

- [x] **Step 3: 替换 Repository**

先读取并严格解析当前配置；保存时比较 `revision`，构造 `{...config, revision: current + 1}` 后只写
`edgetunnel:config:v1`。KV 写失败原样抛出，不回退旧 key。

- [x] **Step 4: 保持旧 Repository 测试隔离**

旧 `tests/unit/config.test.ts` 继续只验证临时 legacy 边界；v1 默认值、严格读取、初始化和 revision
断言全部放入新测试。Task 13 删除 legacy 边界时再删除旧测试，避免中间提交丢失现有回归信号。

- [x] **Step 5: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/unit/config-schema.test.ts tests/unit/config-repository.test.ts
npm run typecheck
git diff --check
git add src/config/repository.ts tests/unit/config-repository.test.ts
git commit -m "feat(config): 增加配置并发版本控制"
```

### Task 3: 建立加密 Secret Store

**Files:**

- Create: `src/security/crypto.ts`
- Create: `src/security/secret-store.ts`
- Test: `tests/unit/crypto.test.ts`
- Test: `tests/unit/secret-store.test.ts`

**Interfaces:**

- Produces: `timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean`
- Produces: `signHmac(key: string, payload: Uint8Array): Promise<Uint8Array>`
- Produces: `encryptJson(key, aad, value): Promise<EncryptedEnvelope>`
- Produces: `decryptJson<T>(key, aad, envelope): Promise<T>`
- Produces: `SecretStore.read(ref): Promise<ProfileCredential | null>`
- Produces: `SecretStore.write(ref, credential): Promise<void>`
- Produces: `SecretStore.delete(ref): Promise<void>`

- [x] **Step 1: 写密码学基元测试**

验证 base64url round-trip、相同/不同长度固定耗时比较结果、HMAC 确定性、AES-GCM 随机 nonce、
错误 key/AAD/篡改 ciphertext 均拒绝。

- [x] **Step 2: 写 Secret Store 测试**

内存 KV 中只允许出现 envelope，不出现用户名或密码明文；profile A 的密文不能以 profile B 的 AAD
解密；删除后读取 null。

- [x] **Step 3: 运行测试确认失败**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/crypto.test.ts tests/unit/secret-store.test.ts
```

Expected: FAIL，security 模块不存在。

- [x] **Step 4: 使用 Web Crypto 实现**

`CONFIG_KEY` 接受 32 字节 base64url；AES-GCM 使用 12 字节随机 nonce；AAD 为
`edgetunnel:secrets:v1:<credentialRef>`；KV key 固定为 `edgetunnel:secrets:v1`。

- [x] **Step 5: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/unit/crypto.test.ts tests/unit/secret-store.test.ts
npm run typecheck
git diff --check
git add src/security tests/unit/crypto.test.ts tests/unit/secret-store.test.ts
git commit -m "feat(security): 加密存储代理凭据"
```

### Task 4: 升级 HMAC 管理会话与订阅令牌

**Files:**

- Modify: `src/auth/session.ts`
- Create: `src/auth/legacy-session.ts`
- Create: `src/auth/subscription-token.ts`
- Modify: `src/admin/routes.ts`
- Modify: `src/app/response.ts`
- Modify: `tests/integration/admin.test.ts`
- Modify: `tests/integration/http-fallback.test.ts`
- Test: `tests/unit/session.test.ts`
- Test: `tests/unit/subscription-token.test.ts`

**Interfaces:**

- Consumes: `signHmac`、`timingSafeEqual`
- Produces: `createSession(adminSecret, now): Promise<string>`
- Produces: `verifySession(token, adminSecret, now): Promise<boolean>`
- Produces: `sessionCookie(token): string`、`expiredSessionCookie(): string`
- Produces: `createSubscriptionToken(adminSecret, uuid): Promise<string>`
- Produces: `verifySubscriptionToken(candidate, adminSecret, uuid): Promise<boolean>`

- [x] **Step 1: 写会话失败测试**

验证版本、8 小时 TTL、未来签发时间、篡改、错误 Secret、Cookie 的
`Secure; HttpOnly; SameSite=Strict; Path=/`。

- [x] **Step 2: 写订阅 token 失败测试**

验证 token 不等于 UUID/ADMIN/MD5，输入相同结果稳定，错误 token 和长度不同均返回 false。

- [x] **Step 3: 运行测试确认旧 MD5 实现失败**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/session.test.ts tests/unit/subscription-token.test.ts
```

- [x] **Step 4: 实现新认证并隔离旧调用**

令牌 payload 使用 `v1.<iat>.<exp>.<nonce>`，签名附加为 base64url；验证先检查格式和时间，再比较
签名。移除 User-Agent 绑定，避免浏览器升级导致无意义退出。旧管理路由和快速响应在 Task 6 完成前
改用显式 `legacy-session.ts`，新 `session.ts` 不再暴露 MD5 API；`src/shared/hash.ts` 随 legacy
调用一同在 Task 13 删除。

- [x] **Step 5: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/unit/session.test.ts tests/unit/subscription-token.test.ts tests/integration/admin.test.ts
npm run typecheck
git diff --check
git add src/auth src/admin/routes.ts src/app/response.ts tests/unit/session.test.ts tests/unit/subscription-token.test.ts tests/integration/admin.test.ts tests/integration/http-fallback.test.ts
git commit -m "feat(auth): 使用 HMAC 保护管理会话"
```

### Task 5: 构造不可变 RuntimeSnapshot

**Files:**

- Modify: `src/app/types.ts`
- Modify: `src/app/request-context.ts`
- Modify: `src/config/runtime.ts`
- Test: `tests/unit/request-context.test.ts`
- Test: `tests/unit/runtime-config.test.ts`

**Interfaces:**

- Produces: `RequestMetadata`
- Produces: `RuntimeSnapshot { config, secrets, identity, requestId }`
- Produces: `createRequestContext(request, env, execution): Promise<RequestContext>`
- Produces: `loadRuntimeSnapshot(context): Promise<RuntimeSnapshot>`

- [x] **Step 1: 写新 Env 和上下文测试**

只接受 `ADMIN`、`UUID`、`CONFIG_KEY`、`TROJAN_PASSWORD`、`SHADOWSOCKS_PASSWORD`；
缺失必需 Secret 时返回可分类配置错误；不再从 `admin/password/KEY/TOKEN` 派生身份；不再读取
`PROXYIP/GO2SOCKS5/PATH/HOST`。

- [x] **Step 2: 写运行时快照测试**

验证配置只读、连接握手后 KV 更新不改变旧快照、新请求读取新 revision、Secret 不出现在序列化配置。

- [x] **Step 3: 运行测试确认失败**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/request-context.test.ts tests/unit/runtime-config.test.ts
```

- [x] **Step 4: 新增精简上下文并接入 Repository**

请求上下文只保留 request/env/execution/url/clientIp/userAgent/requestId；身份和配置通过
`loadRuntimeSnapshot` 注入。为保持中间提交的数据面可运行，旧 `RequestContext` 暂时并行保留；Task
6–10 逐个切换消费者，Task 13 删除默认密钥、MD5 UUID 派生和旧 Env alias。

- [x] **Step 5: 保持 Wrangler 生成绑定类型**

Run: `npm run types`

Expected: `worker-configuration.d.ts` 与 `wrangler.jsonc` bindings 一致。源码中的 legacy global `Env`
声明只服务未迁移消费者，并在 Task 13 删除。

- [x] **Step 6: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/unit/request-context.test.ts tests/unit/runtime-config.test.ts
npm run typecheck
git diff --check
git add src/app/types.ts src/app/request-context.ts src/config/runtime.ts tests/unit/runtime-config.test.ts
git commit -m "refactor(runtime): 使用不可变配置快照"
```

### Task 6: 建立版本化管理 API

**Files:**

- Modify: `src/app/response.ts`
- Modify: `src/admin/routes.ts`
- Create: `src/admin/service.ts`
- Modify: `src/app/router.ts`
- Modify: `src/storage/log-repository.ts`
- Modify: `tests/integration/admin.test.ts`
- Test: `tests/unit/admin-service.test.ts`
- Test: `tests/unit/log-repository.test.ts`

**Interfaces:**

- Produces: `jsonData(data, status?)`
- Produces: `jsonError(code, message, requestId, status)`
- Produces: `/api/admin/v1/session`
- Produces: `/api/admin/v1/config`
- Produces: `/api/admin/v1/profiles/:id/test`
- Produces: `/api/admin/v1/subscriptions/preview`
- Produces: `/api/admin/v1/logs`

- [x] **Step 1: 写 API 合同测试**

覆盖未认证 401、错误登录统一 401、Origin 不匹配 403、登录 Cookie、读取配置不返回 Secret、revision
冲突 409、非法配置 422、凭据空值保持、显式删除、退出清 Cookie。

同时覆盖日志条数上限、单条大小上限、写入失败不影响主请求，以及 password、token、Cookie、UUID 和
完整客户端 IP 的脱敏。

- [x] **Step 2: 运行测试确认旧接口失败**

Run: `npx vitest run --config vitest.config.ts tests/integration/admin.test.ts`

- [x] **Step 3: 实现统一响应和认证中间层**

写接口仅接受 `application/json` 且 `Origin === new URL(request.url).origin`。错误 code 使用
`AUTH_REQUIRED`、`INVALID_CREDENTIALS`、`INVALID_ORIGIN`、`CONFIG_INVALID`、
`CONFIG_REVISION_CONFLICT`、`INTERNAL_ERROR`。

- [x] **Step 4: 实现 Service**

Service 组合 ConfigRepository、SecretStore、profile tester 和 LogRepository。更新 profile 时先校验
配置，再写 Secret，最后保存配置；配置保存失败时删除本次新建的孤立 Secret ref。LogRepository
只接受结构化安全事件，保留配置指定的最近记录，KV 写失败由 `execution.waitUntil()` 隔离。

- [x] **Step 5: 删除旧管理 API 路由**

`/admin/config.json`、`/admin/ADD.txt`、`/admin/tg.json`、`/admin/cf.json`、
`/admin/log.json` 和 `/admin/init` 返回 404，不再访问旧 KV key。

- [x] **Step 6: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/unit/admin-service.test.ts tests/unit/log-repository.test.ts
npx vitest run --config vitest.config.ts tests/integration/admin.test.ts
npm run typecheck
git diff --check
git add src/admin src/app/response.ts src/app/router.ts src/storage/log-repository.ts tests/unit/admin-service.test.ts tests/unit/log-repository.test.ts tests/integration/admin.test.ts
git commit -m "feat(admin): 建立版本化管理接口"
```

### Task 7: 统一出站 Profile 与 Dialer

**Files:**

- Create: `src/networking/connectors/types.ts`
- Create: `src/networking/connectors/registry.ts`
- Create: `src/networking/dialer.ts`
- Modify: `src/networking/tcp-connector.ts`
- Modify: `src/networking/proxy-connectors.ts`
- Modify: `src/networking/proxy-ip.ts`
- Modify: `src/networking/turn.ts`
- Modify: `src/networking/sstp.ts`
- Delete: `src/networking/proxy-runtime.ts`
- Test: `tests/unit/dialer.test.ts`
- Modify: `tests/unit/proxy-connectors.test.ts`

**Interfaces:**

- Produces: `Connector.connect(target, profile, credential, signal): Promise<Socket>`
- Produces: `selectRoute(target, inbound, config): RouteDecision`
- Produces: `createDialer(snapshot, dependencies): Dialer`
- Produces: `Dialer.connect(target, inbound, signal): Promise<DialResult>`

- [ ] **Step 1: 写路由和 registry 测试**

覆盖规则顺序、域名后缀、CIDR、端口、入站协议、block、默认 profile、禁用 profile、未知 profile、
私网/环回/链路本地阻止。

- [ ] **Step 2: 写连接分发测试**

为七种 profile 注入 spy connector，验证只调用选中连接器、Secret ref 正确解析、AbortSignal 传播、
错误不含 credential。

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/dialer.test.ts tests/unit/proxy-connectors.test.ts
```

- [ ] **Step 4: 适配现有连接器**

保留现有 SOCKS5、HTTP、HTTPS、TURN、SSTP 协议实现，通过 adapter 接入统一接口；direct/ProxyIP
继续复用 `sockets.ts` 和候选竞速。不得复制 TLS、TURN 或 SSTP 实现。

- [ ] **Step 5: 删除 URL 动态代理解析**

删除 `/video/<xor>`、`?socks5=`、`?proxyip=`、路径 `ghttp=` 等入口和相关 XOR 解密代码。所有选择
只来自 `RuntimeSnapshot.config.routing`。

- [ ] **Step 6: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/unit/dialer.test.ts tests/unit/proxy-connectors.test.ts tests/unit/proxy-ip.test.ts tests/unit/tcp-connector.test.ts tests/unit/turn.test.ts tests/unit/sstp.test.ts
npm run typecheck
git diff --check
git add src/networking tests/unit
git commit -m "refactor(network): 统一出站配置与拨号"
```

### Task 8: 补齐 XUDP 与 DNS 数据报会话

**Files:**

- Create: `src/networking/xudp.ts`
- Modify: `src/networking/udp-dns.ts`
- Modify: `src/protocols/vless.ts`
- Test: `tests/unit/xudp.test.ts`
- Modify: `tests/unit/udp-dns.test.ts`
- Modify: `tests/unit/vless.test.ts`

**Interfaces:**

- Produces: `XudpDecoder.push(chunk): readonly Datagram[]`
- Produces: `encodeXudpDatagram(datagram): Uint8Array`
- Produces: `createDnsDatagramSession({ mode, doh, limits }): DnsDatagramSession`

- [ ] **Step 1: 写 XUDP 分片测试**

覆盖单帧、多帧、header/payload 任意分片、零长度、超长数据报、非法地址和流结束残帧。

- [ ] **Step 2: 写统一 DNS 会话测试**

同一 DNS query 分别以 PacketAddr 和 XUDP 输入，断言 DoH 收到相同 message 且输出使用对应编码；
非 53 端口、并发超限、超时和超大响应均关闭会话。

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/xudp.test.ts tests/unit/udp-dns.test.ts
```

- [ ] **Step 4: 实现增量 decoder 并接入 VLESS**

decoder 保留未完成帧但总缓冲不超过配置上限。VLESS UDP 根据首个有效帧区分 PacketAddr/XUDP；
Trojan 和 Shadowsocks 的非 TCP 命令明确拒绝。

- [ ] **Step 5: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/unit/xudp.test.ts tests/unit/udp-dns.test.ts tests/unit/vless.test.ts tests/unit/dns.test.ts
npm run typecheck
git diff --check
git add src/networking/xudp.ts src/networking/udp-dns.ts src/protocols/vless.ts tests/unit
git commit -m "feat(dns): 支持 VLESS XUDP 查询"
```

### Task 9: 将三种传输接入统一会话生命周期

**Files:**

- Modify: `src/transports/bridge.ts`
- Modify: `src/transports/websocket.ts`
- Modify: `src/transports/grpc.ts`
- Modify: `src/transports/xhttp.ts`
- Modify: `src/networking/stream-pump.ts`
- Modify: `src/networking/upload-queue.ts`
- Modify: `tests/integration/websocket.test.ts`
- Modify: `tests/integration/grpc.test.ts`
- Modify: `tests/integration/xhttp.test.ts`
- Test: `tests/integration/transport-lifecycle.test.ts`

**Interfaces:**

- Consumes: `RuntimeSnapshot`、`Dialer`、`DnsDatagramSession`
- Produces: `runInboundSession(duplex, snapshot, signal): Promise<void>`
- Produces: WebSocket、gRPC gun、XHTTP stream-one adapters

- [ ] **Step 1: 写生命周期失败测试**

覆盖客户端关闭、目标 EOF、目标 writable half-close、上行异常、下行异常、请求 abort、连接超时、
队列超限和清理幂等；每个场景断言 reader/writer lock 释放且 socket.close 最多一次。

- [ ] **Step 2: 写三传输等价性测试**

同一 VLESS TCP 首包通过 WS/gRPC/XHTTP 输入，断言 dialer 收到相同 target/initialPayload；目标返回
相同字节，三个 adapter 都完整输出。

- [ ] **Step 3: 运行测试确认当前失败**

Run:

```bash
npx vitest run --config vitest.config.ts tests/integration/transport-lifecycle.test.ts
```

- [ ] **Step 4: 抽取统一入站会话**

保留现有协议 parser 和 bridge，抽取 transport-neutral duplex；adapter 只负责帧。所有资源清理由
单个 `ConnectionScope` 管理，`close(reason)` 幂等。

- [ ] **Step 5: 限定 gRPC/XHTTP 模式**

gRPC 只接受 gun framing；XHTTP 只接受 stream-one。无法识别或需要跨请求状态的模式返回 400，
不得写 KV 会话。

- [ ] **Step 6: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/integration/websocket.test.ts tests/integration/grpc.test.ts tests/integration/xhttp.test.ts tests/integration/transport-lifecycle.test.ts
npx vitest run --config vitest.config.ts tests/unit/stream-pump.test.ts tests/unit/upload-queue.test.ts
npm run typecheck
git diff --check
git add src/transports src/networking/stream-pump.ts src/networking/upload-queue.ts tests/integration tests/unit
git commit -m "refactor(transport): 统一隧道连接生命周期"
```

### Task 10: 原生生成全部订阅格式

**Files:**

- Create: `src/subscription/model.ts`
- Modify: `src/subscription/generate.ts`
- Modify: `src/subscription/clash.ts`
- Modify: `src/subscription/singbox.ts`
- Modify: `src/subscription/surge.ts`
- Modify: `src/subscription/routes.ts`
- Delete: `src/subscription/upstream.ts`
- Modify: `tests/integration/subscription.test.ts`
- Test: `tests/unit/subscription-model.test.ts`

**Interfaces:**

- Produces: `SubscriptionNode`
- Produces: `buildSubscriptionNodes(snapshot, requestUrl): readonly SubscriptionNode[]`
- Produces: `serializeMixed`、`serializeBase64`、`serializeClash`、`serializeSingBox`、
  `serializeSurge`

- [ ] **Step 1: 写节点组合测试**

覆盖 VLESS WS/gRPC/XHTTP、Trojan WS/gRPC、Shadowsocks WS；禁用协议不输出；不支持组合跳过并返回
warning；gRPC/XHTTP 节点使用 publicBaseUrl host。

- [ ] **Step 2: 写格式快照测试**

对固定节点断言五种格式可解析、path/serviceName/SNI/SS `mux=0` 正确、VLESS UDP 含选定
packet encoding，且任何输出不含 ADMIN、CONFIG_KEY 或 connector credential。

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/subscription-model.test.ts
npx vitest run --config vitest.config.ts tests/integration/subscription.test.ts
```

- [ ] **Step 4: 改为原生 serializer**

删除远程 subconverter 调用和 `SUBAPI/SUBCONFIG`。格式显式由 `?format=` 或 User-Agent 选择，仅接受
配置启用的枚举值；token 使用 Task 4 HMAC。

- [ ] **Step 5: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/unit/subscription-model.test.ts
npx vitest run --config vitest.config.ts tests/integration/subscription.test.ts
npm run typecheck
git diff --check
git add src/subscription tests/unit/subscription-model.test.ts tests/integration/subscription.test.ts
git commit -m "feat(subscription): 原生生成客户端订阅"
```

### Task 11: 重建精简管理页面

**Files:**

- Replace: `public/admin/index.html`
- Create: `public/admin/app.js`
- Create: `public/admin/styles.css`
- Replace: `public/login/index.html`
- Create: `public/login/app.js`
- Create: `public/shared/styles.css`
- Modify: `src/admin/assets.ts`
- Modify: `tests/integration/assets.test.ts`
- Test: `tests/integration/admin-ui.test.ts`

**Interfaces:**

- Consumes: `/api/admin/v1/*`
- Produces: 登录、系统状态、入站、传输、DNS、profile、路由、订阅预览和日志 UI

- [ ] **Step 1: 写静态资源和安全测试**

断言 HTML 不含远程 `<script>`、inline secret、localStorage token；未认证 `/admin` 重定向；静态资源
使用正确 Content-Type 和 CSP；旧伪 API 文件不可访问。

- [ ] **Step 2: 运行测试确认旧页面失败**

Run:

```bash
npx vitest run --config vitest.config.ts tests/integration/assets.test.ts tests/integration/admin-ui.test.ts
```

- [ ] **Step 3: 实现无框架页面**

登录页 POST JSON session；后台加载 config，按模块编辑，保存携带 revision；password 输入为空不修改，
删除使用明确按钮；profile 测试和订阅预览显示稳定错误 code。

- [ ] **Step 4: 设置 CSP 和缓存策略**

HTML/API `no-store`；带内容 hash 之外的 JS/CSS 使用短缓存；CSP 至少
`default-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'`。

- [ ] **Step 5: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/integration/assets.test.ts tests/integration/admin-ui.test.ts tests/integration/admin.test.ts
npm run typecheck
git diff --check
git add public src/admin/assets.ts tests/integration/assets.test.ts tests/integration/admin-ui.test.ts
git commit -m "feat(admin): 重建独立 Worker 后台"
```

### Task 12: 建立受控连接器集成测试

**Files:**

- Create: `tests/fixtures/tcp-server.ts`
- Create: `tests/integration/connectors/socks5.test.ts`
- Create: `tests/integration/connectors/http-connect.test.ts`
- Create: `tests/integration/connectors/https-connect.test.ts`
- Create: `tests/integration/connectors/turn.test.ts`
- Create: `tests/integration/connectors/sstp.test.ts`
- Modify: `vitest.node.config.ts`

**Interfaces:**

- Produces: 可脚本化 TCP/TLS fixture，支持分片写、延迟、认证拒绝和提前关闭
- Consumes: Task 7 connector adapters

- [ ] **Step 1: 建立仅绑定 loopback 的 fixture**

fixture 返回随机端口和 `close()`；测试结束必须清理；不得监听公网地址或使用真实凭据。

- [ ] **Step 2: 为五类链式代理写成功测试**

逐字节验证握手、认证、CONNECT/relay 目标和首包转发，响应拆为多个任意边界 chunk。

- [ ] **Step 3: 为五类连接器写失败测试**

覆盖认证拒绝、响应超长、协议字段非法、超时和服务端提前关闭；错误消息不得包含用户名或密码。

- [ ] **Step 4: 运行集成测试并修复 adapter 边界**

Run:

```bash
npx vitest run --config vitest.node.config.ts tests/integration/connectors
```

Expected: 全部通过；只允许修改 connector adapter 和确有缺陷的现有协议实现，不重写 TLS/TURN/SSTP。

- [ ] **Step 5: 验证并提交**

```bash
npx vitest run --config vitest.node.config.ts tests/integration/connectors
npx vitest run --config vitest.config.ts tests/unit/proxy-connectors.test.ts tests/unit/turn.test.ts tests/unit/sstp.test.ts
npm run typecheck
git diff --check
git add tests/fixtures tests/integration/connectors vitest.node.config.ts src/networking
git commit -m "test(network): 验证全部链式代理连接器"
```

### Task 13: 删除旧 Worker 与兼容资产

**Files:**

- Delete: `_worker.js`
- Delete: `_worker.d.ts`
- Delete: `src/config/migrate.ts`
- Delete: `tests/characterization/`
- Delete: `tests/integration/legacy-bridge.test.ts`
- Delete: `scripts/create-worker-config.mjs`
- Delete: `scripts/sync-admin-assets.mjs`
- Delete: `public/admin/config.json`
- Delete: `public/admin/ADD.txt`
- Delete: `public/admin/check`
- Delete: `public/admin/getADDAPI`
- Delete: `public/admin/getCloudflareUsage`
- Delete: `public/admin/log.json`
- Delete: `public/noADMIN/`
- Delete: `public/noKV/`
- Modify: `package.json`
- Modify: `.prettierignore`
- Modify: `eslint.config.mjs`
- Modify: `tests/integration/routes.test.ts`

**Interfaces:**

- Produces: 只从 `src/index.ts` 构建的纯 Worker 工程

- [ ] **Step 1: 写遗留扫描测试**

在 `tests/unit/no-legacy.test.ts` 扫描 `src/`、`public/`、`package.json` 和 `wrangler.jsonc`，断言不含
`config.json`、`migrateStoredConfig`、`md5Twice`、`SUBAPI`、`GO2SOCKS5`、旧 env alias 和 URL
credential parser。

- [ ] **Step 2: 运行测试确认当前失败**

Run: `npx vitest run --config vitest.config.ts tests/unit/no-legacy.test.ts`

- [ ] **Step 3: 删除遗留文件和脚本引用**

只删除本任务列出的兼容文件；保留现有 Pages 生产项目和远程资源不动。`package.json` 不再包含旧资产
同步或迁移命令。

- [ ] **Step 4: 更新路由缺失配置响应**

缺 ADMIN/UUID/CONFIG_KEY/KV 时 API 返回结构化 503；公共伪装页不暴露缺失变量名称；删除
`/noADMIN`、`/noKV` 页面。

- [ ] **Step 5: 验证并提交**

```bash
npx vitest run --config vitest.config.ts tests/unit/no-legacy.test.ts
npx vitest run --config vitest.config.ts tests/integration/routes.test.ts tests/integration/assets.test.ts
npm run typecheck
git diff --check
git add _worker.js _worker.d.ts src/config/migrate.ts src/networking/proxy-runtime.ts tests/characterization tests/integration/legacy-bridge.test.ts scripts/create-worker-config.mjs scripts/sync-admin-assets.mjs public/admin/config.json public/admin/ADD.txt public/admin/check public/admin/getADDAPI public/admin/getCloudflareUsage public/admin/log.json public/noADMIN public/noKV package.json .prettierignore eslint.config.mjs tests/integration/routes.test.ts tests/unit/no-legacy.test.ts
git status --short
git commit -m "refactor(worker): 删除旧 Pages 兼容实现"
```

提交前确认 `git diff --cached --name-only` 不包含 `docs/superpowers/`。

### Task 14: 更新 Wrangler、部署文档与安全说明

**Files:**

- Modify: `wrangler.jsonc`
- Modify: `worker-configuration.d.ts`
- Modify: `README.md`
- Modify: `docs/worker-migration-runbook.md`
- Create: `docs/security.md`
- Modify: `docs/e2e/worker-preview-results.md`
- Test: `tests/unit/wrangler-config.test.ts`

**Interfaces:**

- Produces: GitHub -> Workers Builds 可直接部署的 Production/Preview 配置

- [ ] **Step 1: 写 Wrangler 配置测试**

解析 JSONC 后断言 main、Assets、run_worker_first、`compatibility_date = 2026-07-29`、
Production/Preview KV 不同、Preview Worker 名独立、无旧 vars、observability 配置存在。

- [ ] **Step 2: 更新 Wrangler 并生成类型**

Production/Preview 只声明 `KV` 和 `ASSETS` bindings；Secret 通过控制台或 `wrangler secret put` 设置，
不进入 vars。运行 `npm run types`。

- [ ] **Step 3: 重写用户文档**

README 包含能力矩阵、快速部署、五个 Secret、KV、Workers Builds、Custom Domain 要求和本地检查。
runbook 包含 Preview 上传、零流量验证、Production 门禁和 Pages 保留/回滚。security 文档包含 Secret
备份、日志边界、token 撤销、私网目标阻止和漏洞报告。

- [ ] **Step 4: 验证文档和配置**

```bash
npx vitest run --config vitest.config.ts tests/unit/wrangler-config.test.ts
npm run types
npm run typecheck
npx prettier --check README.md docs wrangler.jsonc
git diff --check
```

- [ ] **Step 5: 提交**

```bash
git add wrangler.jsonc worker-configuration.d.ts README.md docs/security.md docs/worker-migration-runbook.md docs/e2e/worker-preview-results.md tests/unit/wrangler-config.test.ts
git commit -m "docs: 完善独立 Worker 部署说明"
```

### Task 15: 全量回归、安全审查与 Preview 上传

**Files:**

- Modify: `docs/e2e/worker-preview-results.md`
- Modify only if a verified defect is found: corresponding `src/**` and `tests/**`

**Interfaces:**

- Produces: 可复现的全量检查和 Preview version 证据

- [ ] **Step 1: 运行完整质量门禁**

Run:

```bash
npm ci
npm run check
git status --short
```

Expected: Node tests、Workers tests、typecheck、lint、format 和 dry-run build 全通过；只有计划允许的
文档结果文件可修改。

- [ ] **Step 2: 扫描敏感信息和遗留入口**

Run:

```bash
rg -n "ADMIN=|CONFIG_KEY=|TROJAN_PASSWORD=|SHADOWSOCKS_PASSWORD=|password[^A-Za-z].*[:=]" src public tests docs --glob '!docs/e2e/**'
rg -n "config\\.json|migrateStoredConfig|md5Twice|SUBAPI|GO2SOCKS5|globalproxy|proxyip=" src public
```

Expected: 第一条只有类型、测试 fixture 和字段标签，无真实值；第二条无结果。

- [ ] **Step 3: 请求代码审查**

使用 `superpowers:requesting-code-review` 对照设计文档逐项审查，修复所有 P0/P1 和确定的 P2，
重新运行 `npm run check`。

- [ ] **Step 4: 上传 Preview version**

Run: `npx wrangler versions upload --env preview`

Expected: 只创建零流量 Preview version，不执行 `wrangler deploy` 或 `versions deploy`，记录 version ID
和版本化 URL。

- [ ] **Step 5: 执行 Preview E2E**

验证登录、配置、订阅、三种 WebSocket 入站、direct/ProxyIP、上传、下载、重连、半关闭、
PacketAddr/XUDP DNS、日志脱敏和 Preview KV 隔离。gRPC/XHTTP 在 workers.dev 的边缘限制如实记录，
不得伪造通过。

- [ ] **Step 6: 更新证据并提交**

```bash
git add docs/e2e/worker-preview-results.md
git commit -m "test: 记录独立 Worker 预览验证"
git status --short
```

Expected: worktree clean；不推送 Production branch、不切换域名。

### Task 16: 推送 Worker 分支并交付

**Files:**

- No source changes

**Interfaces:**

- Produces: `origin/codex/worker-migration` 上可由 Workers Builds 构建的完整分支

- [ ] **Step 1: 最终验证**

```bash
git log --oneline --decorate -20
git status --short
npm run check
```

- [ ] **Step 2: 推送分支**

```bash
git push origin codex/worker-migration
```

- [ ] **Step 3: 核对远端**

```bash
git status -sb
git rev-parse HEAD
git rev-parse origin/codex/worker-migration
```

Expected: 两个 commit ID 相同，worktree clean。

- [ ] **Step 4: 交付说明**

报告提交范围、自动测试、Preview version、已验证能力、Custom Domain 待验项目和 Production 明确未
变更。只有用户另行批准后，才允许部署 Production 或操作正式自定义域。
