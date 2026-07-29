import type { ProxyAddress } from '../app/types';
import { TlsClient } from './tls';

export function parseSocks5Address(address: string, defaultPort: number): ProxyAddress {
  let username: string | undefined;
  let password: string | undefined;
  let hostPart = address;
  let portPart: string | undefined;

  const atIndex = address.lastIndexOf('@');
  if (atIndex !== -1) {
    const auth = address.slice(0, atIndex);
    hostPart = address.slice(atIndex + 1);
    const colonIndex = auth.indexOf(':');
    if (colonIndex !== -1) {
      username = auth.slice(0, colonIndex);
      password = auth.slice(colonIndex + 1);
    } else {
      username = auth;
    }
  }

  if (hostPart.startsWith('[')) {
    const closeBracket = hostPart.indexOf(']');
    if (closeBracket === -1) throw new Error('Invalid IPv6 address: missing ]');
    const hostname = hostPart.slice(1, closeBracket);
    const rest = hostPart.slice(closeBracket + 1);
    const port = rest.startsWith(':') ? parseInt(rest.slice(1), 10) : defaultPort;
    return {
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      hostname,
      port,
    };
  }

  const lastColon = hostPart.lastIndexOf(':');
  if (lastColon !== -1 && hostPart.indexOf(':') === lastColon) {
    portPart = hostPart.slice(lastColon + 1);
    hostPart = hostPart.slice(0, lastColon);
  }

  if (hostPart.includes(':')) {
    throw new Error('IPv6 address must be enclosed in brackets');
  }

  const port = portPart ? parseInt(portPart, 10) : defaultPort;
  return {
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    hostname: hostPart,
    port,
  };
}

export function isIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

export function isIPHostname(hostname: string): boolean {
  if (hostname.startsWith('[')) return true;
  return isIPv4(hostname);
}

export function stripIPv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

export interface SocketConnector {
  connect(address: SocketAddress, options?: SocketOptions): Socket;
}

export async function socks5Connect(
  targetHost: string,
  targetPort: number,
  initialData: Uint8Array | null,
  proxyAddr: ProxyAddress,
  connector: SocketConnector,
): Promise<Socket> {
  const { username, password, hostname, port } = proxyAddr;
  const socket = connector.connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let pending = new Uint8Array(0);
  const readExact = async (length: number): Promise<Uint8Array> => {
    while (pending.byteLength < length) {
      const response = await reader.read();
      if (response.done || !response.value) throw new Error('S5 response is truncated');
      pending = new Uint8Array([...pending, ...response.value]);
    }
    const value = pending.slice(0, length);
    pending = pending.slice(length);
    return value;
  };
  try {
    const authMethods =
      username && password
        ? new Uint8Array([0x05, 0x02, 0x00, 0x02])
        : new Uint8Array([0x05, 0x01, 0x00]);
    await writer.write(authMethods);
    let response = await readExact(2);
    if (response[0] !== 0x05) throw new Error('S5 method selection failed');
    const selectedMethod = response[1];
    if (selectedMethod === 0x02) {
      if (!username || !password) throw new Error('S5 requires authentication');
      const userBytes = new TextEncoder().encode(username);
      const passBytes = new TextEncoder().encode(password);
      const authPacket = new Uint8Array([
        0x01,
        userBytes.length,
        ...userBytes,
        passBytes.length,
        ...passBytes,
      ]);
      await writer.write(authPacket);
      response = await readExact(2);
      if (response[0] !== 0x01 || response[1] !== 0x00) throw new Error('S5 authentication failed');
    } else if (selectedMethod !== 0x00) {
      throw new Error(`S5 unsupported auth method: ${selectedMethod}`);
    }

    const hostBytes = new TextEncoder().encode(targetHost);
    const connectPacket = new Uint8Array([
      0x05,
      0x01,
      0x00,
      0x03,
      hostBytes.length,
      ...hostBytes,
      targetPort >> 8,
      targetPort & 0xff,
    ]);
    await writer.write(connectPacket);
    response = await readExact(4);
    if (response[0] !== 0x05 || response[1] !== 0x00) throw new Error('S5 connection failed');
    if (response[3] === 0x01) {
      await readExact(6);
    } else if (response[3] === 0x03) {
      const domainLength = (await readExact(1))[0] ?? 0;
      await readExact(domainLength + 2);
    } else if (response[3] === 0x04) {
      await readExact(18);
    } else {
      throw new Error('S5 connection response has an invalid address type');
    }

    if (initialData && initialData.byteLength > 0) await writer.write(initialData);
    writer.releaseLock();
    reader.releaseLock();
    if (pending.byteLength) {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const transformWriter = writable.getWriter();
      void transformWriter
        .write(pending)
        .finally(() => transformWriter.releaseLock())
        .then(() => socket.readable.pipeTo(writable))
        .catch(() => undefined);
      return {
        readable,
        writable: socket.writable,
        opened: socket.opened,
        closed: socket.closed,
        close: () => socket.close(),
      } as Socket;
    }
    return socket;
  } catch (error) {
    try {
      writer.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      void socket.close();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export async function httpConnect(
  targetHost: string,
  targetPort: number,
  initialData: Uint8Array | null,
  proxyAddr: ProxyAddress,
  connector: SocketConnector,
  https = false,
): Promise<Socket> {
  const { username, password, hostname, port } = proxyAddr;
  const socket = https
    ? connector.connect({ hostname, port }, { secureTransport: 'on', allowHalfOpen: false })
    : connector.connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  try {
    if (https) await socket.opened;

    const auth =
      username && password
        ? `Proxy-Authorization: Basic ${btoa(`${username}:${password}`)}\r\n`
        : '';
    const request = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}User-Agent: Mozilla/5.0\r\nConnection: keep-alive\r\n\r\n`;
    await writer.write(encoder.encode(request));
    writer.releaseLock();

    let responseBuffer = new Uint8Array(0);
    let headerEndIndex = -1;
    let bytesRead = 0;
    while (headerEndIndex === -1 && bytesRead < 8192) {
      const { done, value } = await reader.read();
      if (done || !value)
        throw new Error(`${https ? 'HTTPS' : 'HTTP'} proxy closed before CONNECT response`);
      responseBuffer = new Uint8Array([...responseBuffer, ...value]);
      bytesRead = responseBuffer.length;
      const crlfcrlf = responseBuffer.findIndex(
        (_, i) =>
          i < responseBuffer.length - 3 &&
          responseBuffer[i] === 0x0d &&
          responseBuffer[i + 1] === 0x0a &&
          responseBuffer[i + 2] === 0x0d &&
          responseBuffer[i + 3] === 0x0a,
      );
      if (crlfcrlf !== -1) headerEndIndex = crlfcrlf + 4;
    }

    if (headerEndIndex === -1) throw new Error('Proxy CONNECT response header too long or invalid');
    const statusMatch = decoder
      .decode(responseBuffer.slice(0, headerEndIndex))
      .split('\r\n')[0]!
      .match(/HTTP\/\d\.\d\s+(\d+)/);
    const statusCode = statusMatch ? parseInt(statusMatch[1]!, 10) : NaN;
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
      throw new Error(`Connection failed: HTTP ${statusCode}`);
    }

    reader.releaseLock();

    if (initialData && initialData.byteLength > 0) {
      const remoteWriter = socket.writable.getWriter();
      await remoteWriter.write(initialData);
      remoteWriter.releaseLock();
    }

    if (bytesRead > headerEndIndex) {
      const { readable, writable } = new TransformStream();
      const transformWriter = writable.getWriter();
      void transformWriter
        .write(responseBuffer.subarray(headerEndIndex, bytesRead))
        .finally(() => transformWriter.releaseLock())
        .then(() => socket.readable.pipeTo(writable))
        .catch(() => undefined);
      return {
        readable,
        writable: socket.writable,
        closed: socket.closed,
        close: () => socket.close(),
      } as Socket;
    }

    return socket;
  } catch (error) {
    try {
      writer.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      void socket.close();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export async function httpsConnect(
  targetHost: string,
  targetPort: number,
  initialData: Uint8Array | null,
  proxyAddr: ProxyAddress,
  connector: SocketConnector,
): Promise<Socket> {
  try {
    return await httpConnect(targetHost, targetPort, initialData, proxyAddr, connector, true);
  } catch (error) {
    if (!/secureTransport.+(?:unsupported|not implemented)/i.test(String(error))) throw error;
    // 非 Cloudflare 测试适配器可显式声明不支持 secureTransport，再回退到旧 TLS 客户端。
  }
  const { username, password, hostname, port } = proxyAddr;
  const tlsServerName = isIPHostname(hostname) ? '' : stripIPv6Brackets(hostname);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const openTls = async (allowChacha = false) => {
    const proxySocket = connector.connect({ hostname, port });
    try {
      await proxySocket.opened;
      const tlsClient = new TlsClient(proxySocket, {
        serverName: tlsServerName,
        insecure: true,
        allowChacha,
      });
      await tlsClient.handshake();
      return tlsClient;
    } catch (error) {
      try {
        void proxySocket.close();
      } catch {
        /* ignore */
      }
      throw error;
    }
  };

  let tlsSocket: TlsClient | null = null;
  try {
    try {
      tlsSocket = await openTls(false);
    } catch (error) {
      if (
        !/cipher|handshake|TLS Alert|ServerHello|Finished|Unsupported|Missing TLS/i.test(
          (error as Error)?.message || `${error || ''}`,
        )
      )
        throw error;
      tlsSocket = await openTls(true);
    }

    const auth =
      username && password
        ? `Proxy-Authorization: Basic ${btoa(`${username}:${password}`)}\r\n`
        : '';
    const request = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}User-Agent: Mozilla/5.0\r\nConnection: keep-alive\r\n\r\n`;
    await tlsSocket.write(encoder.encode(request));

    let responseBuffer = new Uint8Array(0);
    let headerEndIndex = -1;
    let bytesRead = 0;
    while (headerEndIndex === -1 && bytesRead < 8192) {
      const value = await tlsSocket.read();
      if (!value) throw new Error('HTTPS proxy closed before CONNECT response');
      responseBuffer = new Uint8Array([...responseBuffer, ...value]);
      bytesRead = responseBuffer.length;
      const crlfcrlf = responseBuffer.findIndex(
        (_, i) =>
          i < responseBuffer.length - 3 &&
          responseBuffer[i] === 0x0d &&
          responseBuffer[i + 1] === 0x0a &&
          responseBuffer[i + 2] === 0x0d &&
          responseBuffer[i + 3] === 0x0a,
      );
      if (crlfcrlf !== -1) headerEndIndex = crlfcrlf + 4;
    }

    if (headerEndIndex === -1)
      throw new Error('HTTPS proxy CONNECT response header too long or invalid');
    const statusMatch = decoder
      .decode(responseBuffer.slice(0, headerEndIndex))
      .split('\r\n')[0]!
      .match(/HTTP\/\d\.\d\s+(\d+)/);
    const statusCode = statusMatch ? parseInt(statusMatch[1]!, 10) : NaN;
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
      throw new Error(`Connection failed: HTTP ${statusCode}`);
    }

    if (initialData && initialData.byteLength > 0) {
      await tlsSocket.write(initialData);
    }

    const bufferedData =
      bytesRead > headerEndIndex ? responseBuffer.subarray(headerEndIndex, bytesRead) : null;
    let closedSettled = false;
    let resolveClosed: () => void;
    let rejectClosed: (err: unknown) => void;
    const settleClosed = (settle: (value: unknown) => void, value?: unknown) => {
      if (!closedSettled) {
        closedSettled = true;
        settle(value);
      }
    };
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    const close = () => {
      try {
        void tlsSocket?.close();
      } catch {
        /* ignore */
      }
      settleClosed(resolveClosed!);
    };

    const readable = new ReadableStream({
      async start(controller) {
        try {
          if (bufferedData && bufferedData.byteLength > 0) controller.enqueue(bufferedData);
          while (true) {
            const data = await tlsSocket!.read();
            if (!data) break;
            if (data.byteLength > 0) controller.enqueue(data);
          }
          try {
            controller.close();
          } catch {
            /* ignore */
          }
          settleClosed(resolveClosed!);
        } catch (error) {
          try {
            controller.error(error);
          } catch {
            /* ignore */
          }
          settleClosed(rejectClosed!, error);
        }
      },
      cancel() {
        close();
      },
    });

    const writable = new WritableStream({
      async write(chunk) {
        await tlsSocket!.write(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      },
      close,
      abort(error) {
        close();
        if (error) settleClosed(rejectClosed!, error);
      },
    });

    return { readable, writable, closed, close } as unknown as Socket;
  } catch (error) {
    try {
      void tlsSocket?.close();
    } catch {
      /* ignore */
    }
    throw error;
  }
}
