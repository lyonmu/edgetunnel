# edgetunnel 纯 Cloudflare Worker 迁移设计

## 1. 背景

edgetunnel 当前以 Cloudflare Pages Functions Advanced Mode 部署，核心实现集中在根目录 `_worker.js`。项目同时承担协议解析、TCP 转发、代理链路、订阅生成、管理 API、认证、KV 配置和后台页面代理。

本次改造将项目迁移为纯 Cloudflare Worker，不再保留 Pages 部署兼容性。迁移后仍完整支持现有边缘网络隧道与代理订阅管理能力，同时建立可维护、可测试、可重复部署的 TypeScript 工程。

## 2. 目标

- 使用独立 Cloudflare Worker 部署，不再使用 Pages Functions。
- 使用 Cloudflare Workers Builds 连接 GitHub，自动构建和部署。
- 使用 TypeScript 和严格类型检查重构源码。
- 使用官方 `cloudflare:sockets` API 建立 TCP 连接。
- 将后台静态页面固定版本快照纳入 Worker Static Assets。
- 复用现有 Pages 项目绑定的 KV namespace 及其中的数据。
- 保持现有环境变量、URL、订阅格式、管理 API、Cookie 行为和 KV 配置结构兼容。
- 消除模块级请求状态，避免并发请求和长连接相互覆盖。
- 建立单元测试、特征测试、并发隔离测试和真实 Worker E2E 验证。

## 3. 非目标

- 不保留 Cloudflare Pages 部署方式。
- 不在本次迁移中重做后台界面。
- 不修改现有协议、订阅或管理 API 的外部语义。
- 不在本次迁移中升级登录 Cookie、CSRF 或管理 API 方法。
- 不在本次迁移中改变 KV 日志的对外返回格式。
- 不引入新的代理协议或订阅功能。

## 4. 已确认的关键决策

- 采用渐进迁移，不进行一次性重写。
- 后台页面原样迁入，保持界面和功能不变。
- 后台资源使用固定版本快照，不在构建时实时下载。
- 初始快照来源为 `EDT-Pages/EDT-Pages.github.io` 提交 `630d006e82d72685067b1fa32f84d839d7ae32d2`。
- 使用 Cloudflare Workers Builds 原生 Git 集成，不额外依赖 GitHub Actions 完成部署。
- 全量迁移到 TypeScript。
- 完全兼容当前外部行为。
- 复用现有 KV namespace，不复制或重建配置数据。

## 5. 目标目录结构

```text
edgetunnel/
├── src/
│   ├── index.ts
│   ├── app/
│   │   ├── router.ts
│   │   ├── request-context.ts
│   │   └── response.ts
│   ├── auth/
│   ├── config/
│   ├── admin/
│   ├── subscription/
│   ├── protocols/
│   │   ├── vless/
│   │   ├── trojan/
│   │   └── shadowsocks/
│   ├── transports/
│   │   ├── websocket.ts
│   │   ├── xhttp.ts
│   │   └── grpc.ts
│   ├── networking/
│   │   ├── sockets.ts
│   │   ├── proxy.ts
│   │   ├── dns.ts
│   │   ├── tls.ts
│   │   ├── turn.ts
│   │   └── sstp.ts
│   ├── storage/
│   ├── observability/
│   └── shared/
├── public/
│   ├── admin/index.html
│   ├── login/index.html
│   ├── noADMIN/index.html
│   ├── noKV/index.html
│   └── 其他后台静态资源
├── tests/
├── scripts/
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

`src/index.ts` 只负责 Worker 入口和顶层异常边界。业务职责按目录拆分，模块之间通过显式参数和类型接口通信。

迁移期间保留 `_worker.js` 作为行为基准。全部模块迁移、测试和真实环境验证完成后删除该文件。

## 6. 请求状态模型

每个请求必须创建独立上下文，所有请求级和连接级状态通过参数传递。

```ts
interface RequestContext {
  request: Request;
  env: Env;
  execution: ExecutionContext;
  url: URL;
  userId: string;
  host: string;
  clientIp: string;
  debug: boolean;
  dialConcurrency: number;
  proxy: ProxyRuntimeConfig;
}
```

以下状态不得存放在模块级变量中：

- 当前运行时配置。
- 当前 ProxyIP。
- 当前 SOCKS5、HTTP、HTTPS、TURN 或 SSTP 地址。
- 当前是否启用全局代理。
- 当前是否允许反代失败兜底。
- 当前拨号并发数。
- 当前请求的 `DEBUG` 和 `PRELOAD_RACE_DIAL` 开关。
- 当前请求解析出的链式代理参数。

模块级仅允许保存不可变常量、正则表达式、编码器、解码器，以及不包含请求数据且有明确键和生命周期的缓存。

## 7. 请求路由与数据流

```text
请求进入 src/index.ts
  → 创建 RequestContext
  → 解析环境变量、UUID、Host、路径和代理参数
  → router.ts 判断请求类型
      ├─ WebSocket → transports/websocket
      ├─ gRPC → transports/grpc
      ├─ XHTTP → transports/xhttp
      ├─ /login、/admin API → auth/admin
      ├─ /sub → subscription
      ├─ 后台静态页面 → env.ASSETS.fetch()
      └─ 其他请求 → 原有伪装页面逻辑
```

路由优先级必须保持当前行为，动态管理 API 必须在静态资源之前匹配。例如 `/admin/config.json`、`/admin/check` 和 `/admin/log.json` 不得落入 Static Assets。

## 8. Static Assets

Worker 使用 Static Assets 托管后台页面，代码通过 `env.ASSETS.fetch()` 提供资源。

主要映射：

- `/login` → `public/login/index.html`
- `/admin` → `public/admin/index.html`
- `/noADMIN` → `public/noADMIN/index.html`
- `/noKV` → `public/noKV/index.html`

认证和授权仍由 Worker 执行。只有通过相应检查后，才读取后台静态资源。

后台快照必须记录以下信息：

- 上游仓库地址。
- 上游提交哈希。
- 同步日期。
- 本地变更说明。

生产构建不得依赖访问上游仓库。后台更新必须通过显式同步操作和代码审查完成。

## 9. TCP Socket 与网络层

所有出站 TCP 连接统一使用官方接口：

```ts
import { connect } from "cloudflare:sockets";
```

`networking/sockets.ts` 是项目内部唯一允许直接调用 `connect()` 的模块，负责：

- Socket 参数归一化。
- `allowHalfOpen` 设置。
- 建连超时。
- 并发竞速。
- 失败候选清理。
- Reader、Writer 和 Socket 生命周期。
- 错误归一化和结构化日志。

业务模块不得直接依赖 `cloudflare:sockets`，以便测试和统一控制资源生命周期。

迁移后删除 `request.fetcher.connect()` 依赖，不提供 Pages 兼容回退。

## 10. 代理链路兼容

以下行为必须保持：

- VLESS、Trojan、Shadowsocks 协议格式。
- WebSocket、XHTTP 和 gRPC 路径及握手。
- 首包解析和转发顺序。
- ProxyIP 选择和失败回退。
- SOCKS5、HTTP、HTTPS、TURN、SSTP 链式代理。
- 直连、预加载解析、并发竞速和重连。
- UDP DNS 转发。
- 上传和下载背压。

迁移顺序为：

```text
Socket 适配层
→ WebSocket
→ XHTTP
→ gRPC
→ 底层协议和代理模块
```

每个阶段必须保留可构建、可测试的状态，不允许在缺少行为基线时同时重写多条传输链路。

## 11. 配置处理

配置处理拆分为：

```text
读取 KV 原始配置
→ 迁移旧配置结构
→ 应用环境变量覆盖
→ 构造当前请求运行时配置
```

继续识别现有 KV key：

- `config.json`
- `tg.json`
- `cf.json`
- `ADD.txt`
- `log.json`

运行时派生字段不得写回原始配置，包括：

- `LINK`
- `完整节点路径`
- 脱敏后的凭据
- Cloudflare Usage 数据
- 请求相关 Host、UA 和加载时间

现有环境变量及大小写别名继续兼容，清理废弃别名属于后续独立变更。

## 12. KV 数据复用

纯 Worker 项目绑定现有 KV namespace，binding 名继续使用 `KV`。

迁移前需记录：

- namespace ID。
- 当前 Pages Production 绑定。
- 是否存在 Preview 专用 namespace。
- 配置 key 清单和备份方式。

切换 Worker 后不执行批量数据转换。首次读取时通过兼容迁移函数补齐缺失字段，但不得删除未知字段。

## 13. KV 日志

第一阶段继续支持 `/admin/log.json` 返回现有数组格式，避免后台页面不兼容。

日志访问通过独立 `LogRepository` 完成，并增加：

- 单条日志长度限制。
- 敏感字段脱敏。
- 写入错误隔离。
- 结构和类型校验。

当前单 key 读改写模型的分片改造不与平台迁移同时实施。后续可在保持管理 API 输出不变的前提下，将底层日志改为分片存储。

## 14. 错误处理

内部错误类别：

```ts
type ErrorCategory =
  | "validation"
  | "authentication"
  | "configuration"
  | "protocol"
  | "network"
  | "upstream"
  | "storage"
  | "internal";
```

错误对象包含：

- 稳定错误代码。
- 内部原因。
- 是否可重试。
- 日志等级。
- 对外兼容响应。

现有 HTTP 状态码和响应文本在第一阶段保持不变。详细错误只进入内部日志，不向未经认证的客户端泄露代理凭据、Token 或堆栈。

## 15. 资源生命周期

Socket、Reader、Writer 和定时器遵循统一规则：

```text
创建
→ 使用
→ finally 释放锁
→ 按所有权关闭资源
```

所有 Promise 必须满足以下之一：

- `await`
- `return`
- `execution.waitUntil()`
- 明确使用 `void`，且被调用函数内部处理异常

资源清理失败可在 debug 日志中记录，但不得掩盖原始错误。

## 16. 可观测性

`wrangler.jsonc` 开启 Workers Observability。日志使用结构化对象，例如：

```ts
console.log({
  event: "proxy_connect",
  requestId,
  transport: "websocket",
  protocol: "vless",
  proxyType: "socks5",
  targetPort,
  durationMs,
  result: "success",
});
```

日志不得包含：

- 完整订阅 Token。
- 管理密码。
- 代理密码。
- Telegram Bot Token。
- Cloudflare API Token 或 Global API Key。
- 包含凭据的完整 URL。

`DEBUG` 环境变量继续控制详细诊断信息，但不改变正常错误记录和资源清理。

## 17. 安全边界

为了保持外部兼容，本次不修改 Cookie 算法、登录接口、管理 API 方法和 URL 参数。

本次增加的内部保护：

- 管理请求体大小限制。
- 外部响应大小限制。
- 外部请求统一超时。
- URL、Host 和端口基本校验。
- 日志脱敏。
- TypeScript 严格空值检查。
- Production 和预览版本使用不同 Secrets。

认证升级、CSRF 防护和管理凭据传输方式调整应作为后续独立设计，避免与平台迁移混合。

## 18. TypeScript 和类型边界

- 开启 `strict`。
- 使用 Wrangler 生成的运行时和 binding 类型。
- `Env` 必须包含 `KV` 和 `ASSETS`。
- 协议解析函数使用明确的字节和结果类型。
- 禁止使用全局 `any` 绕过 Request、Socket、KV 或配置类型。
- 对不可信 JSON 使用运行时校验，不能只依赖 TypeScript 类型断言。

TypeScript 迁移按模块进行。迁移模块必须先有特征测试或单元测试，再替换旧实现。

## 19. 测试策略

### 19.1 单元测试

覆盖：

- UUID 和 Token 处理。
- VLESS、Trojan、Shadowsocks 解析。
- SOCKS5、HTTP、HTTPS、TURN、SSTP 地址解析。
- 代理路径参数。
- 配置迁移和默认值。
- Clash、Sing-box、Surge 热补丁。
- TLS、DNS 和字节工具。

### 19.2 特征测试

以现有 `_worker.js` 为行为基准，固定关键输入和输出：

- HTTP 状态码。
- 响应头。
- 订阅文本。
- Clash、Sing-box、Surge 输出。
- 配置派生字段。
- 管理 API JSON。

动态值通过明确规则归一化，不允许用宽泛快照掩盖真实差异。

### 19.3 并发隔离测试

验证：

- 不同请求的 ProxyIP 不串扰。
- SOCKS5 账户不串扰。
- CMCC 拨号数量不影响其他请求。
- `DEBUG` 和 `PRELOAD_RACE_DIAL` 不污染后续请求。
- 长连接保留建立时的配置。

### 19.4 Worker 集成测试

使用 Vitest 和 Cloudflare Workers 测试池验证：

- Worker 路由。
- KV binding。
- Static Assets。
- 登录和 Cookie。
- 管理 API。
- WebSocket Upgrade。
- 订阅生成。

### 19.5 真实环境 E2E

通过 Workers Builds 预览版本验证：

- WebSocket、XHTTP、gRPC。
- VLESS、Trojan、Shadowsocks。
- 直连和所有链式代理。
- 上传、下载和重连。
- KV 配置和后台管理。
- 主流客户端订阅导入。

需要真实代理目标的测试作为发布门禁，不在普通 PR 测试中自动执行。

## 20. 构建与质量检查

建议脚本：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint .",
    "format:check": "prettier --check .",
    "build": "wrangler deploy --dry-run --outdir dist",
    "check": "npm run typecheck && npm run test && npm run lint && npm run format:check && npm run build"
  }
}
```

锁定 Node.js、Wrangler 和测试工具版本。提交依赖锁文件，确保本地与 Workers Builds 使用相同依赖解析结果。

## 21. Worker 配置

`wrangler.jsonc` 作为部署配置事实源，包含：

- Worker `name`。
- `main: "src/index.ts"`。
- 已验证的 `compatibility_date`。
- KV binding `KV`。
- Static Assets binding `ASSETS`。
- `assets.directory: "./public"`。
- Observability。
- Preview URL。
- `workers.dev` 设置。
- 非敏感运行时变量。

敏感值仅在 Cloudflare 控制台的 Variables & Secrets 中设置。

Cloudflare 控制台中的 Worker 名称必须与 `wrangler.jsonc` 的 `name` 完全一致。

## 22. Workers Builds

部署使用 Cloudflare Workers Builds 原生 Git 集成：

```text
生产分支：main
Build command：npm run check
Deploy command：npx wrangler deploy
非生产分支命令：npx wrangler versions upload
```

生产分支推送后，Cloudflare 拉取仓库、安装依赖、执行检查并部署 Worker 与 Static Assets。

非生产分支生成预览版本，用于后台页面、管理 API、订阅和网络链路验证。

## 23. 渐进迁移阶段

1. 建立 TypeScript、测试、Wrangler 和 Static Assets 工程外壳。
2. 导入固定版本后台资源。
3. 建立现有行为特征测试。
4. 建立官方 `cloudflare:sockets` 适配层。
5. 消除模块级请求状态。
6. 迁移配置、认证、管理和订阅模块。
7. 分别迁移 WebSocket、XHTTP 和 gRPC。
8. 迁移协议、TLS、TURN、SSTP 等底层模块。
9. 完成真实 Worker E2E 验证。
10. 切换自定义域，停止 Pages 部署并删除旧 `_worker.js`。

每个阶段必须通过当阶段适用的检查，且不能同时混入无关功能改动。

## 24. 发布与回滚

迁移期间保留现有 Pages 项目。纯 Worker 先通过：

- 本地 `wrangler dev`。
- Workers Builds 非生产分支预览版本。
- `workers.dev` 地址。
- 临时测试域名。

完成真实客户端和代理链路验证后，再将正式自定义域切换到 Worker。

发生问题时：

- 优先回滚 Worker 到上一部署版本。
- 若 Worker 平台迁移本身存在问题，将自定义域恢复到原 Pages 项目。

确认 Worker 稳定运行后，才停用 Pages 自动部署和旧项目。

## 25. 验收标准

- Worker 与 Static Assets 可通过 Workers Builds 从 Git 成功部署。
- 项目不再依赖 Pages `_worker.js` 或 `request.fetcher.connect()`。
- 现有 KV 数据可直接读取和保存。
- 后台页面和管理 API 正常工作。
- 现有环境变量、路径、订阅格式和配置结构兼容。
- WebSocket、XHTTP、gRPC 和三类协议通过真实环境验证。
- 所有代理模式和失败回退行为通过验证。
- 并发请求不存在请求级代理状态串扰。
- TypeScript、测试、lint、格式和 dry-run 构建全部通过。
- 正式域名切换有明确回滚路径。
