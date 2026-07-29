export const CONFIG_SCHEMA_VERSION = 1 as const;

export type InboundProtocol = 'vless' | 'trojan' | 'shadowsocks';
export type SubscriptionFormat = 'mixed' | 'base64' | 'clash' | 'singbox' | 'surge';
export type ShadowsocksMethod = 'aes-128-gcm' | 'aes-256-gcm';

interface BaseEgressProfile {
  id: string;
  enabled: boolean;
  timeoutMs: number;
}

export interface DirectEgressProfile extends BaseEgressProfile {
  type: 'direct';
}

export interface ProxyIpEgressProfile extends BaseEgressProfile {
  type: 'proxyip';
  endpoints: string[];
}

interface AddressEgressProfile extends BaseEgressProfile {
  hostname: string;
  port: number;
  credentialRef?: string;
}

export interface Socks5EgressProfile extends AddressEgressProfile {
  type: 'socks5';
}

export interface HttpConnectEgressProfile extends AddressEgressProfile {
  type: 'http-connect';
}

export interface HttpsConnectEgressProfile extends AddressEgressProfile {
  type: 'https-connect';
  tlsServerName?: string;
}

export interface TurnEgressProfile extends AddressEgressProfile {
  type: 'turn';
  transport: 'tcp' | 'tls';
  tlsServerName?: string;
}

export interface SstpEgressProfile extends AddressEgressProfile {
  type: 'sstp';
  tlsServerName?: string;
}

export type EgressProfile =
  | DirectEgressProfile
  | ProxyIpEgressProfile
  | Socks5EgressProfile
  | HttpConnectEgressProfile
  | HttpsConnectEgressProfile
  | TurnEgressProfile
  | SstpEgressProfile;

export interface RouteMatch {
  domains?: string[];
  domainSuffixes?: string[];
  cidrs?: string[];
  ports?: number[];
  inboundProtocols?: InboundProtocol[];
}

export type RouteAction = { type: 'use'; profileId: string } | { type: 'block' };

export interface RoutingRule {
  id: string;
  enabled: boolean;
  match: RouteMatch;
  action: RouteAction;
}

export interface WorkerConfigV1 {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  revision: number;
  inbound: {
    vless: { enabled: boolean };
    trojan: { enabled: boolean };
    shadowsocks: {
      enabled: boolean;
      method: ShadowsocksMethod;
    };
  };
  transports: {
    websocket: { enabled: boolean; path: string };
    grpc: { enabled: boolean; serviceName: string };
    xhttp: { enabled: boolean; path: string; mode: 'stream-one' };
  };
  dns: {
    enabled: boolean;
    dohUrl: string;
    timeoutMs: number;
    maxMessageBytes: number;
  };
  routing: {
    defaultProfileId: string;
    rules: RoutingRule[];
    blockPrivateTargets: boolean;
  };
  egressProfiles: EgressProfile[];
  subscription: {
    enabled: boolean;
    publicBaseUrl?: string;
    formats: SubscriptionFormat[];
  };
  site: {
    camouflageUrl?: string;
  };
  observability: {
    logLevel: 'off' | 'error' | 'info';
    retention: number;
  };
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`配置校验失败：${issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}
