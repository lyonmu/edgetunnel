import net, { type Socket as NodeSocket } from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import type { SocketConnector } from '../../src/networking/sockets';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './tls-certificate';

export interface TcpFixture {
  port: number;
  connector: SocketConnector;
  close(): Promise<void>;
}

function nodeSocket(socket: NodeSocket): Socket {
  const opened = socket.connecting
    ? new Promise<SocketInfo>((resolve, reject) => {
        socket.once('connect', () => resolve({}));
        socket.once('error', reject);
      })
    : Promise.resolve({});
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
  });
  return {
    readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          socket.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), (error) =>
            error ? reject(error) : resolve(),
          );
        });
      },
      close() {
        return new Promise<void>((resolve) => socket.end(resolve));
      },
      abort() {
        socket.destroy();
      },
    }),
    opened,
    closed,
    close: async () => {
      socket.destroy();
    },
    startTls() {
      throw new Error('startTls is not implemented by the TCP fixture');
    },
  } as unknown as Socket;
}

export async function startTcpServer(
  handler: (socket: NodeSocket) => void | Promise<void>,
): Promise<TcpFixture> {
  const sockets = new Set<NodeSocket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    void Promise.resolve(handler(socket)).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP fixture did not bind a port');

  return {
    port: address.port,
    connector: {
      connect({ hostname, port }) {
        return nodeSocket(net.createConnection({ host: hostname, port }));
      },
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export async function startTlsServer(
  handler: (socket: NodeSocket) => void | Promise<void>,
): Promise<TcpFixture> {
  const sockets = new Set<NodeSocket>();
  const server = tls.createServer(
    {
      key: TEST_TLS_KEY,
      cert: TEST_TLS_CERT,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    },
    (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      void Promise.resolve(handler(socket)).catch(() => socket.destroy());
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TLS fixture did not bind a port');

  return {
    port: address.port,
    connector: {
      connect({ hostname, port }, options) {
        return options?.secureTransport === 'on'
          ? nodeSocket(
              tls.connect({
                host: hostname,
                port,
                rejectUnauthorized: false,
                minVersion: 'TLSv1.2',
                maxVersion: 'TLSv1.2',
              }),
            )
          : nodeSocket(net.createConnection({ host: hostname, port }));
      },
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export async function writeFragmented(
  socket: NodeSocket,
  bytes: Uint8Array,
  chunkSize = 1,
): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    await new Promise<void>((resolve, reject) => {
      socket.write(bytes.subarray(offset, offset + chunkSize), (error) =>
        error ? reject(error) : resolve(),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
