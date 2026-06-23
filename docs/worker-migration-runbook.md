# EdgeTunnel Worker 迁移运行手册

本文档用于将 EdgeTunnel 作为纯 Cloudflare Worker 部署，并在正式切换前完成隔离预览、代理协议验证和回滚准备。

现有 Pages 项目仅作为迁移回滚环境保留。Pages 已断开 GitHub 自动部署，不重新连接 Git、不删除项目、不覆盖原部署。

## Workers Builds 配置

在 Cloudflare 控制台创建 Worker `edgetunnel`，连接 GitHub 仓库后设置：

| 配置项                               | 值                                           |
| ------------------------------------ | -------------------------------------------- |
| Production branch                    | `main`                                       |
| Build command                        | `npm run check`                              |
| Deploy command                       | `npx wrangler deploy --env=""`               |
| Non-production branch deploy command | `npx wrangler versions upload --env preview` |
| Root directory                       | `/`                                          |
| Non-production branch builds         | 启用                                         |

非生产命令必须带 `--env preview`。`kv_namespaces.preview_id` 只用于 `wrangler dev`，不会自动隔离 `wrangler versions upload` 的远程 KV。

## Worker 与绑定

### Production

- Worker：`edgetunnel`
- KV binding：`KV`
- KV namespace：现有生产 KV
- Static Assets：`public/`
- Asset binding：`ASSETS`
- Worker-first routing：`assets.run_worker_first=true`

### Preview

- Worker：`edgetunnel-preview`
- KV binding：`KV`
- KV namespace：独立 Preview KV
- Static Assets：与该 Worker 版本一同上传
- 默认变量：`OFF_LOG=true`
- 不绑定正式自定义域
- 只通过版本化 Preview URL 或 `edgetunnel-preview.workers.dev` 验证

Wrangler 的 bindings 和 vars 不会从顶层自动继承到命名环境，因此 `env.preview.kv_namespaces` 和 `env.preview.vars` 必须显式配置。

## Runtime Variables 与 Secrets

只记录名称，禁止把真实值提交到 Git。

建议作为 Secret 配置：

- `ADMIN`
- `KEY`
- `UUID`
- `PROXYIP` 中包含认证信息时
- `GO2SOCKS5` 中包含认证信息时

可按实际需求配置的非敏感变量：

- `HOST`
- `PATH`
- `URL`
- `DEBUG`
- `OFF_LOG`
- `BEST_SUB`
- `PRELOAD_RACE_DIAL`
- `SUBAPI`
- `SUBCONFIG`

Preview 和 Production 的 Secret 独立配置。Preview 不复用生产 `ADMIN`、`KEY` 或代理认证信息。

示例命令只表示名称，执行时通过 Wrangler 交互式输入或安全文件输入：

```bash
npx wrangler secret put ADMIN --env preview
npx wrangler secret put KEY --env preview
npx wrangler secret put UUID --env preview
```

## 预览部署

1. 确认 `npm ci` 和 `npm run check` 成功。
2. 推送非生产分支。
3. 等待 Workers Builds 执行：
   - `npm run check`
   - `npx wrangler versions upload --env preview`
4. 记录 Worker version ID 和版本化 Preview URL。
5. 确认预览版本的 `KV` 指向 Preview KV。
6. 只在 Preview KV 中执行配置保存和日志测试。

## 验证矩阵

| 类别     | 必测项                                                                        |
| -------- | ----------------------------------------------------------------------------- |
| 管理后台 | 登录、退出、配置读取、配置保存、日志读取、日志清理、静态资源                  |
| 管理接口 | `/login`、`/admin`、`/admin/config.json`、`/admin/ADD.txt`、`/admin/log.json` |
| 订阅     | mixed、base64、Clash、Sing-box、Surge                                         |
| 传输层   | WebSocket、XHTTP、gRPC                                                        |
| 入站协议 | VLESS、Trojan、Shadowsocks                                                    |
| 出站模式 | 直连、ProxyIP、SOCKS5、HTTP、HTTPS、TURN、SSTP                                |
| 数据流   | 小包、大文件上传、大文件下载、断线重连、半关闭                                |
| DNS      | UDP DNS、DoH、A、AAAA、TXT                                                    |
| 兼容接口 | `/sub`、`/version`、快速订阅路径、Cookie 和响应头                             |

任一真实代理失败都阻止自定义域切换。禁止通过降低测试要求、改变协议输出或直接改用生产 KV 绕过失败。

## 正式切换

正式切换前必须具备：

- `npm run check` 成功记录
- Preview Worker version ID
- 完整真实代理 E2E 结果
- 生产 KV 备份确认
- 自定义域切换步骤
- 回滚步骤
- 预计影响窗口
- 用户明确批准

切换顺序：

1. 合并到 `main`，由 Workers Builds 执行 `npx wrangler deploy --env=""`。
2. 在 `workers.dev` 对生产绑定做只读验证。
3. 从 Pages 移除正式自定义域绑定。
4. 将同一自定义域添加为 Worker Custom Domain。
5. 执行登录、后台资源、订阅和三种传输协议冒烟测试。
6. 记录 Worker version ID、切换时间和验证结果。

## 回滚

现有 Pages 项目保持不变并停止自动部署。回滚条件包括：

- 登录或管理后台不可用
- 订阅输出不兼容
- 任一主要传输协议不可用
- KV 读取异常
- 大文件上传、下载或重连出现阻断性问题

回滚顺序：

1. 从 Worker 移除正式自定义域。
2. 将正式自定义域重新绑定到原 Pages 项目。
3. 验证 `pages.dev` 和正式自定义域均可访问。
4. 保留故障 Worker version、日志和 E2E 证据。
5. 不删除 Worker、生产 KV 或 Pages 项目。

## Pages 保留策略

- Pages 项目：保留
- Pages GitHub 连接：保持断开
- Pages 自动部署：保持关闭
- Pages `pages.dev` 地址：作为回滚健康检查地址保留
- 正式切换后：仅移除 Pages 的正式自定义域，不停用 Pages 项目
