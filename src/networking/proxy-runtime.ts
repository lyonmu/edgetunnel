import type { ProxyAddress, ProxyRuntimeConfig, ProxyType } from '../app/types';

const DEFAULT_PORTS: Record<Exclude<ProxyType, 'proxyip'>, number> = {
  socks5: 1080,
  http: 80,
  https: 443,
  turn: 3478,
  sstp: 443,
};

const BASE64_AUTH = /^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i;
const BRACKETED_IPV6 = /^\[.*\]$/;

export interface ProxyRuntimeDefaults {
  proxyIp: string;
  fallback: boolean;
  whitelist: readonly string[];
}

export function getDefaultProxyPort(type: ProxyType): number {
  return type === 'proxyip' ? 80 : DEFAULT_PORTS[type];
}

export function parseProxyAddress(address: string, defaultPort = 80): ProxyAddress {
  let normalized =
    String(address || '')
      .trim()
      .replace(/^(socks5|http|https|turn|sstp):\/\//i, '')
      .split('#')[0]
      ?.trim() ?? '';
  const firstAt = normalized.lastIndexOf('@');
  if (firstAt !== -1) {
    let auth = normalized.slice(0, firstAt).replaceAll('%3D', '=');
    if (!auth.includes(':') && BASE64_AUTH.test(auth)) {
      auth = atob(auth);
    }
    normalized = `${auth}@${normalized.slice(firstAt + 1)}`;
  }

  const atIndex = normalized.lastIndexOf('@');
  const hostPart =
    (atIndex === -1 ? normalized : normalized.slice(atIndex + 1)).split('/')[0] ?? '';
  const authPart = atIndex === -1 ? '' : normalized.slice(0, atIndex);
  const [username, password] = authPart ? authPart.split(':') : [];
  if (authPart && !password) {
    throw new Error('无效的 SOCKS 地址格式：认证部分必须是 "username:password" 的形式');
  }

  let hostname = hostPart;
  let port = defaultPort;
  if (hostPart.includes(']:')) {
    const [ipv6Host = '', ipv6Port = ''] = hostPart.split(']:');
    hostname = `${ipv6Host}]`;
    port = Number(ipv6Port.replace(/[^\d]/g, ''));
  } else if (!hostPart.startsWith('[')) {
    const parts = hostPart.split(':');
    if (parts.length === 2) {
      hostname = parts[0] ?? '';
      port = Number((parts[1] ?? '').replace(/[^\d]/g, ''));
    }
  }

  if (Number.isNaN(port)) {
    throw new Error('无效的 SOCKS 地址格式：端口号必须是数字');
  }
  if (hostname.includes(':') && !BRACKETED_IPV6.test(hostname)) {
    throw new Error('无效的 SOCKS 地址格式：IPv6 地址必须用方括号括起来，如 [2001:db8::1]');
  }

  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    hostname,
    port,
  };
}

function decodeSecretBase64(encoded: string, secret: string): string {
  const binary = atob(encoded);
  const mixed = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const key = new TextEncoder().encode(secret);
  const data = new Uint8Array(mixed.length);
  for (let index = 0; index < mixed.length; index += 1) {
    data[index] = (mixed[index] ?? 0) ^ (key[index % key.length] ?? 0);
  }
  return new TextDecoder().decode(data);
}

function parseProxyUrl(
  value: string,
): { type: Exclude<ProxyType, 'proxyip'>; address: string } | null {
  const match = /^(socks5|http|https|turn|sstp):\/\/(.+)$/i.exec(value);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    type: match[1].toLowerCase() as Exclude<ProxyType, 'proxyip'>,
    address: match[2].split('/')[0] ?? '',
  };
}

function pathValue(value: string): string {
  if (!value.includes('://')) {
    const slashIndex = value.indexOf('/');
    return slashIndex > 0 ? value.slice(0, slashIndex) : value;
  }
  const protocolParts = value.split('://');
  if (protocolParts.length !== 2) {
    return value;
  }
  const remainder = protocolParts[1] ?? '';
  const slashIndex = remainder.indexOf('/');
  return slashIndex > 0 ? `${protocolParts[0]}://${remainder.slice(0, slashIndex)}` : value;
}

export function parseProxyRuntime(
  url: URL,
  defaults: ProxyRuntimeDefaults,
  userId: string,
): ProxyRuntimeConfig {
  const whitelist = [...defaults.whitelist];
  const base: ProxyRuntimeConfig = {
    type: 'proxyip',
    proxyIp: defaults.proxyIp,
    global: false,
    fallback: defaults.fallback,
    whitelist,
  };
  const pathname = decodeURIComponent(url.pathname);
  const pathLower = pathname.toLowerCase();
  const chainedMatch = /\/video\/(.+)$/i.exec(pathname);
  if (chainedMatch?.[1]) {
    try {
      const parsed = JSON.parse(decodeSecretBase64(chainedMatch[1], userId)) as Record<
        string,
        unknown
      >;
      const type =
        typeof parsed.type === 'string' ? (parsed.type.toLowerCase() as ProxyType) : 'proxyip';
      if (type === 'proxyip' || !(type in DEFAULT_PORTS)) {
        throw new Error('链式代理类型无效');
      }
      if (typeof parsed.hostname !== 'string' || !parsed.hostname || !parsed.port) {
        throw new Error('链式代理地址缺少 hostname 或 port');
      }
      const address: ProxyAddress = {
        ...(typeof parsed.username === 'string' ? { username: parsed.username } : {}),
        ...(typeof parsed.password === 'string' ? { password: parsed.password } : {}),
        hostname: parsed.hostname,
        port: Number(parsed.port),
      };
      if (Number.isNaN(address.port)) {
        throw new Error('链式代理端口无效');
      }
      return {
        type,
        address,
        proxyIp: '链式代理',
        global: true,
        fallback: false,
        whitelist,
      };
    } catch (error) {
      console.error({
        event: 'chained_proxy_parse_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let type: Exclude<ProxyType, 'proxyip'> | null = null;
  let account =
    url.searchParams.get('socks5') ??
    url.searchParams.get('http') ??
    url.searchParams.get('https') ??
    url.searchParams.get('turn') ??
    url.searchParams.get('sstp');
  let global = url.searchParams.has('globalproxy');

  for (const candidate of ['socks5', 'http', 'https', 'turn', 'sstp'] as const) {
    if (url.searchParams.get(candidate)) {
      type = candidate;
      break;
    }
  }

  const queryProxyIp = url.searchParams.get('proxyip');
  if (queryProxyIp !== null) {
    const parsedUrl = parseProxyUrl(queryProxyIp);
    if (parsedUrl) {
      type = parsedUrl.type;
      account = parsedUrl.address;
      global = true;
    } else {
      return {
        ...base,
        proxyIp: queryProxyIp,
        fallback: false,
      };
    }
  } else {
    let match = /\/(socks5?|http|https|turn|sstp):\/?\/?([^/?#\s]+)/i.exec(pathname);
    if (match?.[1] && match[2]) {
      const matchedType = match[1].toLowerCase();
      type =
        matchedType === 'sock' || matchedType === 'socks'
          ? 'socks5'
          : (matchedType as Exclude<ProxyType, 'proxyip'>);
      account = match[2].split('/')[0] ?? '';
      global = true;
    } else {
      match = /\/(g?s5|socks5|g?http|g?https|g?turn|g?sstp)=([^/?#\s]+)/i.exec(pathname);
      if (match?.[1] && match[2]) {
        const matchedType = match[1].toLowerCase();
        type = matchedType.includes('sstp')
          ? 'sstp'
          : matchedType.includes('turn')
            ? 'turn'
            : matchedType.includes('https')
              ? 'https'
              : matchedType.includes('http')
                ? 'http'
                : 'socks5';
        account = match[2].split('/')[0] ?? '';
        global = matchedType.startsWith('g');
      } else {
        match = /\/(proxyip[.=]|pyip=|ip=)([^?#\s]+)/.exec(pathLower);
        if (match?.[2]) {
          const value = pathValue(match[2]);
          const parsedUrl = parseProxyUrl(value);
          if (parsedUrl) {
            type = parsedUrl.type;
            account = parsedUrl.address;
            global = true;
          } else {
            return {
              ...base,
              proxyIp: value,
              fallback: false,
            };
          }
        }
      }
    }
  }

  if (!type || !account) {
    return base;
  }

  try {
    return {
      ...base,
      type,
      address: parseProxyAddress(account, getDefaultProxyPort(type)),
      global,
    };
  } catch (error) {
    console.error({
      event: 'proxy_address_parse_failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return base;
  }
}
