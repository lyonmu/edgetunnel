# Worker Preview E2E 验证结果

## 验证基线

- 日期：2026-07-29
- 分支：`codex/worker-migration`
- 提交：`bf92f43`
- 最新 Preview version：`569e9fa3-bb42-4aac-82b4-85bf46cb3d92`
- Preview URL：`https://569e9fa3-edgetunnel-preview.lyonmu.workers.dev`
- Preview KV：已确认使用独立 Preview namespace
- 客户端：Mihomo Meta `v1.19.27`，macOS arm64
- 测试目标：Cloudflare trace、Cloudflare speed、`example.com`、`1.1.1.1:53`

本次只上传零流量 Worker version，没有执行 `wrangler deploy`、`wrangler versions deploy`、
自定义域切换、Pages 修改或生产 KV 写入。

## 后台与兼容接口

| 测试项               | 结果 | 证据摘要                                     |
| -------------------- | ---- | -------------------------------------------- |
| `/login`             | 通过 | Preview ADMIN 明文密码登录成功并返回成功标记 |
| `/admin`             | 通过 | 登录 Cookie 下 HTTP 200                      |
| `/admin/config.json` | 通过 | HTTP 200，UUID 与订阅 TOKEN 均非空           |
| `/admin/ADD.txt`     | 通过 | HTTP 200                                     |
| `/admin/log.json`    | 通过 | HTTP 200                                     |
| `/sub`               | 通过 | 使用脱敏 TOKEN 请求 HTTP 200                 |
| `/version`           | 通过 | 使用 Preview UUID 请求 HTTP 200              |
| `/robots.txt`        | 通过 | HTTP 200                                     |

## 真实代理矩阵

| 入站协议         | 传输                     | 出站路径                       | 结果 | 证据摘要                                                                      | 阻止切换 |
| ---------------- | ------------------------ | ------------------------------ | ---- | ----------------------------------------------------------------------------- | -------- |
| VLESS            | WebSocket                | 标准路径（直连优先、自动兜底） | 通过 | 最新 version 下载 64 KiB，HTTP 200                                            | 否       |
| VLESS            | WebSocket                | 显式 ProxyIP                   | 通过 | 连续 3 次下载 64 KiB，均 HTTP 200                                             | 否       |
| VLESS            | XHTTP stream-one         | 标准路径                       | 失败 | `application/grpc` 在 Worker 前返回 403；关闭该伪装头后等待约 15 秒并返回 502 | 是       |
| VLESS            | gRPC                     | 标准路径                       | 失败 | `workers.dev` 对 `application/grpc` 请求在 Worker 前返回 HTTP 403             | 是       |
| Trojan           | WebSocket                | 标准路径                       | 通过 | 最新 version 下载 64 KiB，HTTP 200                                            | 否       |
| Trojan           | gRPC                     | 标准路径                       | 失败 | 与 VLESS gRPC 相同，在 Worker 前返回 HTTP 403                                 | 是       |
| Trojan           | XHTTP                    | 不适用                         | N/A  | Mihomo Trojan 仅支持 WebSocket/gRPC，不支持 XHTTP                             | 否       |
| Shadowsocks AEAD | WebSocket + v2ray-plugin | 标准路径                       | 通过 | `aes-128-gcm` 下载 64 KiB，HTTP 200                                           | 否       |
| Shadowsocks AEAD | XHTTP/gRPC               | 不适用                         | N/A  | Mihomo Shadowsocks v2ray-plugin 不提供这两种传输                              | 否       |

### Shadowsocks 修复证据

首次 E2E 失败时捕获到 v2ray-plugin 默认 Mux 帧，而 Worker 期望直接接收 Shadowsocks
AEAD 流。订阅生成已补齐：

- 路径查询参数 `enc=aes-128-gcm`；
- 插件参数 `mux=0`。

修复后 Preview 真实下载通过，并新增订阅回归测试。

## DNS 与数据流

| 测试项         | 结果   | 证据摘要                                                                      | 阻止切换 |
| -------------- | ------ | ----------------------------------------------------------------------------- | -------- |
| VLESS UDP DNS  | 通过   | Mihomo `packetaddr` 经 WebSocket 查询 `1.1.1.1:53`，`example.com` 返回 A 记录 | 否       |
| DNS 上游       | 通过   | Worker 将原始 DNS message 通过 DoH 转发并返回 PacketAddr 响应                 | 否       |
| 下载           | 通过   | VLESS/WS 下载 1 MiB，HTTP 200                                                 | 否       |
| 上传           | 通过   | VLESS/WS 上传 64 KiB，HTTP 200                                                | 否       |
| 连续请求       | 通过   | 显式 ProxyIP 连续 3 次请求成功                                                | 否       |
| 客户端重启重连 | 通过   | 多次独立启动 Mihomo 后请求成功                                                | 否       |
| 半关闭         | 未完成 | 已有集成测试，真实客户端尚无独立可观测证据                                    | 是       |

Mihomo 默认使用 XUDP。Worker 当前明确支持更简单、可测试的 VLESS PacketAddr，因此订阅链接已增加
`packetEncoding=packetaddr`，避免客户端导入后回落到不兼容的 XUDP。

## 尚未执行的链式代理

以下测试需要可从 Cloudflare 边缘访问的、已授权的测试端点和账号；本次环境未提供，因此没有伪造结果：

| 出站类型       | 结果               | 阻止切换 |
| -------------- | ------------------ | -------- |
| SOCKS5         | 阻塞：缺少授权端点 | 是       |
| HTTP CONNECT   | 阻塞：缺少授权端点 | 是       |
| HTTPS CONNECT  | 阻塞：缺少授权端点 | 是       |
| TURN TCP relay | 阻塞：缺少授权端点 | 是       |
| SSTP           | 阻塞：缺少授权端点 | 是       |

对应连接器已有单元测试，但单元测试不能替代真实代理 E2E。

## 结论

Task 16 尚未通过发布门禁。WebSocket 数据面、VLESS/Trojan/Shadowsocks、ProxyIP、上传下载、
重连和 UDP DNS 已获得真实 Preview 证据；gRPC、XHTTP、半关闭及五类外部链式代理仍未通过或缺少
授权测试条件。

因此：

- 不执行 Task 17，不删除 `_worker.js`；
- 不切换自定义域；
- 不合并生产分支；
- 不修改或停用原 Pages 项目。

下一轮需要先提供链式代理测试端点，并在 Worker Custom Domain 或可接收 gRPC 的非生产域名上重跑
gRPC/XHTTP。Cloudflare 官方也建议生产 Worker 使用 Route 或 Custom Domain，而不是
`workers.dev`。
