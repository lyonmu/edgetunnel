import type { RequestContext } from '../app/types';
import { getTransportConfig } from './transport';

export async function generateMixedSubscription(context: RequestContext): Promise<string> {
  const { url } = context;
  const config = await loadSubscriptionConfig(context);

  const nodes: string[] = [];

  const addresses = await getOptimizedAddresses(context);

  for (const addr of addresses) {
    const node = generateNodeLink(addr, config);
    if (node) {
      nodes.push(node);
    }
  }

  let content = nodes.join('\n');

  if (
    !context.userAgent.includes('mozilla') ||
    url.searchParams.has('b64') ||
    url.searchParams.has('base64')
  ) {
    content = btoa(content);
  }

  return content;
}

interface SubscriptionConfig {
  uuid: string;
  host: string;
  hosts: string[];
  protocol: string;
  transport: string;
  path: string;
  fingerprint: string;
  sni: string;
  ech: boolean;
  echConfig: { DNS: string; SNI: string };
  ss: { 加密方式: string; TLS: boolean };
  randomPath: boolean;
  enable0RTT: boolean;
  tlsFragment: string | null;
}

async function loadSubscriptionConfig(context: RequestContext): Promise<SubscriptionConfig> {
  const { env, url } = context;

  return {
    uuid: env.UUID || '00000000-0000-4000-8000-000000000000',
    host: url.host,
    hosts: [url.hostname],
    protocol: 'vless',
    transport: 'ws',
    path: '/',
    fingerprint: 'chrome',
    sni: url.hostname,
    ech: false,
    echConfig: { DNS: 'https://dns.alidns.com/dns-query', SNI: 'cloudflare-ech.com' },
    ss: { 加密方式: 'aes-128-gcm', TLS: true },
    randomPath: false,
    enable0RTT: false,
    tlsFragment: null,
  };
}

async function getOptimizedAddresses(context: RequestContext): Promise<string[]> {
  const { env } = context;

  const addTxt = await env.KV.get('ADD.txt');
  if (addTxt) {
    return parseAddressList(addTxt);
  }

  return generateRandomIPs();
}

function parseAddressList(content: string): string[] {
  return content
    .replace(/[\t"'\r\n]+/g, ',')
    .replace(/,+/g, ',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function generateRandomIPs(): string[] {
  const cidr = '104.16.0.0/13';
  const ports = [443, 2053, 2083, 2087, 2096, 8443];
  const count = 16;

  const ips: string[] = [];
  for (let i = 0; i < count; i++) {
    const ip = generateRandomIPFromCIDR(cidr);
    const port = ports[Math.floor(Math.random() * ports.length)]!;
    ips.push(`${ip}:${port}#CF优选${i + 1}`);
  }

  return ips;
}

function generateRandomIPFromCIDR(cidr: string): string {
  const [baseIP = '', prefixLength = '0'] = cidr.split('/');
  const prefix = parseInt(prefixLength);
  const hostBits = 32 - prefix;

  const ipInt = baseIP.split('.').reduce((a, p, i) => a | (parseInt(p) << (24 - i * 8)), 0);
  const randomOffset = Math.floor(Math.random() * Math.pow(2, hostBits));
  const mask = (0xffffffff << hostBits) >>> 0;
  const randomIP = (((ipInt & mask) >>> 0) + randomOffset) >>> 0;

  return [
    (randomIP >>> 24) & 0xff,
    (randomIP >>> 16) & 0xff,
    (randomIP >>> 8) & 0xff,
    randomIP & 0xff,
  ].join('.');
}

function generateNodeLink(address: string, config: SubscriptionConfig): string | null {
  const match = address.match(
    /^(\[[\da-fA-F:]+\]|[\d.]+|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::(\d+))?(?:#(.+))?$/,
  );

  if (!match) {
    return null;
  }

  const host = match[1]!;
  const port = match[2] || '443';
  const remark = match[3] || host;

  const transportConfig = getTransportConfig(config);

  if (config.protocol === 'ss') {
    const plugin = `v2ray-plugin;mode=websocket;host=${config.host};path=${config.path}${config.ss.TLS ? ';tls' : ''}`;
    return `ss://${btoa(config.ss.加密方式 + ':' + config.uuid)}@${host}:${port}?plugin=${encodeURIComponent(plugin)}#${encodeURIComponent(remark)}`;
  }

  return `${config.protocol}://${config.uuid}@${host}:${port}?security=tls&type=${transportConfig.type}&${transportConfig.hostField}=${config.host}&fp=${config.fingerprint}&sni=${config.sni}&${transportConfig.pathField}=${encodeURIComponent(config.path)}&encryption=none#${encodeURIComponent(remark)}`;
}
