import type { RuntimeSnapshot } from '../config/runtime';
import type { InboundProtocol, ShadowsocksMethod, SubscriptionFormat } from '../config/schema';

export type SubscriptionTransport = 'ws' | 'grpc' | 'xhttp';

export interface SubscriptionNode {
  name: string;
  protocol: InboundProtocol;
  transport: SubscriptionTransport;
  server: string;
  port: number;
  sni: string;
  host: string;
  uuid?: string;
  password?: string;
  method?: ShadowsocksMethod;
  path?: string;
  serviceName?: string;
  packetEncoding?: 'xudp';
}

function publicEndpoint(snapshot: RuntimeSnapshot, requestUrl: URL): URL {
  const configured = snapshot.config.subscription.publicBaseUrl;
  const url = new URL(configured ?? requestUrl.origin);
  if (url.protocol !== 'https:') throw new Error('订阅公开地址必须使用 HTTPS');
  return url;
}

export function buildSubscriptionNodes(
  snapshot: RuntimeSnapshot,
  requestUrl: URL,
): readonly SubscriptionNode[] {
  const endpoint = publicEndpoint(snapshot, requestUrl);
  const server = endpoint.hostname;
  const port = endpoint.port ? Number(endpoint.port) : 443;
  const common = { server, port, sni: server, host: server };
  const nodes: SubscriptionNode[] = [];
  const { inbound, transports } = snapshot.config;

  if (inbound.vless.enabled) {
    if (transports.websocket.enabled) {
      nodes.push({
        ...common,
        name: 'EdgeTunnel VLESS WS',
        protocol: 'vless',
        transport: 'ws',
        uuid: snapshot.identity.vlessUuid,
        path: transports.websocket.path,
        packetEncoding: 'xudp',
      });
    }
    if (transports.grpc.enabled) {
      nodes.push({
        ...common,
        name: 'EdgeTunnel VLESS gRPC',
        protocol: 'vless',
        transport: 'grpc',
        uuid: snapshot.identity.vlessUuid,
        serviceName: transports.grpc.serviceName,
        packetEncoding: 'xudp',
      });
    }
    if (transports.xhttp.enabled) {
      nodes.push({
        ...common,
        name: 'EdgeTunnel VLESS XHTTP',
        protocol: 'vless',
        transport: 'xhttp',
        uuid: snapshot.identity.vlessUuid,
        path: transports.xhttp.path,
        packetEncoding: 'xudp',
      });
    }
  }

  if (inbound.trojan.enabled && snapshot.secrets.trojanPassword) {
    if (transports.websocket.enabled) {
      nodes.push({
        ...common,
        name: 'EdgeTunnel Trojan WS',
        protocol: 'trojan',
        transport: 'ws',
        password: snapshot.secrets.trojanPassword,
        path: transports.websocket.path,
      });
    }
    if (transports.grpc.enabled) {
      nodes.push({
        ...common,
        name: 'EdgeTunnel Trojan gRPC',
        protocol: 'trojan',
        transport: 'grpc',
        password: snapshot.secrets.trojanPassword,
        serviceName: transports.grpc.serviceName,
      });
    }
  }

  if (
    inbound.shadowsocks.enabled &&
    transports.websocket.enabled &&
    snapshot.secrets.shadowsocksPassword
  ) {
    nodes.push({
      ...common,
      name: 'EdgeTunnel Shadowsocks WS',
      protocol: 'shadowsocks',
      transport: 'ws',
      password: snapshot.secrets.shadowsocksPassword,
      method: inbound.shadowsocks.method,
      path: transports.websocket.path,
    });
  }
  return nodes;
}

function standardBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function transportParameters(node: SubscriptionNode): URLSearchParams {
  const params = new URLSearchParams({
    security: 'tls',
    type: node.transport,
    sni: node.sni,
  });
  if (node.transport === 'grpc') {
    params.set('authority', node.host);
    params.set('serviceName', node.serviceName ?? '');
  } else {
    params.set('host', node.host);
    params.set('path', node.path ?? '/');
  }
  if (node.transport === 'xhttp') params.set('mode', 'stream-one');
  if (node.protocol === 'vless') {
    params.set('encryption', 'none');
    params.set('packetEncoding', node.packetEncoding ?? 'xudp');
  }
  return params;
}

function serializeUri(node: SubscriptionNode): string {
  if (node.protocol === 'shadowsocks') {
    const plugin = `v2ray-plugin;mode=websocket;host=${node.host};path=${node.path ?? '/'};tls;mux=0`;
    return `ss://${standardBase64(`${node.method}:${node.password}`)}@${node.server}:${node.port}?plugin=${encodeURIComponent(plugin)}#${encodeURIComponent(node.name)}`;
  }
  const credential = node.protocol === 'vless' ? node.uuid : node.password;
  return `${node.protocol}://${encodeURIComponent(credential ?? '')}@${node.server}:${node.port}?${transportParameters(node).toString()}#${encodeURIComponent(node.name)}`;
}

export function serializeMixed(nodes: readonly SubscriptionNode[]): string {
  return nodes.map(serializeUri).join('\n');
}

export function serializeBase64(nodes: readonly SubscriptionNode[]): string {
  return standardBase64(serializeMixed(nodes));
}

function clashProxy(node: SubscriptionNode): Record<string, unknown> | null {
  if (node.transport === 'xhttp') return null;
  const common: Record<string, unknown> = {
    name: node.name,
    server: node.server,
    port: node.port,
    tls: true,
    servername: node.sni,
    network: node.transport,
    udp: true,
  };
  if (node.transport === 'ws') {
    common['ws-opts'] = {
      path: node.path,
      headers: { Host: node.host },
    };
  } else {
    common['grpc-opts'] = { 'grpc-service-name': node.serviceName };
  }
  if (node.protocol === 'vless') {
    return {
      ...common,
      type: 'vless',
      uuid: node.uuid,
      encryption: 'none',
      'packet-encoding': node.packetEncoding,
    };
  }
  if (node.protocol === 'trojan') {
    return { ...common, type: 'trojan', password: node.password };
  }
  if (node.transport !== 'ws') return null;
  return {
    ...common,
    type: 'ss',
    cipher: node.method,
    password: node.password,
    plugin: 'v2ray-plugin',
    'plugin-opts': {
      mode: 'websocket',
      host: node.host,
      path: node.path,
      tls: true,
      mux: false,
    },
  };
}

export function serializeClash(nodes: readonly SubscriptionNode[]): string {
  const proxies = nodes.map(clashProxy).filter((node) => node !== null);
  return JSON.stringify(
    {
      'mixed-port': 7890,
      mode: 'rule',
      proxies,
      'proxy-groups': [
        {
          name: 'EdgeTunnel',
          type: 'select',
          proxies: proxies.map((proxy) => proxy.name),
        },
      ],
      rules: ['MATCH,EdgeTunnel'],
    },
    null,
    2,
  );
}

function singBoxOutbound(node: SubscriptionNode): Record<string, unknown> | null {
  if (node.transport === 'xhttp') return null;
  const outbound: Record<string, unknown> = {
    type: node.protocol,
    tag: node.name,
    server: node.server,
    server_port: node.port,
    tls: {
      enabled: true,
      server_name: node.sni,
      utls: { enabled: true, fingerprint: 'chrome' },
    },
  };
  if (node.protocol === 'vless') {
    outbound.uuid = node.uuid;
    outbound.packet_encoding = node.packetEncoding;
  } else {
    outbound.password = node.password;
  }
  if (node.protocol === 'shadowsocks') {
    outbound.method = node.method;
    outbound.plugin = 'v2ray-plugin';
    outbound.plugin_opts = `mode=websocket;host=${node.host};path=${node.path};tls;mux=0`;
    delete outbound.tls;
  } else if (node.transport === 'ws') {
    outbound.transport = {
      type: 'ws',
      path: node.path,
      headers: { Host: node.host },
    };
  } else {
    outbound.transport = { type: 'grpc', service_name: node.serviceName };
  }
  return outbound;
}

export function serializeSingBox(nodes: readonly SubscriptionNode[]): string {
  return JSON.stringify(
    {
      log: { level: 'warn' },
      outbounds: nodes.map(singBoxOutbound).filter((node) => node !== null),
    },
    null,
    2,
  );
}

function surgeProxy(node: SubscriptionNode): string | null {
  if (node.transport !== 'ws') return null;
  const base = `${node.name} = ${node.protocol === 'shadowsocks' ? 'ss' : node.protocol}, ${node.server}, ${node.port}`;
  if (node.protocol === 'trojan') {
    return `${base}, password=${JSON.stringify(node.password)}, sni=${node.sni}, ws=true, ws-path=${node.path}, ws-headers=Host:${node.host}`;
  }
  return null;
}

export function serializeSurge(nodes: readonly SubscriptionNode[]): string {
  const proxies = nodes.map(surgeProxy).filter((line) => line !== null);
  return [
    '[Proxy]',
    ...proxies,
    '',
    '[Proxy Group]',
    `EdgeTunnel = select, ${proxies.map((line) => line.split(' = ')[0]).join(', ')}`,
  ].join('\n');
}

export function serializeSubscription(
  format: SubscriptionFormat,
  nodes: readonly SubscriptionNode[],
): string {
  switch (format) {
    case 'mixed':
      return serializeMixed(nodes);
    case 'base64':
      return serializeBase64(nodes);
    case 'clash':
      return serializeClash(nodes);
    case 'singbox':
      return serializeSingBox(nodes);
    case 'surge':
      return serializeSurge(nodes);
  }
}
