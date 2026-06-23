import { connect } from 'cloudflare:sockets';

export interface SocketConnector {
  connect(address: SocketAddress, options?: SocketOptions): Socket;
}

export interface DialCandidate extends SocketAddress {
  index?: number;
  resolvedFrom?: string;
}

export const cloudflareSocketConnector: SocketConnector = {
  connect(address, options) {
    return connect(address, options);
  },
};

async function closeSocket(socket: Socket): Promise<void> {
  try {
    await socket.close();
  } catch {
    // Closing an already-failed candidate is best effort.
  }
}

export async function openSocket(
  connector: SocketConnector,
  candidate: DialCandidate,
  timeoutMs: number,
): Promise<Socket> {
  const socket = connector.connect(candidate, { allowHalfOpen: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      socket.opened,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('连接超时')), timeoutMs);
      }),
    ]);
    return socket;
  } catch (error) {
    await closeSocket(socket);
    throw error;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function raceSockets(
  connector: SocketConnector,
  candidates: readonly DialCandidate[],
  timeoutMs: number,
): Promise<{ socket: Socket; candidate: DialCandidate }> {
  if (candidates.length === 0) {
    throw new Error('没有可用的拨号候选');
  }
  const attempts = candidates.map(async (candidate) => ({
    socket: await openSocket(connector, candidate, timeoutMs),
    candidate,
  }));
  let winner: { socket: Socket; candidate: DialCandidate } | undefined;
  try {
    winner = await Promise.any(attempts);
    return winner;
  } finally {
    if (winner) {
      for (const attempt of attempts) {
        void attempt
          .then(({ socket }) => (socket !== winner?.socket ? closeSocket(socket) : undefined))
          .catch(() => undefined);
      }
    }
  }
}

export async function writeInitialData(socket: Socket, data: Uint8Array): Promise<void> {
  if (data.byteLength === 0) {
    return;
  }
  const writer = socket.writable.getWriter();
  try {
    await writer.write(data);
  } finally {
    writer.releaseLock();
  }
}
