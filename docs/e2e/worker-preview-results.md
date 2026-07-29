# Worker 部署与 E2E 验证结果

## 当前验证基线

- 日期：2026-07-29
- 分支：`codex/worker-migration`
- 架构：纯 Cloudflare Worker + Static Assets + KV
- Pages：保留，GitHub 自动部署保持断开
- 当前提交：待最终验证后填写
- Preview/Production version：待本轮部署后填写

## 自动化质量门禁

| 检查                  | 结果       | 证据 |
| --------------------- | ---------- | ---- |
| Node 连接器测试       | 待最终运行 |      |
| Workers 单元/集成测试 | 待最终运行 |      |
| TypeScript            | 待最终运行 |      |
| ESLint                | 待最终运行 |      |
| Prettier              | 待最终运行 |      |
| Wrangler dry-run      | 待最终运行 |      |
| 敏感信息/遗留入口扫描 | 待最终运行 |      |

## Cloudflare 资源审计

| 项目                       | 结果   | 证据               |
| -------------------------- | ------ | ------------------ |
| Wrangler 登录账号          | 待审计 |                    |
| Production Worker 部署基线 | 待审计 |                    |
| Production KV binding      | 待审计 |                    |
| 五个 Production Secret     | 待审计 | 只记录名称和存在性 |
| Pages 项目保持存在         | 待审计 |                    |
| Pages GitHub 连接保持断开  | 待审计 |                    |
| 自定义域归属               | 待审计 |                    |

## 管理面与订阅

| 测试项                            | 结果   | 证据 |
| --------------------------------- | ------ | ---- |
| `/version`                        | 待验证 |      |
| `/login`                          | 待验证 |      |
| 管理登录/退出                     | 待验证 |      |
| 配置读取与 revision 保存          | 待验证 |      |
| 加密代理凭据                      | 待验证 |      |
| mixed/base64/Clash/sing-box/Surge | 待验证 |      |
| 日志脱敏与清理                    | 待验证 |      |

## 数据面

| 入站         | 传输         | 出站                     | 结果   | 证据 |
| ------------ | ------------ | ------------------------ | ------ | ---- |
| VLESS        | WebSocket    | Direct                   | 待验证 |      |
| Trojan       | WebSocket    | Direct                   | 待验证 |      |
| Shadowsocks  | WebSocket    | Direct                   | 待验证 |      |
| VLESS/Trojan | gRPC         | Direct                   | 待验证 |      |
| VLESS/Trojan | XHTTP        | Direct                   | 待验证 |      |
| VLESS        | WebSocket    | ProxyIP                  | 待验证 |      |
| 任一入站     | 任一启用传输 | SOCKS5/HTTP(S)/TURN/SSTP | 待验证 |      |

## DNS 与生命周期

| 测试项               | 结果   | 证据 |
| -------------------- | ------ | ---- |
| VLESS PacketAddr DNS | 待验证 |      |
| VLESS XUDP DNS       | 待验证 |      |
| 上传/下载            | 待验证 |      |
| 断线重连             | 待验证 |      |
| 半关闭与取消         | 待验证 |      |

## 历史证据说明

旧 Preview version `569e9fa3-bb42-4aac-82b4-85bf46cb3d92` 属于 Pages 兼容层尚未删除时的实现，不能作为当前纯 Worker 发布证据。本文件只记录本轮最新提交和实际部署结果。

## 发布结论

待本轮 Cloudflare 部署和真实代理验证完成后填写。未实际执行的项目必须标记为“未验证”或“受限”，不得用单元测试替代线上 E2E 结论。
