export interface SubscriptionConfig {
  SUBAPI: string;
  SUBCONFIG: string;
  SUBEMOJI: boolean;
  SUBLIST: boolean;
}

export interface OptimizeSubscriptionConfig {
  local: boolean;
  本地IP库: {
    随机IP: boolean;
    随机数量: number;
    指定端口: number;
  };
  SUB: string | null;
  SUBNAME: string;
  SUBUpdateTime: number;
  TOKEN: string;
}

export interface SubscriptionContext {
  host: string;
  uuid: string;
  ua: string;
  protocol: string;
  transport: string;
  path: string;
  fingerprint: string;
  sni: string;
  hosts: string[];
  randomPath: boolean;
  enable0RTT: boolean;
  tlsFragment: string | null;
  ech: boolean;
  echConfig: {
    DNS: string;
    SNI: string;
  };
  ss: {
    加密方式: string;
    TLS: boolean;
  };
  subscriptionConfig: SubscriptionConfig;
  optimizeSubscription: OptimizeSubscriptionConfig;
}

export type SubscriptionType =
  | 'mixed'
  | 'base64'
  | 'clash'
  | 'singbox'
  | 'surge'
  | 'quanx'
  | 'loon';
