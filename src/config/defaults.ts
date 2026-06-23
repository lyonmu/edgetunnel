import type { StoredConfig } from './types';

const PLACEHOLDER = '{{IP:PORT}}';

export function createDefaultConfig(host = '', userId = ''): StoredConfig {
  return {
    TIME: new Date().toISOString(),
    HOST: host,
    HOSTS: host ? [host] : [],
    UUID: userId,
    PATH: '/',
    协议类型: 'vless',
    传输协议: 'ws',
    gRPC模式: 'gun',
    gRPCUserAgent: 'Mozilla/5.0',
    跳过证书验证: false,
    启用0RTT: false,
    TLS分片: null,
    随机路径: false,
    ECH: false,
    ECHConfig: {
      DNS: 'https://dns.alidns.com/dns-query',
      SNI: 'cloudflare-ech.com',
    },
    SS: {
      加密方式: 'aes-128-gcm',
      TLS: true,
    },
    Fingerprint: 'chrome',
    优选订阅生成: {
      local: true,
      本地IP库: {
        随机IP: true,
        随机数量: 16,
        指定端口: -1,
      },
      SUB: null,
      SUBNAME: 'edgetunnel',
      SUBUpdateTime: 3,
      TOKEN: '',
    },
    订阅转换配置: {
      SUBAPI: 'https://SUBAPI.cmliussss.net',
      SUBCONFIG:
        'https://raw.githubusercontent.com/cmliu/ACL4SSR/refs/heads/main/Clash/config/ACL4SSR_Online_Mini_MultiMode_CF.ini',
      SUBEMOJI: false,
      SUBLIST: false,
    },
    反代: {
      PROXYIP: 'auto',
      SOCKS5: {
        启用: null,
        全局: false,
        账号: null,
        白名单: [],
      },
      路径模板: {
        PROXYIP: `proxyip=${PLACEHOLDER}`,
        SOCKS5: { 全局: `socks5://${PLACEHOLDER}`, 标准: `socks5=${PLACEHOLDER}` },
        HTTP: { 全局: `http://${PLACEHOLDER}`, 标准: `http=${PLACEHOLDER}` },
        HTTPS: { 全局: `https://${PLACEHOLDER}`, 标准: `https=${PLACEHOLDER}` },
        TURN: { 全局: `turn://${PLACEHOLDER}`, 标准: `turn=${PLACEHOLDER}` },
        SSTP: { 全局: `sstp://${PLACEHOLDER}`, 标准: `sstp=${PLACEHOLDER}` },
      },
    },
    TG: {
      启用: false,
      BotToken: null,
      ChatID: null,
    },
    CF: {
      Email: null,
      GlobalAPIKey: null,
      AccountID: null,
      APIToken: null,
      UsageAPI: null,
      Usage: {
        success: false,
        pages: 0,
        workers: 0,
        total: 0,
        max: 100000,
      },
    },
  };
}
