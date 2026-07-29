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

async function connectWithDeadline(
  connect: () => Promise<Socket>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Socket> {
  ensureActive(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;
  const operation = connect();
  const cancellation = new Promise<never>((_resolve, reject) => {
    const abort = () => {
      aborted = true;
      reject(new DOMException('连接已取消', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new Error('连接超时')), timeoutMs);
    operation.finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
  });
  try {
    const socket = await Promise.race([operation, cancellation]);
    ensureActive(signal);
    return socket;
  } catch (error) {
    void operation.then((socket) => socket.close()).catch(() => undefined);
    if (aborted) throw new DOMException('连接已取消', 'AbortError');
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
        return connectWithDeadline(
          async () =>
            writeAfterConnect(
              await openSocket(socketConnector, target, profile.timeoutMs),
              initialData,
            ),
          signal,
          profile.timeoutMs,
        );
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
        return connectWithDeadline(
          async () => {
            const socket =
              candidates.length === 1
                ? await openSocket(socketConnector, candidates[0]!, profile.timeoutMs)
                : (await raceSockets(socketConnector, candidates, profile.timeoutMs)).socket;
            return writeAfterConnect(socket, initialData);
          },
          signal,
          profile.timeoutMs,
        );
      },
    },
    socks5: {
      async connect(target, profile, credential, signal, initialData) {
        assertProfileType(profile, 'socks5');
        ensureActive(signal);
        return connectWithDeadline(
          () =>
            connectSocks5(
              target.hostname,
              target.port,
              initialData ?? null,
              proxyAddress(profile, credential),
              socketConnector,
            ),
          signal,
          profile.timeoutMs,
        );
      },
    },
    'http-connect': {
      async connect(target, profile, credential, signal, initialData) {
        assertProfileType(profile, 'http-connect');
        ensureActive(signal);
        return connectWithDeadline(
          () =>
            connectHttp(
              target.hostname,
              target.port,
              initialData ?? null,
              proxyAddress(profile, credential),
              socketConnector,
              false,
            ),
          signal,
          profile.timeoutMs,
        );
      },
    },
    'https-connect': {
      async connect(target, profile, credential, signal, initialData) {
        assertProfileType(profile, 'https-connect');
        ensureActive(signal);
        return connectWithDeadline(
          () =>
            connectHttps(
              target.hostname,
              target.port,
              initialData ?? null,
              proxyAddress(profile, credential),
              socketConnector,
            ),
          signal,
          profile.timeoutMs,
        );
      },
    },
    turn: {
      async connect(target, profile, credential, signal, initialData) {
        assertProfileType(profile, 'turn');
        ensureActive(signal);
        return connectWithDeadline(
          async () =>
            writeAfterConnect(
              await connectTurn(
                proxyAddress(profile, credential),
                target.hostname,
                target.port,
                socketConnector,
              ),
              initialData,
            ),
          signal,
          profile.timeoutMs,
        );
      },
    },
    sstp: {
      async connect(target, profile, credential, signal, initialData) {
        assertProfileType(profile, 'sstp');
        ensureActive(signal);
        return connectWithDeadline(
          async () =>
            writeAfterConnect(
              await connectSstp(
                proxyAddress(profile, credential),
                target.hostname,
                target.port,
                socketConnector,
              ),
              initialData,
            ),
          signal,
          profile.timeoutMs,
        );
      },
    },
  };

  return {
    get(type) {
      return connectors[type];
    },
  };
}
