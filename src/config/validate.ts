import {
  CONFIG_SCHEMA_VERSION,
  ConfigValidationError,
  type ConfigIssue,
  type EgressProfile,
  type WorkerConfigV1,
} from './schema';

type UnknownRecord = Record<string, unknown>;

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const RESERVED_PATHS = ['/admin', '/api', '/sub', '/healthz'] as const;
const PROFILE_TYPES = [
  'direct',
  'proxyip',
  'socks5',
  'http-connect',
  'https-connect',
  'turn',
  'sstp',
] as const;
const SUBSCRIPTION_FORMATS = ['mixed', 'base64', 'clash', 'singbox', 'surge'] as const;
const INBOUND_PROTOCOLS = ['vless', 'trojan', 'shadowsocks'] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function child(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function issue(issues: ConfigIssue[], path: string, message: string): void {
  issues.push({ path: path || '/', message });
}

function expectRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  issues: ConfigIssue[],
): UnknownRecord | null {
  if (!isRecord(value)) {
    issue(issues, path, '必须是对象');
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      issue(issues, child(path, key), '是不支持的字段');
    }
  }
  return value;
}

function expectBoolean(value: unknown, path: string, issues: ConfigIssue[]): boolean {
  if (typeof value !== 'boolean') {
    issue(issues, path, '必须是布尔值');
    return false;
  }
  return true;
}

function expectString(
  value: unknown,
  path: string,
  issues: ConfigIssue[],
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): value is string {
  if (typeof value !== 'string') {
    issue(issues, path, '必须是字符串');
    return false;
  }
  if (
    value.length < (options.min ?? 0) ||
    value.length > (options.max ?? Number.MAX_SAFE_INTEGER)
  ) {
    issue(issues, path, `长度必须在 ${options.min ?? 0} 到 ${options.max ?? '无限'} 之间`);
    return false;
  }
  if (options.pattern && !options.pattern.test(value)) {
    issue(issues, path, '格式无效');
    return false;
  }
  return true;
}

function expectInteger(
  value: unknown,
  path: string,
  issues: ConfigIssue[],
  min: number,
  max: number,
): value is number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issue(issues, path, `必须是 ${min} 到 ${max} 之间的整数`);
    return false;
  }
  return true;
}

function expectEnum<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
  issues: ConfigIssue[],
): value is T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    issue(issues, path, `必须是 ${values.join('、')} 之一`);
    return false;
  }
  return true;
}

function expectStringArray(
  value: unknown,
  path: string,
  issues: ConfigIssue[],
  options: { minItems?: number; itemPattern?: RegExp } = {},
): value is string[] {
  if (!Array.isArray(value)) {
    issue(issues, path, '必须是数组');
    return false;
  }
  if (value.length < (options.minItems ?? 0)) {
    issue(issues, path, `至少需要 ${options.minItems} 项`);
  }
  value.forEach((item, index) =>
    expectString(item, child(path, index), issues, {
      min: 1,
      max: 512,
      ...(options.itemPattern ? { pattern: options.itemPattern } : {}),
    }),
  );
  return true;
}

function expectHttpsUrl(value: unknown, path: string, issues: ConfigIssue[]): void {
  if (!expectString(value, path, issues, { min: 1, max: 2_048 })) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      issue(issues, path, '必须使用 https');
    }
  } catch {
    issue(issues, path, '必须是有效 URL');
  }
}

function expectPath(value: unknown, path: string, issues: ConfigIssue[]): void {
  if (!expectString(value, path, issues, { min: 1, max: 256 })) return;
  if (!value.startsWith('/') || value.includes('#') || value.includes('?')) {
    issue(issues, path, '必须是以 / 开头且不含查询或片段的路径');
  }
  if (RESERVED_PATHS.some((reserved) => value === reserved || value.startsWith(`${reserved}/`))) {
    issue(issues, path, '与系统保留路径冲突');
  }
}

function validateEnabled(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  issues: ConfigIssue[],
): UnknownRecord | null {
  const record = expectRecord(value, path, allowedKeys, issues);
  if (record) expectBoolean(record.enabled, child(path, 'enabled'), issues);
  return record;
}

function validateInbound(value: unknown, issues: ConfigIssue[]): void {
  const path = '/inbound';
  const inbound = expectRecord(value, path, ['vless', 'trojan', 'shadowsocks'], issues);
  if (!inbound) return;
  validateEnabled(inbound.vless, `${path}/vless`, ['enabled'], issues);
  validateEnabled(inbound.trojan, `${path}/trojan`, ['enabled'], issues);
  const shadowsocks = validateEnabled(
    inbound.shadowsocks,
    `${path}/shadowsocks`,
    ['enabled', 'method'],
    issues,
  );
  if (shadowsocks) {
    expectEnum(
      shadowsocks.method,
      `${path}/shadowsocks/method`,
      ['aes-128-gcm', 'aes-256-gcm'],
      issues,
    );
  }
}

function validateTransports(value: unknown, issues: ConfigIssue[]): void {
  const path = '/transports';
  const transports = expectRecord(value, path, ['websocket', 'grpc', 'xhttp'], issues);
  if (!transports) return;
  const websocket = validateEnabled(
    transports.websocket,
    `${path}/websocket`,
    ['enabled', 'path'],
    issues,
  );
  if (websocket) expectPath(websocket.path, `${path}/websocket/path`, issues);
  const grpc = validateEnabled(transports.grpc, `${path}/grpc`, ['enabled', 'serviceName'], issues);
  if (grpc) {
    expectString(grpc.serviceName, `${path}/grpc/serviceName`, issues, {
      min: 1,
      max: 128,
      pattern: /^[A-Za-z0-9._/-]+$/,
    });
  }
  const xhttp = validateEnabled(
    transports.xhttp,
    `${path}/xhttp`,
    ['enabled', 'path', 'mode'],
    issues,
  );
  if (xhttp) {
    expectPath(xhttp.path, `${path}/xhttp/path`, issues);
    expectEnum(xhttp.mode, `${path}/xhttp/mode`, ['stream-one'], issues);
  }
  if (websocket?.enabled === true && xhttp?.enabled === true && websocket.path === xhttp.path) {
    issue(issues, `${path}/xhttp/path`, '不能与已启用的 WebSocket 路径重复');
  }
}

function validateDns(value: unknown, issues: ConfigIssue[]): void {
  const path = '/dns';
  const dns = expectRecord(
    value,
    path,
    ['enabled', 'dohUrl', 'timeoutMs', 'maxMessageBytes'],
    issues,
  );
  if (!dns) return;
  expectBoolean(dns.enabled, `${path}/enabled`, issues);
  expectHttpsUrl(dns.dohUrl, `${path}/dohUrl`, issues);
  expectInteger(dns.timeoutMs, `${path}/timeoutMs`, issues, 100, 60_000);
  expectInteger(dns.maxMessageBytes, `${path}/maxMessageBytes`, issues, 512, 65_535);
}

function validateProfile(
  value: unknown,
  index: number,
  issues: ConfigIssue[],
): EgressProfile | null {
  const path = `/egressProfiles/${index}`;
  if (!isRecord(value)) {
    issue(issues, path, '必须是对象');
    return null;
  }
  const typeValid = expectEnum(value.type, `${path}/type`, PROFILE_TYPES, issues);
  const type: (typeof PROFILE_TYPES)[number] = typeValid
    ? (value.type as (typeof PROFILE_TYPES)[number])
    : 'direct';
  const addressKeys = ['hostname', 'port', 'credentialRef'];
  const allowedByType: Record<(typeof PROFILE_TYPES)[number], readonly string[]> = {
    direct: ['id', 'type', 'enabled', 'timeoutMs'],
    proxyip: ['id', 'type', 'enabled', 'timeoutMs', 'endpoints'],
    socks5: ['id', 'type', 'enabled', 'timeoutMs', ...addressKeys],
    'http-connect': ['id', 'type', 'enabled', 'timeoutMs', ...addressKeys],
    'https-connect': ['id', 'type', 'enabled', 'timeoutMs', ...addressKeys, 'tlsServerName'],
    turn: ['id', 'type', 'enabled', 'timeoutMs', ...addressKeys, 'transport', 'tlsServerName'],
    sstp: ['id', 'type', 'enabled', 'timeoutMs', ...addressKeys, 'tlsServerName'],
  };
  const profile = expectRecord(value, path, allowedByType[type], issues);
  if (!profile) return null;
  expectString(profile.id, `${path}/id`, issues, { min: 1, max: 64, pattern: ID_PATTERN });
  expectBoolean(profile.enabled, `${path}/enabled`, issues);
  expectInteger(profile.timeoutMs, `${path}/timeoutMs`, issues, 100, 120_000);
  if (type === 'proxyip') {
    expectStringArray(profile.endpoints, `${path}/endpoints`, issues, { minItems: 1 });
  } else if (type !== 'direct') {
    expectString(profile.hostname, `${path}/hostname`, issues, { min: 1, max: 253 });
    expectInteger(profile.port, `${path}/port`, issues, 1, 65_535);
    if (profile.credentialRef !== undefined) {
      expectString(profile.credentialRef, `${path}/credentialRef`, issues, {
        min: 1,
        max: 64,
        pattern: ID_PATTERN,
      });
    }
    if (profile.tlsServerName !== undefined) {
      expectString(profile.tlsServerName, `${path}/tlsServerName`, issues, {
        min: 1,
        max: 253,
      });
    }
    if (type === 'turn') {
      expectEnum(profile.transport, `${path}/transport`, ['tcp', 'tls'], issues);
    }
  }
  return value as unknown as EgressProfile;
}

function validateRouteMatch(value: unknown, path: string, issues: ConfigIssue[]): void {
  const match = expectRecord(
    value,
    path,
    ['domains', 'domainSuffixes', 'cidrs', 'ports', 'inboundProtocols'],
    issues,
  );
  if (!match) return;
  for (const key of ['domains', 'domainSuffixes', 'cidrs'] as const) {
    if (match[key] !== undefined) expectStringArray(match[key], `${path}/${key}`, issues);
  }
  if (match.ports !== undefined) {
    if (!Array.isArray(match.ports)) {
      issue(issues, `${path}/ports`, '必须是数组');
    } else {
      match.ports.forEach((port, index) =>
        expectInteger(port, `${path}/ports/${index}`, issues, 1, 65_535),
      );
    }
  }
  if (match.inboundProtocols !== undefined) {
    if (!Array.isArray(match.inboundProtocols)) {
      issue(issues, `${path}/inboundProtocols`, '必须是数组');
    } else {
      match.inboundProtocols.forEach((protocol, index) =>
        expectEnum(protocol, `${path}/inboundProtocols/${index}`, INBOUND_PROTOCOLS, issues),
      );
    }
  }
}

function validateRouting(
  value: unknown,
  profileIds: ReadonlySet<string>,
  issues: ConfigIssue[],
): void {
  const path = '/routing';
  const routing = expectRecord(
    value,
    path,
    ['defaultProfileId', 'rules', 'blockPrivateTargets'],
    issues,
  );
  if (!routing) return;
  if (
    expectString(routing.defaultProfileId, `${path}/defaultProfileId`, issues, {
      min: 1,
      max: 64,
      pattern: ID_PATTERN,
    }) &&
    !profileIds.has(routing.defaultProfileId)
  ) {
    issue(issues, `${path}/defaultProfileId`, '引用的 profile 不存在');
  }
  expectBoolean(routing.blockPrivateTargets, `${path}/blockPrivateTargets`, issues);
  if (!Array.isArray(routing.rules)) {
    issue(issues, `${path}/rules`, '必须是数组');
    return;
  }
  const ruleIds = new Set<string>();
  routing.rules.forEach((value, index) => {
    const rulePath = `${path}/rules/${index}`;
    const rule = expectRecord(value, rulePath, ['id', 'enabled', 'match', 'action'], issues);
    if (!rule) return;
    if (
      expectString(rule.id, `${rulePath}/id`, issues, {
        min: 1,
        max: 64,
        pattern: ID_PATTERN,
      })
    ) {
      if (ruleIds.has(rule.id)) issue(issues, `${rulePath}/id`, '不能重复');
      ruleIds.add(rule.id);
    }
    expectBoolean(rule.enabled, `${rulePath}/enabled`, issues);
    validateRouteMatch(rule.match, `${rulePath}/match`, issues);
    const action = expectRecord(rule.action, `${rulePath}/action`, ['type', 'profileId'], issues);
    if (!action || !expectEnum(action.type, `${rulePath}/action/type`, ['use', 'block'], issues)) {
      return;
    }
    if (action.type === 'use') {
      if (
        expectString(action.profileId, `${rulePath}/action/profileId`, issues, {
          min: 1,
          max: 64,
          pattern: ID_PATTERN,
        }) &&
        !profileIds.has(action.profileId)
      ) {
        issue(issues, `${rulePath}/action/profileId`, '引用的 profile 不存在');
      }
    } else if (action.profileId !== undefined) {
      issue(issues, `${rulePath}/action/profileId`, 'block 动作不能包含 profileId');
    }
  });
}

function validateSubscription(value: unknown, issues: ConfigIssue[]): void {
  const path = '/subscription';
  const subscription = expectRecord(value, path, ['enabled', 'publicBaseUrl', 'formats'], issues);
  if (!subscription) return;
  expectBoolean(subscription.enabled, `${path}/enabled`, issues);
  if (subscription.publicBaseUrl !== undefined) {
    expectHttpsUrl(subscription.publicBaseUrl, `${path}/publicBaseUrl`, issues);
  }
  if (!Array.isArray(subscription.formats)) {
    issue(issues, `${path}/formats`, '必须是数组');
  } else {
    const seen = new Set<string>();
    subscription.formats.forEach((format, index) => {
      const itemPath = `${path}/formats/${index}`;
      if (expectEnum(format, itemPath, SUBSCRIPTION_FORMATS, issues)) {
        if (seen.has(format)) issue(issues, itemPath, '不能重复');
        seen.add(format);
      }
    });
  }
}

function validateSite(value: unknown, issues: ConfigIssue[]): void {
  const path = '/site';
  const site = expectRecord(value, path, ['camouflageUrl'], issues);
  if (site?.camouflageUrl !== undefined) {
    expectHttpsUrl(site.camouflageUrl, `${path}/camouflageUrl`, issues);
  }
}

function validateObservability(value: unknown, issues: ConfigIssue[]): void {
  const path = '/observability';
  const observability = expectRecord(value, path, ['logLevel', 'retention'], issues);
  if (!observability) return;
  expectEnum(observability.logLevel, `${path}/logLevel`, ['off', 'error', 'info'], issues);
  expectInteger(observability.retention, `${path}/retention`, issues, 0, 1_000);
}

export function parseWorkerConfig(value: unknown): WorkerConfigV1 {
  const issues: ConfigIssue[] = [];
  const root = expectRecord(
    value,
    '',
    [
      'schemaVersion',
      'revision',
      'inbound',
      'transports',
      'dns',
      'routing',
      'egressProfiles',
      'subscription',
      'site',
      'observability',
    ],
    issues,
  );
  if (!root) throw new ConfigValidationError(issues);

  if (root.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    issue(issues, '/schemaVersion', `必须是 ${CONFIG_SCHEMA_VERSION}`);
  }
  expectInteger(root.revision, '/revision', issues, 1, Number.MAX_SAFE_INTEGER);
  validateInbound(root.inbound, issues);
  validateTransports(root.transports, issues);
  validateDns(root.dns, issues);

  const profileIds = new Set<string>();
  if (!Array.isArray(root.egressProfiles) || root.egressProfiles.length === 0) {
    issue(issues, '/egressProfiles', '必须是非空数组');
  } else {
    root.egressProfiles.forEach((profile, index) => {
      const parsed = validateProfile(profile, index, issues);
      if (!parsed) return;
      if (profileIds.has(parsed.id)) {
        issue(issues, `/egressProfiles/${index}/id`, '不能重复');
      }
      profileIds.add(parsed.id);
    });
  }

  validateRouting(root.routing, profileIds, issues);
  validateSubscription(root.subscription, issues);
  validateSite(root.site, issues);
  validateObservability(root.observability, issues);

  if (issues.length > 0) throw new ConfigValidationError(issues);
  return structuredClone(value) as WorkerConfigV1;
}
