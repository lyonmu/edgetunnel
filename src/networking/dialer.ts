import type { WorkerConfigV1, InboundProtocol } from '../config/schema';
import type { RuntimeSnapshot } from '../config/runtime';
import type { ProfileCredential } from '../security/secret-store';
import type { ConnectorRegistry, DialResult, DialTarget } from './connectors/types';

export type RouteDecision =
  | { type: 'use'; profileId: string; ruleId?: string }
  | { type: 'block'; ruleId: string };

export interface DialerDependencies {
  registry: ConnectorRegistry;
  resolveCredential(ref: string): Promise<ProfileCredential | null>;
}

export interface Dialer {
  connect(
    target: DialTarget,
    inbound: InboundProtocol,
    signal: AbortSignal,
    initialData?: Uint8Array,
  ): Promise<DialResult>;
}

export class BlockedTargetError extends Error {
  constructor(readonly target: DialTarget) {
    super('目标地址已被安全策略阻止');
    this.name = 'BlockedTargetError';
  }
}

function domainMatches(hostname: string, domains: readonly string[] | undefined): boolean {
  return Boolean(domains?.some((domain) => hostname === domain.toLowerCase()));
}

function suffixMatches(hostname: string, suffixes: readonly string[] | undefined): boolean {
  return Boolean(
    suffixes?.some((suffix) => {
      const normalized = suffix.toLowerCase().replace(/^\./, '');
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    }),
  );
}

function ipv4Number(hostname: string): number | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function cidrMatches(hostname: string, cidr: string): boolean {
  const [networkText, prefixText] = cidr.split('/');
  const address = ipv4Number(hostname);
  const network = ipv4Number(networkText ?? '');
  const prefix = Number(prefixText);
  if (
    address === null ||
    network === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

function ruleMatches(
  target: DialTarget,
  inbound: InboundProtocol,
  match: WorkerConfigV1['routing']['rules'][number]['match'],
): boolean {
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (match.domains && !domainMatches(hostname, match.domains)) return false;
  if (match.domainSuffixes && !suffixMatches(hostname, match.domainSuffixes)) return false;
  if (match.cidrs && !match.cidrs.some((cidr) => cidrMatches(hostname, cidr))) return false;
  if (match.ports && !match.ports.includes(target.port)) return false;
  if (match.inboundProtocols && !match.inboundProtocols.includes(inbound)) return false;
  return Object.keys(match).length > 0;
}

export function selectRoute(
  target: DialTarget,
  inbound: InboundProtocol,
  config: WorkerConfigV1,
): RouteDecision {
  for (const rule of config.routing.rules) {
    if (!rule.enabled || !ruleMatches(target, inbound, rule.match)) continue;
    return rule.action.type === 'block'
      ? { type: 'block', ruleId: rule.id }
      : { type: 'use', profileId: rule.action.profileId, ruleId: rule.id };
  }
  return { type: 'use', profileId: config.routing.defaultProfileId };
}

function isPrivateTarget(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '::') return true;
  if (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }
  const address = ipv4Number(normalized);
  if (address === null) return false;
  return [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ].some((cidr) => cidrMatches(normalized, cidr));
}

function abortError(): DOMException {
  return new DOMException('连接已取消', 'AbortError');
}

export function createDialer(snapshot: RuntimeSnapshot, dependencies: DialerDependencies): Dialer {
  return {
    async connect(
      target: DialTarget,
      inbound: InboundProtocol,
      signal: AbortSignal,
      initialData?: Uint8Array,
    ): Promise<DialResult> {
      if (signal.aborted) throw abortError();
      if (snapshot.config.routing.blockPrivateTargets && isPrivateTarget(target.hostname)) {
        throw new BlockedTargetError(target);
      }
      const decision = selectRoute(target, inbound, snapshot.config);
      if (decision.type === 'block') throw new BlockedTargetError(target);
      const profile = snapshot.config.egressProfiles.find(
        (candidate) => candidate.id === decision.profileId,
      );
      if (!profile || !profile.enabled) {
        throw new Error('路由引用的出站 profile 不存在或未启用');
      }
      const credential =
        'credentialRef' in profile && profile.credentialRef
          ? await dependencies.resolveCredential(profile.credentialRef)
          : null;
      if (signal.aborted) throw abortError();
      const connector = dependencies.registry.get(profile.type);
      const socket = await connector.connect(target, profile, credential, signal, initialData);
      if (signal.aborted) {
        await socket.close().catch(() => undefined);
        throw abortError();
      }
      return { socket, profile, target, inbound };
    },
  };
}
