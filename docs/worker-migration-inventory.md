# Worker 迁移生产依赖清单

## Cloudflare 资源

- Account ID: `95388ccf0c57f60d4a3d2d1088119992`
- Pages project: `edgetunnel`
- Worker project: `edgetunnel`
- Production KV binding: `KV`
- Production KV namespace ID: 6e59f9a2320d4e6c98a7d7a195d45c0e
- Preview KV namespace ID: 0e717d6f1053494e82b29c359b1220a2
- Pages domains: `edgetunnel-cto.pages.dev`, `edgetunnel.muqingcloud.space`
- Production variables and secrets: `ADMIN`, `KEY`, `UUID`, `PROXYIP`, `URL`, `GO2SOCKS5`, `DEBUG`, `OFF_LOG`, `BEST_SUB`, `PRELOAD_RACE_DIAL`, `HOST`, `PATH`

## KV key 备份

- `config.json`：已备份。
- `tg.json`：已备份。
- `cf.json`：已备份。
- `ADD.txt`：生产 KV 中不存在。
- `log.json`：已备份。

## 切换前检查

- Pages 项目保持运行。
- Worker 使用 `workers.dev` 验证。
- 临时测试域验证通过。
- 自定义域回退步骤已演练。
