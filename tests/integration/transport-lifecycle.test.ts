import { describe, expect, it, vi } from 'vitest';
import type { TransportBridge } from '../../src/transports/bridge';
import type { Dialer } from '../../src/networking/dialer';
import { createRemoteConnWrapper } from '../../src/transports/bridge';
import { ConnectionScope, createTunnelConnectTCP } from '../../src/transports/session';

function bridge(): TransportBridge {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
  };
}

function socket(): Socket {
  const value = {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    opened: Promise.resolve({ remoteAddress: null, localAddress: null }),
    closed: new Promise<void>(() => undefined),
    close: vi.fn(async () => undefined),
    startTls: vi.fn(),
  };
  return value as unknown as Socket;
}

describe('ConnectionScope', () => {
  it('closes the target and bridge at most once', async () => {
    const output = bridge();
    const target = socket();
    const scope = new ConnectionScope(output);
    scope.attach(target);

    await Promise.all([scope.close('client'), scope.close('downlink'), scope.close('abort')]);

    expect(target.close).toHaveBeenCalledOnce();
    expect(output.close).toHaveBeenCalledOnce();
    expect(scope.signal.aborted).toBe(true);
  });

  it('propagates parent request cancellation and releases the target', async () => {
    const parent = new AbortController();
    const output = bridge();
    const target = socket();
    const scope = new ConnectionScope(output, parent.signal);
    scope.attach(target);

    parent.abort('request aborted');
    await vi.waitFor(() => {
      expect(target.close).toHaveBeenCalledOnce();
      expect(output.close).toHaveBeenCalledOnce();
    });

    expect(scope.signal.aborted).toBe(true);
  });

  it('immediately closes a socket attached after cancellation', async () => {
    const output = bridge();
    const target = socket();
    const scope = new ConnectionScope(output);
    await scope.close('early');

    scope.attach(target);
    await vi.waitFor(() => expect(target.close).toHaveBeenCalledOnce());
  });
});

describe('unified tunnel connector', () => {
  it.each(['vless', 'trojan', 'shadowsocks'] as const)(
    'passes the same target and initial payload to the Dialer for %s',
    async (inbound) => {
      const targetSocket = socket();
      const connect = vi.fn(async (target, selectedInbound) => ({
        socket: targetSocket,
        profile: {
          id: 'direct',
          type: 'direct',
          enabled: true,
          timeoutMs: 1_000,
        } as const,
        target,
        inbound: selectedInbound,
      }));
      const dialer: Dialer = { connect };
      const output = bridge();
      const wrapper = createRemoteConnWrapper();

      await createTunnelConnectTCP(dialer)(
        'example.com',
        443,
        new Uint8Array([1, 2]),
        output,
        wrapper,
        inbound,
      );

      expect(connect).toHaveBeenCalledWith(
        { hostname: 'example.com', port: 443 },
        inbound,
        expect.any(AbortSignal),
        new Uint8Array([1, 2]),
      );
      expect(wrapper.socket).toBe(targetSocket);
    },
  );
});
