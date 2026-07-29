# EdgeTunnel 安全说明

## Secret 与密钥

五个运行时 Secret 必须保存在 Cloudflare Worker Secrets 中，不得使用明文 `vars`：

- `ADMIN`：管理密码，同时参与 HMAC 会话和订阅令牌派生；
- `UUID`：VLESS 身份；
- `CONFIG_KEY`：32 字节 base64url，用于 AES-GCM 加密 KV 中的 profile 凭据；
- `TROJAN_PASSWORD`；
- `SHADOWSOCKS_PASSWORD`。

建议使用密码管理器离线备份。尤其是 `CONFIG_KEY`：轮换前必须先解密并重新加密现有凭据，否则旧密文不可恢复。

## 存储边界

- 配置：`edgetunnel:config:v1`，不包含密码；
- 加密凭据：`edgetunnel:secrets:v1`，AES-GCM 随机 nonce，并以 credential ref 作为 AAD；
- 日志：有界、结构化并脱敏；
- 管理 Cookie：`Secure; HttpOnly; SameSite=Strict`，8 小时失效；
- 订阅 token：HMAC-SHA-256，不等于 ADMIN 或 UUID。

Preview 和 Production 必须使用不同 KV 与 Secret。不要复制真实代理账号到 Preview。

## 管理面保护

- 管理写请求必须同源并使用 `application/json`；
- 管理 API 使用 HMAC 会话认证；
- Static Assets 设置 CSP、禁止 iframe、关闭缓存；
- 配置使用 revision 乐观并发控制；
- 配置错误对 API 返回 request ID，公共伪装页不暴露缺失 Secret 名称。

Workers KV 不提供跨 key 事务或原子 compare-and-swap。revision 能检测已可见的陈旧写入，但不能保证两个跨 PoP 同时提交的管理请求被串行化；因此生产环境应保持单一管理者、避免同时保存。凭据变更会合并为一次 KV 写入，并且只在 revision 校验和配置保存后执行。若未来需要多管理员强一致写入，应把管理写路径迁移到 Durable Object 或 D1 事务。

建议在 Cloudflare 中对 `/login` 和 `/api/admin/*` 配置速率限制；如果后台只由固定身份使用，可额外加 Cloudflare Access，但须确认代理数据面路径不受 Access 拦截。

## 数据面限制

默认阻止私网、loopback、link-local 和其他不可公开路由目标，降低 SSRF 风险。域名目标在拨号前通过配置的 DoH 解析并校验 A/AAAA；解析失败或任一结果属于私网时按失败关闭处理。只有显式启用的入站、传输、profile 和路由规则才参与运行。

DNS UDP 转发遵守 `dns.enabled`、`dohUrl`、`timeoutMs` 和 `maxMessageBytes`，并限制单连接数据报数量。关闭 DNS 后，VLESS/Trojan UDP DNS 请求会被拒绝。

代理服务会把客户端流量转发到目标或链式代理。部署者必须确保用途合法、凭据已授权，并避免建立开放代理。

## 日志

不得记录：

- ADMIN、CONFIG_KEY 或协议密码；
- Cookie、Authorization、订阅 token；
- 完整代理认证 URL；
- 付款、个人联系信息或其他直接身份数据。

生产建议保持 `error` 或 `off` 日志等级，并根据需要降低 Workers observability 采样率。

## 撤销与轮换

- 撤销管理会话和全部订阅 token：轮换 `ADMIN`；
- 撤销 VLESS 客户端：轮换 `UUID`；
- 撤销 Trojan/Shadowsocks：轮换对应 Secret；
- 撤销链式代理凭据：在后台替换或删除 credential ref；
- `CONFIG_KEY`：必须执行受控数据迁移，不可直接替换。

轮换后重新部署或创建新 Worker version，并验证旧凭据失效。

## 漏洞报告

请勿在公开 Issue 中提交密钥、可用订阅、代理账号或生产日志。报告应包含受影响版本、复现步骤、预期/实际行为和已脱敏证据。若怀疑 Secret 泄露，应先在 Cloudflare 控制台完成轮换和访问撤销。
