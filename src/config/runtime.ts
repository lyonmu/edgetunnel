import type { RequestContext } from '../app/types';
import { migrateStoredConfig } from './migrate';
import type { RuntimeConfig, StoredConfig } from './types';

function splitList(value: string): string[] {
  return value
    .replace(/[\t"'\r\n]+/g, ',')
    .replace(/,+/g, ',')
    .replace(/^,|,$/g, '')
    .split(',')
    .filter(Boolean);
}

function normalizeHost(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      ?.split(':')[0] ?? ''
  );
}

export function applyEnvironmentOverrides(config: StoredConfig, env: Env): StoredConfig {
  const result = migrateStoredConfig(config);
  if (env.HOST) {
    result.HOSTS = splitList(env.HOST).map(normalizeHost);
  }
  if (env.PATH) {
    result.PATH = env.PATH.startsWith('/') ? env.PATH : `/${env.PATH}`;
  }
  return result;
}

export function buildRuntimeConfig(config: StoredConfig, context: RequestContext): RuntimeConfig {
  const started = performance.now();
  const runtime = applyEnvironmentOverrides(config, context.env) as RuntimeConfig;
  runtime.HOST = context.host;
  runtime.UUID = context.userId;
  runtime.gRPCUserAgent = context.userAgent;
  if (runtime.HOSTS.length === 0) {
    runtime.HOSTS = [context.host];
  }
  runtime.反代.PROXYIP = context.proxy.proxyIp;
  runtime.反代.SOCKS5 = {
    启用: context.proxy.type === 'proxyip' ? null : context.proxy.type,
    全局: context.proxy.global,
    账号: context.proxy.address
      ? `${context.proxy.address.hostname}:${context.proxy.address.port}`
      : null,
    白名单: [...context.proxy.whitelist],
  };
  runtime.完整节点路径 = runtime.PATH || '/';
  runtime.LINK = `${runtime.协议类型}://${runtime.UUID}@${runtime.HOST}:443?security=tls&type=${runtime.传输协议}&host=${runtime.HOST}&path=${encodeURIComponent(runtime.完整节点路径)}#${encodeURIComponent(runtime.优选订阅生成.SUBNAME)}`;
  runtime.加载时间 = `${(performance.now() - started).toFixed(2)}ms`;
  return runtime;
}
