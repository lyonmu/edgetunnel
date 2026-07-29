import type { EgressProfile } from '../../config/schema';
import type { ProfileCredential } from '../../security/secret-store';
import { httpConnect, httpsConnect, parseSocks5Address, socks5Connect } from '../proxy-connectors';
import {
  cloudflareSocketConnector,
  openSocket,
  raceSockets,
  writeInitialData,
  type DialCandidate,
  type SocketConnector,
} from '../sockets';
import { sstpConnect } from '../sstp';
import { turnConnect } from '../turn';
import type { Connector, ConnectorRegistry } from './types';

export interface ConnectorRegistryDependencies {
  socketConnector?: SocketConnector;
  socks5Connect?: typeof socks5Connect;
  httpConnect?: typeof httpConnect;
  httpsConnect?: typeof httpsConnect;
  turnConnect?: typeof turnConnect;
  sstpConnect?: typeof sstpConnect;
}

type AddressProfile = Extract<
  EgressProfile,
  { type: 'socks5' | 'http-connect' | 'https-connect' | 'turn' | 'sstp' }
>;

function assertProfileType<T extends EgressProfile['type']>(
  profile: EgressProfile,
  type: T,
): asserts profile is Extract<EgressProfile, { type: T }> {
  if (profile.type !== type) throw new Error(`连接器与 profile 类型不匹配：${type}`);
}

function proxyAddress(profile: AddressProfile, credential: ProfileCredential | null) {
  return {
    hostname: profile.hostname,
    port: profile.port,
    ...(credential?.username ? { username: credential.username } : {}),
    ...(credential?.password ? { password: credential.password } : {}),
  };
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('连接已取消', 'AbortError');
}

async function writeAfterConnect(socket: Socket, initialData?: Uint8Array): Promise<Socket> {
  if (initialData?.byteLength) await writeInitialData(socket, initialData);
  return socket;
}

export function createConnectorRegistry(
  dependencies: ConnectorRegistryDependencies = {},
): ConnectorRegistry {
  const socketConnector = dependencies.socketConnector ?? cloudflareSocketConnector;
  const connectSocks5 = dependencies.socks5Connect ?? socks5Connect;
  const connectHttp = dependencies.httpConnect ?? httpConnect;
  const connectHttps = dependencies.httpsConnect ?? httpsConnect;
  const connectTurn = dependencies.turnConnect ?? turnConnect;
  const connectSstp = dependencies.sstpConnect ?? sstpConnect;

  const connectors: Record<EgressProfile['type'], Connector> = {
    direct: {
      async connect(target, profile, _credential, signal, initialData) {
        assertProfileType(profile, 'direct');
        ensureActive(signal);
        const socket = await openSocket(socketConnector, target, profile.timeoutMs);
        ensureActive(signal);
        return writeAfterConnect(socket, initialData);
      },
    },
    proxyip: {
      async connect(_target, profile, _credential, signal, initialData) {
        assertProfileType(profile, 'proxyip');
        ensureActive(signal);
        const candidates: DialCandidate[] = profile.endpoints.map((endpoint) => {
          const parsed = parseSocks5Address(endpoint, 443);
          return { hostname: parsed.hostname, port: parsed.port };
        });
        const socket =
          candidates.length === 1
            ? await openSocket(socketConnector, candidates[0]!, profile.timeoutMs)
            : (await raceSockets(socketConnector, candidates, profile.timeoutMs)).socket;
        ensureActive(signal);
        return writeAfterConnect(socket, initialData);
      },
    },
    socks5: {
      async connect(target, profile, credential, signal, initialData) {
        assertProfileType(profile, 'socks5');
        ensureActive(signal);
        return connectSocks5(
          target.hostname,
          target.port,
          initialData ?? null,
          proxyAddress(profile, credential),
          socketConnector,
        );
      },
    },
    'http-connect': {
      async connect(target, profile, credential, signal, initialData) {
        assertProfileType(profile, 'http-connect');
        ensureActive(signal);
        return connectHttp(
          target.hostname,
          target.port,
          initialData ?? null,
          proxyAddress(profile, credential),
          socketConnector,
          false,
        );
      },
    },
    'https-connect': {
      async connect(target, profile, credential, signal, initialData) {
        assertProfileType(profile, 'https-connect');
        ensureActive(signal);
        return connectHttps(
          target.hostname,
          target.port,
          initialData ?? null,
          proxyAddress(profile, credential),
          socketConnector,
        );
      },
    },
    turn: {
      async connect(target, profile, credential, signal, initialData) {
        assertProfileType(profile, 'turn');
        ensureActive(signal);
        const socket = await connectTurn(
          proxyAddress(profile, credential),
          target.hostname,
          target.port,
          socketConnector,
        );
        ensureActive(signal);
        return writeAfterConnect(socket, initialData);
      },
    },
    sstp: {
      async connect(target, profile, credential, signal, initialData) {
        assertProfileType(profile, 'sstp');
        ensureActive(signal);
        const socket = await connectSstp(
          proxyAddress(profile, credential),
          target.hostname,
          target.port,
          socketConnector,
        );
        ensureActive(signal);
        return writeAfterConnect(socket, initialData);
      },
    },
  };

  return {
    get(type) {
      return connectors[type];
    },
  };
}
