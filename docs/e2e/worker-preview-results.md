# Worker 部署与 E2E 验证结果

## 发布基线

- 日期：2026-07-29
- 分支：`codex/worker-migration`
- 验收源码提交：`7b80035`
- 架构：纯 Cloudflare Worker + Static Assets + KV
- Preview Worker：`edgetunnel-preview`
- Preview version：`c0d554c7-b638-47be-9054-defe329347ee`
- Production Worker：`edgetunnel`
- Production version：`cca3cefa-fd02-4fbe-b2e3-2d6521f3b4fb`
- Production 地址：`https://edgetunnel.muqingcloud.space`
- Pages：项目与 `edgetunnel-cto.pages.dev` 保留，GitHub 自动部署保持断开

## 自动化质量门禁

| 检查                  | 结果 | 证据                                       |
| --------------------- | ---- | ------------------------------------------ |
| Node 连接器测试       | 通过 | 7 个文件、14 个测试                        |
| Workers 单元/集成测试 | 通过 | 41 个文件、222 个测试                      |
| TypeScript            | 通过 | `tsc --noEmit`                             |
| ESLint                | 通过 | `eslint .`                                 |
| Prettier              | 通过 | `prettier --check .`                       |
| Wrangler dry-run      | 通过 | Worker startup 约 5 ms                     |
| 敏感信息/遗留入口扫描 | 通过 | Secret 未进入仓库，旧 Pages 兼容实现已删除 |

最终结果以发布后的 `npm run check` 输出为准。

## Cloudflare 资源审计

| 项目                      | 结果 | 证据                                                                     |
| ------------------------- | ---- | ------------------------------------------------------------------------ |
| Wrangler 登录账号         | 通过 | 账号 `lyonmu@foxmail.com`，Account ID 已核对                             |
| Production Worker         | 通过 | `edgetunnel`，version `cca3cefa-fd02-4fbe-b2e3-2d6521f3b4fb`             |
| Preview Worker            | 通过 | `edgetunnel-preview`，100% 指向本轮 Preview version                      |
| Production KV binding     | 通过 | `KV` → `6e59f9a2320d4e6c98a7d7a195d45c0e`                                |
| Preview KV binding        | 通过 | `KV` → `0e717d6f1053494e82b29c359b1220a2`                                |
| 五个 Production Secret    | 通过 | `ADMIN`、`UUID`、`CONFIG_KEY`、`TROJAN_PASSWORD`、`SHADOWSOCKS_PASSWORD` |
| Pages 项目保持存在        | 通过 | 项目 `edgetunnel` 与原部署记录均保留                                     |
| Pages GitHub 连接保持断开 | 通过 | Cloudflare 项目显示 Git Provider 为 `No`                                 |
| Pages 默认域名            | 通过 | `https://edgetunnel-cto.pages.dev` 返回 HTTP 200                         |
| 生产域名归属              | 通过 | Worker Route `edgetunnel.muqingcloud.space/*` → `edgetunnel`             |

原 Pages 自定义域名解绑时 Cloudflare API 返回了 `8000000`，但复核确认解绑已实际完成。由于原 Pages CNAME 仍是受 Cloudflare 代理的外部 DNS 记录，而当前 Wrangler OAuth 没有 DNS 编辑权限，生产入口采用 Worker Route。所有域名路径均先进入 Worker，Pages 项目及默认域名不受影响。

## 管理面与订阅

| 测试项                            | 结果 | 证据                                                       |
| --------------------------------- | ---- | ---------------------------------------------------------- |
| `/healthz` 与 `/version`          | 通过 | HTTP 200，版本 `2026.07.29`                                |
| `/login` 与 `/admin` 保护         | 通过 | 登录页 200；未登录后台 302                                 |
| 管理登录/退出                     | 通过 | 登录 201、退出 204、旧会话随后返回 401                     |
| 配置读取与 revision 保存          | 通过 | Production revision 从 1 更新至 3                          |
| Direct Profile 在线测试           | 通过 | `www.gstatic.com:443`，约 7 ms                             |
| mixed/base64/Clash/sing-box/Surge | 通过 | 5 种格式均为 200；当前 mixed 节点数为 6                    |
| 审计日志                          | 通过 | 8 条事件，含登录、配置更新、Profile 测试，结果均为 success |

敏感凭据只以 Wrangler Secret 或加密 KV 形式保存；验收记录不包含明文。

## 数据面

| 入站        | 传输      | 客户端 | 出站   | 结果 | 证据                                  |
| ----------- | --------- | ------ | ------ | ---- | ------------------------------------- |
| VLESS       | WebSocket | Mihomo | Direct | 通过 | HTTPS 探测返回 204                    |
| Trojan      | WebSocket | Mihomo | Direct | 通过 | HTTPS 探测返回 204                    |
| Shadowsocks | WebSocket | Mihomo | Direct | 通过 | HTTPS 探测返回 204                    |
| VLESS       | gRPC      | Mihomo | Direct | 通过 | `/edgetunnel/Tun`，HTTPS 探测返回 204 |
| Trojan      | gRPC      | Mihomo | Direct | 通过 | `/edgetunnel/Tun`，HTTPS 探测返回 204 |
| VLESS       | XHTTP     | Xray   | Direct | 通过 | `stream-one` 连续 3 次返回 204        |

Xray 会把 XHTTP path 规范化为带尾斜杠的 `/xhttp/`。本轮增加了与 `/xhttp` 等价的尾斜杠匹配，并使用官方 Xray 26.3.27 验证。

## DNS、流量与生命周期

| 测试项               | 结果       | 证据                                                          |
| -------------------- | ---------- | ------------------------------------------------------------- |
| VLESS XUDP DNS       | 通过       | SOCKS5 UDP → Mihomo → VLESS XUDP → DoH，返回 61 字节 DNS 响应 |
| XHTTP 上行           | 通过       | 256 KiB 请求完整回显，HTTP 200                                |
| WebSocket 大上行     | 通过       | 256 KiB 请求完整回显，HTTP 200                                |
| WebSocket 持续下行   | 通过       | Preview 验收中 30 秒传输 426,311,422 字节后主动停止           |
| 断线重连             | 自动化通过 | 上传队列重连、失败关闭与重试边界均有集成测试                  |
| 半关闭与取消         | 自动化通过 | gRPC 半关闭、连接取消、超时和响应背压均有测试                 |
| VLESS PacketAddr DNS | 未线上验证 | XUDP 已完成真实 UDP 验收；PacketAddr 保留自动化覆盖           |

ProxyIP、SOCKS5、HTTP(S)、TURN、SSTP 等链式出站连接器已通过自动化测试，但生产配置当前只启用 `direct` Profile，因此没有伪造线上通过结论。启用这些出站前仍需录入对应外部服务凭据并单独执行 Profile 在线测试。

## 发布结论

纯 Worker 生产服务已完成部署。管理面、订阅、VLESS/Trojan/Shadowsocks、WebSocket/gRPC/XHTTP、XUDP DNS 和双向流量均有线上验证证据。旧 Pages 项目和默认域名仍可访问，生产流量由 Worker Route 接管。
