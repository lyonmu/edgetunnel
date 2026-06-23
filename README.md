# 🚀 edgetunnel 2.1
![后台页面](./img.png)

[![Stars](https://img.shields.io/github/stars/cmliu/edgetunnel?style=flat-square&logo=github)](https://github.com/cmliu/edgetunnel/stargazers)
[![Forks](https://img.shields.io/github/forks/cmliu/edgetunnel?style=flat-square&logo=github)](https://github.com/cmliu/edgetunnel/network/members)
[![License](https://img.shields.io/github/license/cmliu/edgetunnel?style=flat-square)](https://github.com/cmliu/edgetunnel/blob/main/LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-Group-blue?style=flat-square&logo=telegram)](https://t.me/CMLiussss)
[![YouTube](https://img.shields.io/badge/YouTube-Channel-red?style=flat-square&logo=youtube)](https://www.youtube.com/watch?v=LeT4jQUh8ok)
[![zread](https://img.shields.io/badge/Ask_Zread-_.svg?style=flat-square&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff)](https://zread.ai/cmliu/edgetunnel)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/cmliu/edgetunnel)

---

## 📖 项目简介

**edgetunnel** 是一个基于 Cloudflare Workers 的边缘网络隧道与代理订阅管理项目。它能够处理网络流量，并提供内置管理面板和灵活的节点配置能力。

- 🖥️ **Demo 演示站点**：[https://EDT-Pages.github.io/admin](https://EDT-Pages.github.io/admin)

### ✨ 核心特性

- 🛡️ **协议支持**：支持 VLESS、Trojan、Shadowsocks 等主流协议，深度集成加密传输。
- 📊 **管理面板**：内置可视化后台，支持实时配置修改、日志查看及流量统计。
- 🛠️ **纯 Worker 部署**：Worker、管理后台 Static Assets、KV 和代理传输层统一版本部署。
- 🔄 **订阅系统**：内置自动订阅生成及混淆转换，适配主流客户端（Clash, Sing-box, Surge 等）。
- ⚡ **性能加速**：支持自定义 ProxyIP、SOCKS5/HTTP 链式代理及优选 API，优化网络延迟。
- 🌐 **多台适配**：完美适配 Windows, Android, iOS, MacOS 及各种软路由固件。

---

## 💡 快速部署
>[!TIP]
> 📖 **详尽图文教程**：[edgetunnel 部署指南](https://cmliussss.com/p/edt2/)

>[!WARNING]
> ⚠️ **Error 1101问题**：[视频解析](https://www.youtube.com/watch?v=r4uVTEJptdE)

### ⚙️ Workers Builds 部署

<details>
<summary><code><strong>「 Workers 部署文字教程 」</strong></code></summary>

1. 在 GitHub Fork 本项目，或使用你自己的仓库。
2. 在 Cloudflare `Workers & Pages` 中创建 Worker，并选择连接 Git 仓库。
3. 在 Workers Builds 中配置：
   - Production branch：`main`
   - Build command：`npm run check`
   - Deploy command：`npx wrangler deploy --env=""`
   - Non-production branch deploy command：`npx wrangler versions upload --env preview`
   - Root directory：`/`
4. 创建 Production KV 和独立 Preview KV，并将 binding 名称都设置为 `KV`。
5. 在 Worker 的 `Variables & Secrets` 中设置 `ADMIN`、`KEY` 等运行时 Secret，不要把值写入仓库。
6. 推送非生产分支，通过 Worker Preview URL 验证登录、后台、订阅和真实代理。
7. 验证通过后再将正式域名配置为 Worker Custom Domain。

完整的部署门禁、验证矩阵和回滚步骤见 [`docs/worker-migration-runbook.md`](docs/worker-migration-runbook.md)。

</details>

---

## 🔑 环境变量说明

| 变量名 | 必填 | 示例 | 详细备注 |
| :--- | :---: | :--- | :--- |
| **ADMIN** | ✅ | `123456` | 后台管理面板登录密码 |
| **KEY** | ❌ | `CMLiussss` | 快速订阅路径密钥，访问 `/CMLiussss` 即可快速获取节点 |
| **UUID** | ❌ | `90cd4a77-141a-43c9-991b-08263cfe9c10` | 强制固定UUID，只支持**UUIDv4**标准格式 |
| **PROXYIP** | ❌ | `proxyip.cmliussss.net:443` | 全局自定义反代 IP  |
| **URL** | ❌ | `https://cloudflare-error-page-3th.pages.dev` | 默认主页伪装地址（可填写网页 URL 或 `1101`） |
| **GO2SOCKS5** | ❌ | `blog.cmliussss.com`,`*.ip111.cn`,`*google.com` | 强制走 SOCKS5 的名单 (`*` 为全局，域名用逗号分隔) |
| **DEBUG** | ❌ | `1`或`true` | **开发者模式**，默认关闭调试日志功能（console.log），设置`1`或`true`则开启调试日志功能 |
| **OFF_LOG** | ❌ | `1`或`true` | 默认开启日志记录功能，设置`1`或`true`则关闭日志记录功能 |
| **BEST_SUB** | ❌ | `1`或`true` | 默认关闭作为**优选订阅生成器**的功能，设置`1`或`true`则开启该功能 |
| **PRELOAD_RACE_DIAL** | ❌ | `1`或`true` | 默认关闭作为**预加载竞速拨号**的功能，设置`1`或`true`则开启该功能 |

---

## 🔧 高级实用技巧
如需修改 **订阅地址里的TOKEN** 和 **用于节点验证的UUID** ，可通过修改变量
1. 修改`ADMIN`或`KEY`变量的值，可以随机修改 **订阅地址里的TOKEN** 和 **用于节点验证的UUID**
2. 设置`UUID`变量可以强制固定 **订阅地址里的TOKEN** 和 **用于节点验证的UUID**，注意必须是**UUIDv4**标准格式，否则会导致节点无法使用。

本工具支持通过 **PATH路径** 动态切换底层代理方案：

- 指定 `PROXYIP` 案例
   ```url
   /proxyip=proxyip.cmliussss.net
   /?proxyip=proxyip.cmliussss.net
   ```

- 指定 `SOCKS5` 案例
   ```url
   /socks5=user:password@127.0.0.1:1080
   /?socks5=user:password@127.0.0.1:1080
   /socks://dXNlcjpwYXNzd29yZA==@127.0.0.1:1080 (默认激活全局SOCKS5)
   /socks5://user:password@127.0.0.1:1080 (默认激活全局SOCKS5)
   ```

- 指定 `HTTP代理` 案例
   ```url
   /http=user:password@127.0.0.1:1080
   /http://user:password@127.0.0.1:8080 (默认激活全局SOCKS5)
   ```

---

## 💻 客户端适配情况

| 平台 | 推荐客户端 |
| :--- | :--- |
| **Windows** | [v2rayN](https://github.com/2dust/v2rayN/releases)、[Hiddify](https://github.com/hiddify/hiddify-app/releases)、[FlClash](https://github.com/chen08209/FlClash/releases)、[mihomo-party](https://github.com/mihomo-party-org/clash-party/releases)、[Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev/releases)、[Clashmi](https://github.com/KaringX/clashmi/releases)、[FlyClash](https://github.com/GtxFury/FlyClash/releases)、[Karing](https://github.com/KaringX/karing/releases)、[Bettbox](https://github.com/appshubcc/Bettbox/releases) |
| **Android** | [v2rayNG](https://github.com/2dust/v2rayNG/releases)、[ClashMetaForAndroid](https://github.com/MetaCubeX/ClashMetaForAndroid/releases/)、[FlClash](https://github.com/chen08209/FlClash/releases)、[Clashmi](https://github.com/KaringX/clashmi/releases)、[Hiddify](https://github.com/hiddify/hiddify-app/releases)、[NekoBox](https://github.com/MatsuriDayo/NekoBoxForAndroid/releases)、[FlyClash](https://github.com/GtxFury/FlyClash/releases)、[Karing](https://github.com/KaringX/karing/releases)、[Bettbox](https://github.com/appshubcc/Bettbox/releases) |
| **iOS** | Surge、Shadowrocket、Stash、[Hiddify](https://github.com/hiddify/hiddify-app/releases)、Loon、Egern、[Clashmi](https://clashmi.app/download)、[Karing](https://karing.app/)、Quantumult X |
| **macOS** | [FlClash](https://github.com/chen08209/FlClash/releases)、[mihomo-party](https://github.com/mihomo-party-org/clash-party/releases)、[Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev/releases)、Surge、[Clashmi](https://clashmi.app/download)、[Karing](https://karing.app/)、[FlyClash](https://github.com/GtxFury/FlyClash/releases) |
| **鸿蒙** | [ClashBox](https://github.com/xiaobaigroup/ClashBox/releases) |
---

## ⭐ 项目热度

[![Stargazers over time](https://starchart.cc/cmliu/edgetunnel.svg?variant=adaptive)](https://starchart.cc/cmliu/edgetunnel)

---

## 🙏 特别鸣谢
### 💖 赞助支持 - 提供云服务器维持[订阅转换服务](https://sub.cmliussss.net/)
- [Alice](https://url.cmliussss.com/alice)
- [EasyLinks](https://www.vmrack.net?ref_code=5Zk7eNhbgL7)
- [ZMTO(VTEXS)](https://zmto.com/?affid=1532)

### 🛠 开源代码引用
- [zizifn/edgetunnel](https://github.com/zizifn/edgetunnel)
- [3Kmfi6HP/EDtunnel](https://github.com/6Kmfi6HP/EDtunnel)
- [SHIJS1999/cloudflare-worker-vless-ip](https://github.com/SHIJS1999/cloudflare-worker-vless-ip)
- [Stanley-baby](https://github.com/Stanley-baby)
- [ACL4SSR](https://github.com/ACL4SSR/ACL4SSR/tree/master/Clash/config)
- [股神](https://t.me/CF_NAT/38889)
- [Workers/Pages Metrics](https://t.me/zhetengsha/3382)
- [白嫖哥](https://t.me/bestcfipas)
- [Mingyu](https://github.com/ymyuuu/workers-vless)
- [ToiCF/CF-Workers-HTTPS](https://github.com/ToiCF/CF-Workers-HTTPS)
- [ToiCF/CF-Workers-TURN](https://github.com/ToiCF/CF-Workers-TURN)
- [ToiCF/CF-Workers-SoftEther](https://github.com/ToiCF/CF-Workers-SoftEther)
- [eooce](https://github.com/eooce/Cloudflare-proxy)
- [Sukka](https://ip.skk.moe/)
- [zhangtaile](https://github.com/cmliu/edgetunnel/pull/999)
- [1345695](https://github.com/1345695/edcloudwasm)
- [ToiCF/GrainTCP](https://github.com/ToiCF/GrainTCP)

---

## ⚠️ 免责声明

1. 本项目（"edgetunnel"）仅供**教育、科学研究及个人安全测试**之目的。
2. 使用者在下载或使用本项目代码时，必须严格遵守所在地区的法律法规。
3. 作者 **cmliu** 对任何滥用本项目代码导致的行为或后果均不承担任何责任。
4. 本项目不对因使用代码引起的任何直接或间接损害负责。
5. 建议在测试完成后 24 小时内删除本项目相关部署。

---

**如果您觉得项目对您有帮助，请给一个 Star 🌟，这是对我最大的鼓励！**
