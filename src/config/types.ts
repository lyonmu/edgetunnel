export interface StoredConfig extends Record<string, unknown> {
  HOST: string;
  HOSTS: string[];
  UUID: string;
  PATH: string;
  协议类型: string;
  传输协议: string;
  gRPC模式: string;
  gRPCUserAgent: string;
  跳过证书验证: boolean;
  启用0RTT: boolean;
  TLS分片: string | null;
  随机路径: boolean;
  ECH: boolean;
  ECHConfig: { DNS: string; SNI: string };
  SS: { 加密方式: string; TLS: boolean };
  Fingerprint: string;
  优选订阅生成: {
    local: boolean;
    本地IP库: { 随机IP: boolean; 随机数量: number; 指定端口: number };
    SUB: string | null;
    SUBNAME: string;
    SUBUpdateTime: number;
    TOKEN: string;
  };
  订阅转换配置: {
    SUBAPI: string;
    SUBCONFIG: string;
    SUBEMOJI: boolean;
    SUBLIST: boolean;
  };
  反代: {
    PROXYIP: string;
    SOCKS5: {
      启用: string | null;
      全局: boolean;
      账号: string | null;
      白名单: string[];
    };
    路径模板: Record<string, unknown> & {
      PROXYIP: string;
      SOCKS5: { 全局: string; 标准: string };
      HTTP: { 全局: string; 标准: string };
      HTTPS: { 全局: string; 标准: string };
      TURN: { 全局: string; 标准: string };
      SSTP: { 全局: string; 标准: string };
    };
  };
  TG: { 启用: boolean; BotToken: string | null; ChatID: string | null };
  CF: {
    Email: string | null;
    GlobalAPIKey: string | null;
    AccountID: string | null;
    APIToken: string | null;
    UsageAPI: string | null;
    Usage: {
      success: boolean;
      pages: number;
      workers: number;
      total: number;
      max: number;
    };
  };
}

export interface RuntimeConfig extends StoredConfig {
  LINK: string;
  完整节点路径: string;
  加载时间: string;
}
