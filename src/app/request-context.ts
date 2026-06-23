import type { RequestContext } from './types';
import { parseProxyRuntime } from '../networking/proxy-runtime';
import { md5Twice } from '../shared/hash';

const DEFAULT_KEY = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';
const DEFAULT_WHITELIST = [
  '*tapecontent.net',
  '*cloudatacdn.com',
  '*loadshare.org',
  '*cdn-centaurus.com',
  'scholar.google.com',
] as const;
const UUID_V4 =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function splitList(value: string): string[] {
  return value
    .replace(/[\t"'\r\n]+/g, ',')
    .replace(/,+/g, ',')
    .replace(/^,|,$/g, '')
    .split(',')
    .filter(Boolean);
}

function scalarString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

async function deriveUserId(
  env: Env,
  adminPassword: string,
  encryptionKey: string,
): Promise<string> {
  const configured = env.UUID ?? env.uuid;
  if (configured && UUID_V4.test(configured)) {
    return configured.toLowerCase();
  }
  const digest = await md5Twice(`${adminPassword}${encryptionKey}`);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20),
  ].join('-');
}

function identifyCarrier(request: Request): 'ct' | 'cu' | 'cmcc' | 'cf' {
  const cf = request.cf;
  if (scalarString(cf?.country).toLowerCase() !== 'cn') {
    return 'cf';
  }
  const byAsn: Record<string, 'ct' | 'cu' | 'cmcc'> = {
    '4134': 'ct',
    '4809': 'ct',
    '4811': 'ct',
    '4812': 'ct',
    '4815': 'ct',
    '4837': 'cu',
    '4814': 'cu',
    '9929': 'cu',
    '17623': 'cu',
    '17816': 'cu',
    '9808': 'cmcc',
    '24400': 'cmcc',
    '56040': 'cmcc',
    '56041': 'cmcc',
    '56044': 'cmcc',
  };
  const organization = scalarString(cf?.asOrganization).toLowerCase();
  if (/chinanet|chinatelecom|china telecom|cn2|shtel/.test(organization)) {
    return 'ct';
  }
  if (/cmi|cmnet|chinamobile|china mobile|cmcc|mobile communications/.test(organization)) {
    return 'cmcc';
  }
  if (/china169|china unicom|chinaunicom|cucc|cncgroup|cuii|netcom/.test(organization)) {
    return 'cu';
  }
  return byAsn[scalarString(cf?.asn)] ?? 'cf';
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

export async function createRequestContext(
  request: Request,
  env: Env,
  execution: ExecutionContext,
): Promise<RequestContext> {
  const url = new URL(request.url);
  const userAgent = request.headers.get('User-Agent') ?? 'null';
  const adminPassword =
    env.ADMIN ??
    env.admin ??
    env.PASSWORD ??
    env.password ??
    env.pswd ??
    env.TOKEN ??
    env.KEY ??
    env.UUID ??
    env.uuid ??
    '';
  const encryptionKey = env.KEY ?? DEFAULT_KEY;
  const userId = await deriveUserId(env, adminPassword, encryptionKey);
  const hosts = env.HOST ? splitList(env.HOST).map(normalizeHost) : [url.hostname];
  const host = hosts[0] ?? url.hostname;
  const clientIp =
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('True-Client-IP') ??
    request.headers.get('X-Real-IP') ??
    request.headers.get('X-Forwarded-For') ??
    request.headers.get('Fly-Client-IP') ??
    request.headers.get('X-Appengine-Remote-Addr') ??
    request.headers.get('X-Cluster-Client-IP') ??
    '未知IP';
  const proxyIps = env.PROXYIP ? splitList(env.PROXYIP) : [];
  const proxyIp =
    proxyIps.length > 0
      ? (proxyIps[Math.floor(Math.random() * proxyIps.length)] ?? '')
      : `${scalarString(request.cf?.colo) || 'unknown'}.proxyip.cmliuSsSs.nEt`.toLowerCase();
  const whitelist = [
    ...new Set([...DEFAULT_WHITELIST, ...(env.GO2SOCKS5 ? splitList(env.GO2SOCKS5) : [])]),
  ];
  const proxy = parseProxyRuntime(
    url,
    {
      proxyIp,
      fallback: proxyIps.length === 0,
      whitelist,
    },
    userId,
  );

  return {
    request,
    env,
    execution,
    url,
    userId,
    host,
    clientIp,
    userAgent,
    adminPassword,
    encryptionKey,
    debug: ['1', 'true'].includes(env.DEBUG ?? ''),
    preloadRaceDial: ['1', 'true'].includes(env.PRELOAD_RACE_DIAL ?? ''),
    dialConcurrency: identifyCarrier(request) === 'cmcc' ? 1 : 2,
    proxy,
  };
}
