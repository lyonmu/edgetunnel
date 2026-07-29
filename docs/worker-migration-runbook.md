# EdgeTunnel Worker 部署与回滚手册

本文用于将 EdgeTunnel 作为纯 Cloudflare Worker 部署、验证并切换自定义域。原 Pages 项目保留且保持 GitHub 自动部署断开；除自定义域切换外，不修改、覆盖或删除 Pages。

## 资源边界

| 环境       | Worker               | KV              | 域名                                        |
| ---------- | -------------------- | --------------- | ------------------------------------------- |
| Production | `edgetunnel`         | Production KV   | `workers.dev`，验收后可绑定正式域名         |
| Preview    | `edgetunnel-preview` | 独立 Preview KV | Preview URL/`workers.dev`，不得绑定正式域名 |
| Rollback   | 原 Pages 项目        | 原 Pages 资源   | 保留 `pages.dev`，需要时重新绑定正式域名    |

`wrangler.jsonc` 的 `env.preview.kv_namespaces` 显式覆盖 Production KV。任何预览写入都必须落在 Preview KV。

## 前置检查

```bash
npm ci
npm run check
npx wrangler whoami
npx wrangler deployments list --env=""
npx wrangler versions list --env=""
```

记录当前 Production version、Production KV ID、Pages `pages.dev` 地址和当前自定义域绑定，作为回滚基线。

## Secret

Production 和 Preview 分别设置以下 Secret：

- `ADMIN`
- `UUID`
- `CONFIG_KEY`
- `TROJAN_PASSWORD`
- `SHADOWSOCKS_PASSWORD`

`wrangler.jsonc` 通过 `secrets.required` 声明名称并在部署前验证是否存在，但不保存值。`CONFIG_KEY` 必须是 32 字节 base64url；丢失后将无法解密已保存在 KV 中的代理凭据。

使用 Cloudflare 控制台添加最安全。若使用 CLI，避免把值放在命令行参数或 shell 历史中：

```bash
npx wrangler secret put ADMIN --env preview
npx wrangler secret put UUID --env preview
npx wrangler secret put CONFIG_KEY --env preview
npx wrangler secret put TROJAN_PASSWORD --env preview
npx wrangler secret put SHADOWSOCKS_PASSWORD --env preview
```

Production 使用相同命令但省略 `--env preview`。Preview 必须使用不同的 `ADMIN`、`CONFIG_KEY` 和协议凭据。

## Cloudflare Workers Builds

Cloudflare 控制台可以直接从 Git 克隆、安装、检查并部署：

| 配置项            | 值                             |
| ----------------- | ------------------------------ |
| Production branch | 正式分支，例如 `main`          |
| Build command     | `npm run check`                |
| Deploy command    | `npx wrangler deploy --env=""` |
| Root directory    | `/`                            |

如果启用非生产分支构建，使用独立的 Preview Worker/KV。不要让分支构建部署到 `edgetunnel` Production Worker。

## Preview 验证

只上传版本、不分配 Production 流量：

```bash
npx wrangler versions upload --env preview
```

验收顺序：

1. `/version` 返回 200；
2. `/login`、登录、退出和 `/admin` 正常；
3. 配置读取/保存、revision 冲突和加密凭据写入正常；
4. mixed、base64、Clash、sing-box、Surge 订阅输出可导入；
5. VLESS/Trojan/Shadowsocks WebSocket 真实连接；
6. VLESS PacketAddr/XUDP DNS；
7. gRPC/XHTTP（若测试域名和客户端支持）；
8. Direct、ProxyIP 以及已配置的链式代理；
9. 上传、下载、重连、半关闭；
10. 日志不包含密码、Cookie、订阅 token 或完整目标地址。

任何核心数据面失败都阻止自定义域切换。不可用能力应禁用并在 E2E 记录中说明，不得伪造通过。

## Production 部署

先确保 Pages 的 GitHub 连接仍为断开状态，并确认 Pages `pages.dev` 可访问。

```bash
npx wrangler deploy --env=""
```

部署后先使用 Production `workers.dev` 地址完成以下只读/低风险检查：

- `/version`、`/login`、`/admin`；
- Production KV binding 正确；
- 默认配置没有覆盖现有 v1 配置；
- 订阅格式和至少一个真实 WebSocket 代理连接正常；
- Worker 日志无持续异常。

## 自定义域切换

Cloudflare 不允许同一个 hostname 同时属于 Pages Custom Domain 和 Worker Custom Domain。

1. 记录 Pages 当前域名绑定和 DNS 状态；
2. 从 Pages 项目移除正式自定义域绑定，保留 Pages 项目和 `pages.dev`；
3. 将同一 hostname 添加到 `edgetunnel` Worker 的 Custom Domains；
4. 等待证书和路由状态生效；
5. 通过正式域名重跑登录、订阅、WebSocket、gRPC/XHTTP（如启用）；
6. 记录切换时间、Worker version ID 和验证结果。

不要删除 Pages 项目、Pages 部署或 Production KV。

## 回滚

触发条件包括管理后台不可用、订阅不可导入、核心代理失败、KV 异常或持续 5xx。

1. 从 Worker 移除正式 Custom Domain；
2. 将该域名重新添加到原 Pages 项目；
3. 验证 Pages `pages.dev` 和正式域名；
4. 保留故障 Worker version、日志和 KV，不执行删除；
5. 更新 E2E 记录并分析原因。

如果问题仅由 Worker 版本引起，也可先回滚到部署前记录的 Worker version，再决定是否切回 Pages。

## Pages 保留策略

- Pages 项目：保留；
- Pages GitHub 连接：保持断开；
- Pages 自动部署：保持关闭；
- Pages `pages.dev`：持续作为回滚健康检查；
- 正式域名切换：只调整域名绑定；
- 禁止为“清理”删除 Pages、KV、Worker 历史版本或证据。
