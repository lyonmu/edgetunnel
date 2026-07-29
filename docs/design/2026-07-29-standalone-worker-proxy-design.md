# EdgeTunnel 独立 Cloudflare Worker 代理工具设计

## 1. 文档状态

- 方案：B，独立纯 Worker 代理工具
- 日期：2026-07-29
- 基线分支：`codex/worker-migration`
- 基线提交：`fe3f6c5`
- 状态：待书面确认

本文档是在现有 Worker 迁移成果上继续完善，不重新实现已经验证的协议、传输、连接器和订阅逻辑。
此前 Task 1–14 及后续修复形成当前实现基线；本轮工作的重点是将“兼容旧 Pages 的迁移版本”
收敛为结构清晰、安全、可测试、可独立部署的 Worker 工具。

## 2. 背景与约束

项目原先以 Cloudflare Pages Functions Advanced Mode 运行，根目录 `_worker.js` 同时承担协议解析、
网络转发、订阅、管理后台、认证和 KV 配置。现有 `worker-migration` worktree 已完成 TypeScript
模块化迁移，并建立 Worker Static Assets、请求隔离、自动检查和 Preview E2E 基线。

本轮不再要求：

- 兼容旧 Pages 项目的部署方式；
- 兼容旧 KV key、旧中文字段、旧环境变量别名或旧 Cookie；
- 自动迁移已有生产 KV 数据；
- 使用 `_worker.js` 作为长期行为基准；
- 保留与独立代理工具无关的旧后台功能。

现有 Pages 项目仍保留且已断开 GitHub 自动部署。开发和推送不得修改 Pages 项目、Pages 自定义域或
Pages KV；未来是否切换正式域名由用户单独批准。

## 3. 目标

### 3.1 产品目标

将 EdgeTunnel 建设为可通过 Cloudflare Workers Builds 从 GitHub 直接构建部署的独立代理工具，
提供：

- VLESS、Trojan、Shadowsocks AEAD 入站；
- WebSocket、gRPC、XHTTP `stream-one` 传输；
- TCP 转发和 VLESS UDP DNS；
- VLESS PacketAddr 与 XUDP 数据报支持；
- direct、ProxyIP、SOCKS5、HTTP CONNECT、HTTPS CONNECT、TURN、SSTP 出站；
- 管理登录、配置管理、节点管理、订阅预览、连接测试和安全日志；
- mixed、base64、Clash/Mihomo、Sing-box、Surge 订阅输出；
- Production 与 Preview 显式隔离的 Worker 部署配置。

### 3.2 工程目标

- 复用当前 worktree 中已经实现并通过测试的模块；
- 所有请求和连接状态隔离，不依赖可变模块级状态；
- 所有出站 TCP 连接通过统一 Socket 适配层；
- 使用版本化、强校验的新配置模型；
- 凭据不进入 URL、日志、普通 KV 配置或 Git；
- 管理 API 有稳定版本前缀和一致错误结构；
- 关键协议、连接器和生命周期能够在受控测试端点中完整验证；
- `npm run check` 覆盖类型、单元测试、集成测试、lint、格式和 Worker 构建。

## 4. 非目标

- 不恢复或继续维护 Pages Functions 部署；
- 不迁移旧 `config.json`、`tg.json`、`cf.json`、`ADD.txt`、`log.json`；
- 不兼容 `ADMIN` 已被旧逻辑散列后直接作为登录密码的行为；
- 不提供匿名的 URL 内嵌代理账号、密码或任意出站地址覆盖；
- 不在公共 `workers.dev` 域名上承诺 gRPC 与 XHTTP 的生产可用性；
- 不实现需要跨 HTTP 请求聚合状态的 XHTTP `stream-up`、`packet-up` 或 gRPC multi 模式；
- 不自动部署到 Production、不切换自定义域、不删除原 Pages 项目；
- 不以内置订阅转换器复制完整第三方 subconverter 功能。

## 5. 现有成果复用策略

### 5.1 直接保留并继续加固

以下代码是新版本的实现基线，不进行无意义重写：

| 能力              | 当前模块                                               | 后续处理                                  |
| ----------------- | ------------------------------------------------------ | ----------------------------------------- |
| Worker 入口和路由 | `src/index.ts`、`src/app/router.ts`                    | 调整新 API 与新配置入口                   |
| 请求隔离          | `src/app/request-context.ts`                           | 缩减旧兼容字段，保留每请求快照            |
| 响应工具          | `src/app/response.ts`                                  | 增加统一 JSON 错误模型                    |
| Socket 封装       | `src/networking/sockets.ts`                            | 保留唯一 `connect()` 边界并补生命周期测试 |
| 上传和下行背压    | `upload-queue.ts`、`stream-pump.ts`                    | 补半关闭、取消和异常传播测试              |
| VLESS             | `src/protocols/vless.ts`                               | 保留解析器，增加 XUDP 编解码              |
| Trojan            | `src/protocols/trojan.ts`                              | 保留解析和流式分片测试                    |
| Shadowsocks       | `src/protocols/shadowsocks.ts`                         | 保留 AEAD 实现与插件参数修复              |
| WebSocket         | `src/transports/websocket.ts`                          | 作为生产基准传输                          |
| gRPC              | `src/transports/grpc.ts`                               | 保留 gun 模式，完善帧与半关闭             |
| XHTTP             | `src/transports/xhttp.ts`                              | 保留 `stream-one`，完善错误与取消         |
| DNS               | `dns.ts`、`udp-dns.ts`                                 | 保留 DoH 与 PacketAddr，加入 XUDP         |
| 出站连接器        | `proxy-connectors.ts`、`tcp-connector.ts` 等           | 接入统一 profile 模型                     |
| 订阅生成          | `src/subscription/*`                                   | 保留序列化逻辑，改用新节点模型            |
| Static Assets     | `src/admin/assets.ts`、`public/`                       | 替换旧快照为精简后台                      |
| 测试基础设施      | `tests/unit`、`tests/integration`、`tests/concurrency` | 保留有效测试并删除旧行为特征测试          |

### 5.2 改造而非重写

- `src/config/*`：保留 Repository 分层，但替换旧字段、迁移器和运行时别名。
- `src/admin/routes.ts`：复用路由与 KV 测试方式，升级为版本化 JSON API。
- `src/auth/session.ts`：保留独立认证模块，替换旧弱散列 Cookie。
- `src/networking/proxy-runtime.ts`：保留连接策略，移除来自公共 URL 的凭据覆盖。
- `src/storage/log-repository.ts`：保留存储边界，改为有界、脱敏的结构化事件。
- `wrangler.jsonc`：保留 Worker、Assets、Preview 环境结构，更新绑定和兼容日期。

### 5.3 删除的遗留实现

- 根目录 `_worker.js` 和 `_worker.d.ts`；
- `src/config/migrate.ts` 及旧配置补齐逻辑；
- `src/transports/bridge.ts` 中只为旧 Worker 存在的迁移桥；
- `tests/characterization/` 和 `tests/integration/legacy-bridge.test.ts`；
- 旧 Pages 静态后台快照及其兼容接口；
- `scripts/create-worker-config.mjs` 中面向旧配置的生成逻辑；
- `public/admin/config.json` 等伪静态兼容文件；
- 旧环境变量别名、旧 KV key 和旧 URL 凭据语法；
- 外部后台快照同步脚本中不再使用的兼容逻辑。

删除只发生在新 Worker 分支，不触碰原 Pages 项目的已部署代码。

## 6. 总体架构

```text
Cloudflare Edge Request
  -> Router
     -> Admin / Subscription / Static Assets
     -> Transport Adapter
        -> Protocol Session
           -> Unified Dialer
              -> Direct / ProxyIP / SOCKS5 / HTTP(S) / TURN / SSTP
           -> TCP Stream Pump
           -> UDP Datagram Adapter -> DoH
```

### 6.1 分层原则

1. Transport Adapter 只处理 WebSocket、gRPC 或 XHTTP 的帧和生命周期。
2. Protocol Session 只负责认证、目标解析、首包和数据报语义。
3. Unified Dialer 根据配置快照选择出站 profile，不感知入站传输。
4. Connector 只建立到目标的字节流，不读取 HTTP 请求或 KV。
5. Subscription Serializer 只消费规范化节点模型，不读取运行时请求状态。
6. Admin API 只通过 Service/Repository 修改配置，不直接操作网络模块。

### 6.2 建议目录

```text
src/
├── index.ts
├── app/
├── admin/
│   ├── routes.ts
│   ├── service.ts
│   └── assets.ts
├── auth/
│   ├── password.ts
│   └── session.ts
├── config/
│   ├── schema.ts
│   ├── defaults.ts
│   ├── validate.ts
│   ├── repository.ts
│   └── runtime.ts
├── security/
│   ├── crypto.ts
│   └── secret-store.ts
├── protocols/
├── transports/
├── networking/
│   ├── dialer.ts
│   ├── connectors/
│   └── datagrams/
├── subscription/
├── storage/
├── observability/
└── shared/
```

现有文件只有在职责确实需要拆分时才移动，避免一次性目录重排掩盖行为变化。

## 7. 新配置模型

### 7.1 配置结构

KV 中只保存一个新版本配置文档，key 为 `edgetunnel:config:v1`：

```ts
interface WorkerConfigV1 {
  schemaVersion: 1;
  revision: number;
  inbound: {
    vless: { enabled: boolean };
    trojan: { enabled: boolean };
    shadowsocks: {
      enabled: boolean;
      method: 'aes-128-gcm' | 'aes-256-gcm';
    };
  };
  transports: {
    websocket: { enabled: boolean; path: string };
    grpc: { enabled: boolean; serviceName: string };
    xhttp: { enabled: boolean; path: string; mode: 'stream-one' };
  };
  dns: {
    enabled: boolean;
    dohUrl: string;
    timeoutMs: number;
    maxMessageBytes: number;
  };
  routing: {
    defaultProfileId: string;
    rules: RoutingRule[];
    blockPrivateTargets: boolean;
  };
  egressProfiles: EgressProfile[];
  subscription: {
    enabled: boolean;
    publicBaseUrl?: string;
    formats: SubscriptionFormat[];
  };
  site: {
    camouflageUrl?: string;
  };
  observability: {
    logLevel: 'off' | 'error' | 'info';
    retention: number;
  };
}
```

具体联合类型在实现阶段由 TypeScript 判别联合表达，每种 `EgressProfile` 仅允许该连接器需要的字段。

### 7.2 配置规则

- `schemaVersion` 必须严格为 `1`，不静默接受旧结构；
- `revision` 每次成功写入递增，用于防止后台并发覆盖；
- 路径必须以 `/` 开头，且管理、订阅和传输路径不得冲突；
- ID 使用受限 ASCII slug，不能包含凭据或主机名；
- URL 仅允许 `https:`，但本地测试 fixture 可显式注入测试适配器；
- 端口范围为 1–65535；
- 超时、队列和消息大小均有上下限；
- 未知字段拒绝而不是静默保存；
- 配置读取失败时返回安全错误，不回退到旧 key；
- 新安装缺少配置时生成最小默认配置，但不自动生成或持久化秘密。

### 7.3 请求配置快照

每次 HTTP 请求或隧道握手读取一次配置，完成校验后生成不可变运行时快照。长连接建立后不受后台
配置更新影响；新连接使用新 revision。模块级只允许缓存不含请求状态的已验证配置，并以 KV
revision/短 TTL 为失效条件。

## 8. Secret 与认证设计

### 8.1 Worker Secrets

以下值通过 Wrangler/Cloudflare 控制台设置为 Worker Secrets：

- `ADMIN`：管理员明文口令的输入秘密，不提交、不写 KV；
- `UUID`：VLESS 身份；
- `CONFIG_KEY`：32 字节配置加密主密钥；
- `TROJAN_PASSWORD`：Trojan 身份；
- `SHADOWSOCKS_PASSWORD`：Shadowsocks 身份。

管理员不再把已经散列的旧 `ADMIN` 值当作登录密码。部署者设置一个新的 Preview/Production
口令；两个环境使用不同 Secret。

`worker-configuration.d.ts` 由 `wrangler types` 生成，源码不再手写一份可能漂移的 `Env`。

### 8.2 加密的连接器凭据

后台允许配置 SOCKS5、HTTP(S)、TURN、SSTP 凭据。秘密字段从普通配置剥离，使用
`CONFIG_KEY` 经 Web Crypto AES-256-GCM 加密后写入 `edgetunnel:secrets:v1`。每条记录使用独立
随机 nonce，并将 profile ID、schema version 作为 Additional Authenticated Data。

普通配置只保存 `credentialRef`。API 读取配置时永不返回密码原文，只返回 `configured: true/false`；
空密码表示保持原值，显式删除使用单独操作。

### 8.3 会话

- 登录使用固定耗时的字节比较；
- 会话令牌为带版本、签发时间、过期时间和随机 nonce 的 HMAC-SHA-256 令牌；
- Cookie 设置 `Secure`、`HttpOnly`、`SameSite=Strict`、固定 Path；
- 会话默认 8 小时，不通过 KV 保存服务端会话；
- 修改管理员相关 Secret 后旧会话自然失效；
- 所有管理写接口校验 `Origin`，并要求 JSON Content-Type；
- 登录失败返回相同状态与结构，不泄露 ADMIN 是否配置。

### 8.4 订阅访问

订阅 token 使用 HMAC-SHA-256 派生，不再使用 MD5 或直接暴露协议身份。token 比较使用固定耗时
比较。订阅 URL 不包含出站代理凭据，也不允许通过查询参数覆盖任意连接器。

## 9. 入站协议与传输

### 9.1 协议会话接口

三种入站协议统一产出：

```ts
interface InboundSession {
  protocol: 'vless' | 'trojan' | 'shadowsocks';
  command: 'tcp' | 'udp';
  target: { hostname: string; port: number };
  initialPayload: Uint8Array;
  datagramMode?: 'packetaddr' | 'xudp';
}
```

认证、首包解析和错误响应由协议模块负责；连接、重试和流转发交给后续层。

### 9.2 WebSocket

WebSocket 是 `workers.dev` 和 Custom Domain 都必须通过的生产基准：

- 支持 early data，但限制最大长度；
- 上行使用有界队列并传播背压；
- 下行处理目标半关闭、客户端关闭和异常；
- 任一方向失败时幂等清理 reader、writer、socket 和 WebSocket；
- 同一 isolate 的并发连接不得共享 profile、目标或首包。

### 9.3 gRPC

支持单请求全双工 gun 模式，严格解析与生成 gRPC 5 字节消息头，并设置正确的
`grpc-status`/`grpc-message`。不实现依赖跨请求状态的 multi 模式。

Cloudflare 边缘对 `workers.dev` 的 gRPC 行为不能作为生产保证。正式启用前必须在 Worker
Custom Domain 上完成真实客户端 E2E。

### 9.4 XHTTP

支持单请求 `stream-one` 模式。该模式不需要 Durable Object 或 KV 保存会话状态。请求取消、
响应取消、目标半关闭和超时必须传递到统一连接生命周期。

`stream-up` 和 `packet-up` 需要跨请求的可靠会话协调，若未来确有需求，应单独设计 Durable
Object 会话层，不使用 KV 模拟实时流状态。

## 10. TCP、UDP 与连接生命周期

### 10.1 TCP

`src/networking/sockets.ts` 继续作为唯一允许调用 `cloudflare:sockets.connect()` 的模块。
Unified Dialer 负责：

- 目标与路由规则匹配；
- profile 解析；
- 连接超时；
- direct/ProxyIP 候选竞速；
- 重试次数和可重试错误分类；
- 未胜出候选清理；
- 请求取消传播；
- 半关闭策略；
- 结构化但不含敏感数据的结果。

禁止连接 Cloudflare 平台明确禁止的目标；私网、环回、链路本地和元数据地址默认阻止，只有受控测试
适配器可绕过。

### 10.2 UDP

Worker 不提供任意 UDP Socket。UDP 能力限定为 DNS：

- VLESS UDP 命令仅接受目标端口 53；
- 支持 PacketAddr 和 XUDP 帧；
- 每个数据报经配置的 DoH endpoint 转发；
- 验证 DNS message 长度、事务 ID 和响应大小；
- 设置并发、单次超时和每连接数据报数量上限；
- 非 DNS UDP 返回明确的协议错误并关闭连接。

现有 PacketAddr + DoH 实现直接复用；新增 XUDP 编解码和等价测试。

## 11. 出站模型

### 11.1 Profile 类型

```text
direct
proxyip
socks5
http-connect
https-connect
turn
sstp
```

每个 profile 包含稳定 ID、启用状态、连接超时和该连接器专属配置。路由规则只引用 profile ID。

### 11.2 路由

规则按声明顺序匹配，可基于：

- 精确域名；
- 域名后缀；
- IP/CIDR；
- 目标端口；
- 入站协议。

首个命中规则决定 `use` 或 `block`；未命中使用 `defaultProfileId`。规则不读取公共查询参数。

### 11.3 连接器规范

- SOCKS5：完整覆盖无认证和用户名密码认证，严格读取变长响应；
- HTTP CONNECT：限制响应头大小，仅接受 2xx；
- HTTPS CONNECT：在 Worker TCP Socket 上完成受控 TLS 客户端握手，校验证书和主机名；
- TURN：支持 TCP/TLS 控制连接和 TCP relay，仅实现配置声明的认证方式；
- SSTP：保留当前实现，明确握手、TLS、PPP 封装和清理边界；
- ProxyIP：只作为配置 profile，不从匿名 URL 接收地址或凭据；
- direct：默认实现，允许配置有限候选和竞速，但限制并发数。

每个连接器使用同一 `Connector` 接口，并通过受控内存 server/fixture 验证成功、拒绝、超时、
分片响应和断开场景。真实外部凭据 E2E 是发布前附加验证，不再阻止代码本身完成。

## 12. 管理后台与 API

### 12.1 路径

- `/admin`：后台静态入口；
- `/api/admin/v1/session`：登录、查询、退出；
- `/api/admin/v1/config`：读取和带 revision 更新配置；
- `/api/admin/v1/profiles/:id/test`：连接器连通性测试；
- `/api/admin/v1/subscriptions/preview`：订阅预览；
- `/api/admin/v1/logs`：读取和清理安全事件；
- `/healthz`：无秘密的进程级健康响应。

旧 `/admin/config.json`、`/admin/check`、`/admin/log.json` 等兼容路径删除。

### 12.2 API 响应

成功响应返回 `data`；失败响应返回稳定的：

```json
{
  "error": {
    "code": "CONFIG_REVISION_CONFLICT",
    "message": "配置已被其他会话更新",
    "requestId": "..."
  }
}
```

内部错误、堆栈、KV key 和 Secret 不返回给客户端。

### 12.3 前端

替换现有超大旧后台快照，使用无框架、无远程运行时依赖的 HTML/CSS/TypeScript 或原生 JavaScript
静态资源。后台至少包括：

- 系统状态；
- 入站协议和传输开关；
- 出站 profile 编辑与测试；
- 路由规则；
- DNS；
- 节点和订阅预览；
- 安全日志；
- 保存冲突和字段校验提示。

前端不保存密码，不把 token 写入 localStorage，不加载第三方分析脚本。

## 13. 订阅输出

以统一 `SubscriptionNode` 为输入，分别生成：

- URI mixed 文本；
- base64；
- Clash/Mihomo YAML；
- Sing-box JSON；
- Surge 文本。

生成器必须：

- 使用当前公开 Host 或显式 `publicBaseUrl`；
- 正确编码 path、service name、插件参数和 SNI；
- 只输出已启用且当前格式支持的协议/传输组合；
- 为 Shadowsocks WebSocket 保留已验证的 `mux=0` 和正确加密参数；
- 为 VLESS UDP 明确输出 PacketAddr/XUDP 兼容字段；
- 对 gRPC/XHTTP 标注 Custom Domain 前提；
- 不依赖外部订阅转换服务即可生成核心格式；
- 对不支持的协议/格式组合给出确定性错误或跳过原因。

## 14. 日志与可观测性

日志只记录安全和运维事件，不记录隧道数据内容：

- 登录成功/失败；
- 配置更新 revision；
- profile 测试结果；
- 连接类别、耗时、结果码和匿名 request ID；
- 配置或 Secret 解密失败。

禁止记录：

- ADMIN、UUID、Trojan/SS 密码；
- 连接器用户名、密码和完整 URL；
- subscription token、Cookie、Authorization；
- 代理负载、DNS 原始报文；
- 完整客户端 IP。

KV 日志使用固定上限的结构化记录；写入失败不得中断代理数据面。Cloudflare Observability 可用于平台
异常，但源码日志仍遵循同样脱敏规则。

## 15. Wrangler 与部署

`wrangler.jsonc` 是部署配置事实源：

- Worker main：`src/index.ts`；
- Static Assets directory：`public/`；
- `assets.run_worker_first = true`；
- `compatibility_date = "2026-07-29"`；
- 使用当前 Cloudflare 推荐的兼容设置；
- `KV` 与 `ASSETS` binding 由生成类型覆盖；
- Production 和 Preview 分别声明所有非继承绑定；
- Preview 使用独立 Worker 名、KV 和 Secret；
- Production 不在本轮自动部署。

Workers Builds：

```text
Build command: npm ci && npm run check
Deploy command: npx wrangler deploy
Preview command: npx wrangler versions upload --env preview
```

Git 推送只能更新已连接的 Worker Builds。原 Pages 已断开 GitHub，因此不会因本分支推送更新；
后续仍需在 Cloudflare 控制台确认 Worker 项目连接的 production branch。

正式数据面推荐 Worker Custom Domain。`workers.dev` 用于管理页面、订阅和 WebSocket Preview；
gRPC/XHTTP 的正式验收必须在 Custom Domain 进行。

## 16. 测试策略

### 16.1 自动测试

- 配置：默认值、完整校验、未知字段、冲突路径、revision 冲突；
- 安全：HMAC、固定耗时比较、Cookie、AES-GCM 篡改和错误密钥；
- 协议：正常首包、分片首包、非法认证、地址类型、超长输入；
- UDP：PacketAddr、XUDP、多个数据报、DoH 超时和非法响应；
- 传输：WS/gRPC/XHTTP 帧、early data、取消、半关闭、背压；
- 连接器：使用受控模拟端点覆盖成功、认证失败、超时、分片和提前断开；
- 路由：优先级、profile 选择、私网阻止和请求隔离；
- 订阅：各格式快照、转义、协议组合和敏感字段缺失；
- Admin：认证、CSRF/Origin、配置 CRUD、并发 revision、凭据遮蔽；
- Assets：受保护页面、缓存头和 Worker-first 路由；
- 并发：多连接不同目标、profile、配置 revision 互不污染。

### 16.2 Preview E2E

每次候选版本至少验证：

- 登录、后台、配置保存和订阅；
- VLESS/Trojan/Shadowsocks WebSocket；
- direct 与 ProxyIP；
- 上传、下载、重连和半关闭；
- PacketAddr 与 XUDP DNS；
- Preview KV 与 Production KV 隔离；
- 错误日志不含敏感值。

SOCKS5、HTTP(S)、TURN、SSTP 由受控自动测试保证代码行为；当用户提供授权端点时再补真实边缘 E2E。

### 16.3 Custom Domain E2E

正式发布前验证：

- gRPC gun；
- XHTTP `stream-one`；
- WebSocket 回归；
- 订阅导入后的真实客户端连接。

该步骤需要用户明确授权自定义域操作。

## 17. 完成标准

代码完成必须同时满足：

- 当前已通过的 Preview 能力不回退；
- `npm run check` 全部通过；
- 新配置和 Secret 模型有正常、边界和失败测试；
- PacketAddr 与 XUDP DNS 均有集成测试；
- 所有出站连接器有受控端到端测试；
- WS/gRPC/XHTTP 有取消、背压和半关闭测试；
- 后台可完成配置、profile 测试和订阅预览；
- 源码中不存在旧 KV key、旧环境变量别名和 URL 内嵌凭据入口；
- `_worker.js`、旧迁移桥和旧特征测试删除；
- Static Assets 不包含旧后台伪 API 数据；
- Preview 上传成功且不产生 Production 流量；
- README、部署手册、安全说明和故障排查与实现一致。

发布完成还需要：

- 用户明确批准 Production 部署；
- Worker Custom Domain 上 gRPC/XHTTP/WS E2E 通过；
- 正式 Secret、KV、域名和回滚方案由用户确认；
- 原 Pages 项目继续保留，除非用户另行要求删除。

## 18. 实施顺序

1. 建立新配置 schema、校验、Repository 和 Secret Store；
2. 升级认证、会话、订阅 token 与管理 API；
3. 将现有协议和传输接入新运行时配置；
4. 补齐 XUDP、连接生命周期和半关闭；
5. 将所有现有出站连接器接入统一 profile/dialer；
6. 重建精简管理后台；
7. 将订阅生成器接入新节点模型；
8. 删除旧配置、旧桥接、旧后台和 Pages 兼容代码；
9. 完成全量自动检查、安全审查和 Preview E2E；
10. 更新文档、提交并推送 Worker 分支。

每一步采用小提交并保持测试可运行。先通过测试固定当前已验证行为，再修改对应模块，避免在一次提交中
同时改动协议、传输和连接器。

## 19. 风险与控制

| 风险                           | 控制措施                                          |
| ------------------------------ | ------------------------------------------------- |
| 删除旧兼容导致 Preview 无配置  | 新 Preview KV 初始化 v1 默认配置，Production 不动 |
| Secret 加密密钥丢失            | 文档明确备份责任；无法解密时拒绝使用，不输出密文  |
| gRPC/XHTTP 在 workers.dev 失败 | 不误判为代码通过；在 Custom Domain 做发布验收     |
| TCP 半关闭导致尾包丢失         | 统一生命周期状态机和受控集成测试                  |
| URL 动态代理被滥用             | 删除匿名 URL 凭据和任意地址覆盖                   |
| KV 最终一致性导致覆盖          | revision 乐观并发控制，连接使用握手快照           |
| 后台泄露凭据                   | Secret 分离、响应遮蔽、日志扫描测试               |
| 外部代理端点不可得             | 自动化受控端点作为代码门禁，真实端点作为发布补充  |
| 大范围重构引入回退             | 复用当前模块、按边界渐进改造、小提交和回归测试    |

## 20. Cloudflare 参考

- [Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [TCP Sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
