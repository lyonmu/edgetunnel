import { describe, expect, it, vi } from 'vitest';
import type { EgressProfile } from '../../src/config/schema';
import { createConnectorRegistry } from '../../src/networking/connectors/registry';

function fakeSocket(): Socket {
  const socket = {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    opened: Promise.resolve({}),
    closed: new Promise<void>(() => undefined),
    close: vi.fn(async () => undefined),
    startTls: () => socket,
  };
  return socket as unknown as Socket;
}

const target = { hostname: 'target.example', port: 443 };
const credential = { username: 'alice', password: 'secret' };
const signal = new AbortController().signal;
const initialData = new Uint8Array([1, 2]);

function addressProfile(type: 'socks5' | 'http-connect' | 'https-connect' | 'sstp'): EgressProfile {
  return {
    id: type,
    type,
    enabled: true,
    timeoutMs: 5_000,
    hostname: 'proxy.example',
    port: 8443,
    credentialRef: 'proxy-main',
  };
}

describe('connector registry', () => {
  it('adapts SOCKS5, HTTP, HTTPS, TURN and SSTP existing connectors', async () => {
    const socket = fakeSocket();
    const socks5Connect = vi.fn(async () => socket);
    const httpConnect = vi.fn(async () => socket);
    const httpsConnect = vi.fn(async () => socket);
    const turnConnect = vi.fn(async () => socket);
    const sstpConnect = vi.fn(async () => socket);
    const registry = createConnectorRegistry({
      socketConnector: { connect: vi.fn(() => socket) },
      socks5Connect,
      httpConnect,
      httpsConnect,
      turnConnect,
      sstpConnect,
    });
    const turnProfile: EgressProfile = {
      id: 'turn',
      type: 'turn',
      enabled: true,
      timeoutMs: 5_000,
      hostname: 'turn.example',
      port: 3478,
      credentialRef: 'proxy-main',
      transport: 'tcp',
    };

    await registry
      .get('socks5')
      .connect(target, addressProfile('socks5'), credential, signal, initialData);
    await registry
      .get('http-connect')
      .connect(target, addressProfile('http-connect'), credential, signal, initialData);
    await registry
      .get('https-connect')
      .connect(target, addressProfile('https-connect'), credential, signal, initialData);
    await registry.get('turn').connect(target, turnProfile, credential, signal, initialData);
    await registry
      .get('sstp')
      .connect(target, addressProfile('sstp'), credential, signal, initialData);

    const address = {
      hostname: 'proxy.example',
      port: 8443,
      username: 'alice',
      password: 'secret',
    };
    expect(socks5Connect).toHaveBeenCalledWith(
      target.hostname,
      target.port,
      initialData,
      address,
      expect.anything(),
    );
    expect(httpConnect).toHaveBeenCalledWith(
      target.hostname,
      target.port,
      initialData,
      address,
      expect.anything(),
      false,
    );
    expect(httpsConnect).toHaveBeenCalledOnce();
    expect(turnConnect).toHaveBeenCalledOnce();
    expect(sstpConnect).toHaveBeenCalledOnce();
  });

  it('opens direct and ProxyIP sockets through the shared socket adapter', async () => {
    const socket = fakeSocket();
    const socketConnector = { connect: vi.fn(() => socket) };
    const registry = createConnectorRegistry({
      socketConnector,
      socks5Connect: vi.fn(),
      httpConnect: vi.fn(),
      httpsConnect: vi.fn(),
      turnConnect: vi.fn(),
      sstpConnect: vi.fn(),
    });
    const direct: EgressProfile = {
      id: 'direct',
      type: 'direct',
      enabled: true,
      timeoutMs: 5_000,
    };
    const proxyip: EgressProfile = {
      id: 'proxy',
      type: 'proxyip',
      enabled: true,
      timeoutMs: 5_000,
      endpoints: ['198.51.100.8:8443'],
    };

    await registry.get('direct').connect(target, direct, null, signal);
    await registry.get('proxyip').connect(target, proxyip, null, signal);

    expect(socketConnector.connect).toHaveBeenNthCalledWith(
      1,
      { hostname: target.hostname, port: target.port },
      { allowHalfOpen: true },
    );
    expect(socketConnector.connect).toHaveBeenNthCalledWith(
      2,
      { hostname: '198.51.100.8', port: 8443 },
      { allowHalfOpen: true },
    );
  });
});
