declare global {
  interface Env {
    ADMIN?: string;
    admin?: string;
    PASSWORD?: string;
    password?: string;
    pswd?: string;
    TOKEN?: string;
    KEY?: string;
    UUID?: string;
    uuid?: string;
    HOST?: string;
    PATH?: string;
    PROXYIP?: string;
    URL?: string;
    GO2SOCKS5?: string;
    DEBUG?: string;
    OFF_LOG?: string;
    BEST_SUB?: string;
    PRELOAD_RACE_DIAL?: string;
    SUBAPI?: string;
    SUBCONFIG?: string;
    CONFIG_KEY?: string;
    TROJAN_PASSWORD?: string;
    SHADOWSOCKS_PASSWORD?: string;
  }
}

export type ProxyType = 'proxyip' | 'socks5' | 'http' | 'https' | 'turn' | 'sstp';

export interface ProxyAddress {
  username?: string;
  password?: string;
  hostname: string;
  port: number;
}

export interface ProxyRuntimeConfig {
  type: ProxyType;
  address?: ProxyAddress;
  proxyIp: string;
  global: boolean;
  fallback: boolean;
  whitelist: readonly string[];
}

export interface RequestContext {
  request: Request;
  env: Env;
  execution: ExecutionContext;
  url: URL;
  userId: string;
  host: string;
  clientIp: string;
  userAgent: string;
  adminPassword: string;
  encryptionKey: string;
  debug: boolean;
  preloadRaceDial: boolean;
  dialConcurrency: number;
  proxy: ProxyRuntimeConfig;
}

export interface RuntimeEnv extends Env {
  ADMIN?: string;
  UUID?: string;
  CONFIG_KEY?: string;
  TROJAN_PASSWORD?: string;
  SHADOWSOCKS_PASSWORD?: string;
}

export interface RequestMetadata {
  request: Request;
  env: RuntimeEnv;
  execution: ExecutionContext;
  url: URL;
  clientIp: string;
  userAgent: string;
  requestId: string;
}

export {};
