import { describe, expect, it } from 'vitest';
import {
  openSocket,
  raceSockets,
  writeInitialData,
  type SocketConnector,
} from '../../src/networking/sockets';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolveFunction!: (value: T) => void;
  let rejectFunction!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFunction = resolve;
    rejectFunction = reject;
  });
  return { promise, resolve: resolveFunction, reject: rejectFunction };
}

function fakeSocket(opened: Promise<SocketInfo>) {
  const writes: Uint8Array[] = [];
  const closed = deferred<void>();
  let closeCount = 0;
  const socket: Socket = {
    readable: new ReadableStream(),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(chunk);
      },
    }),
    closed: Promise.resolve(),
    opened,
    upgraded: false,
    secureTransport: 'off',
    close() {
      closeCount += 1;
      closed.resolve();
      return Promise.resolve();
    },
    startTls() {
      return socket;
    },
  } satisfies Socket;
  return {
    socket,
    writes,
    closed: closed.promise,
    get closeCount() {
      return closeCount;
    },
  };
}

describe('socket adapter', () => {
  it('opens a single candidate', async () => {
    const target = fakeSocket(Promise.resolve({}));
    const connector: SocketConnector = {
      connect() {
        return target.socket;
      },
    };

    await expect(openSocket(connector, { hostname: 'example.com', port: 443 }, 100)).resolves.toBe(
      target.socket,
    );
  });

  it('closes losing race candidates', async () => {
    const firstOpened = deferred<SocketInfo>();
    const secondOpened = deferred<SocketInfo>();
    const first = fakeSocket(firstOpened.promise);
    const second = fakeSocket(secondOpened.promise);
    const sockets = [first.socket, second.socket];
    const connector: SocketConnector = {
      connect() {
        const socket = sockets.shift();
        if (!socket) {
          throw new Error('Unexpected candidate');
        }
        return socket;
      },
    };

    const resultPromise = raceSockets(
      connector,
      [
        { hostname: 'first.example', port: 443 },
        { hostname: 'second.example', port: 443 },
      ],
      100,
    );
    secondOpened.resolve({});
    const result = await resultPromise;
    firstOpened.resolve({});
    await first.closed;

    expect(result.socket).toBe(second.socket);
    expect(first.closeCount).toBe(1);
    expect(second.closeCount).toBe(0);
  });

  it('closes a socket when opening times out', async () => {
    const target = fakeSocket(new Promise(() => undefined));
    const connector: SocketConnector = {
      connect() {
        return target.socket;
      },
    };

    await expect(
      openSocket(connector, { hostname: 'timeout.example', port: 443 }, 5),
    ).rejects.toThrow('连接超时');
    expect(target.closeCount).toBe(1);
  });

  it('writes initial data once', async () => {
    const target = fakeSocket(Promise.resolve({}));
    const payload = new Uint8Array([1, 2, 3]);

    await writeInitialData(target.socket, payload);

    expect(target.writes).toEqual([payload]);
  });
});
