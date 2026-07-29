import { createUploadQueue } from '../networking/upload-queue';
import { closeSocketQuietly } from '../networking/stream-pump';
import { decodeEarlyData } from './common';
import {
  createWebSocketBridge,
  createFirstPacketReader,
  createRemoteConnWrapper,
  createRemoteWriterProvider,
  type TransportBridge,
  type RemoteConnWrapper,
} from './bridge';
import type { RequestContext } from '../app/types';
import {
  createShadowsocksDecryptor,
  createShadowsocksEncryptor,
  createShadowsocksAddressReader,
} from '../protocols/shadowsocks';
import { toUint8Array } from '../shared/bytes';
import {
  createDnsUdpSession,
  isVlessPacketAddrTarget,
  type DnsUdpProtocol,
} from '../networking/udp-dns';

interface HalfOpenWebSocket extends WebSocket {
  accept(options?: { allowHalfOpen?: boolean }): void;
}

export function handleWebSocket(
  request: Request,
  ctx: RequestContext,
  connectTCP: (
    host: string,
    port: number,
    data: Uint8Array | null,
    bridge: TransportBridge,
    wrapper: RemoteConnWrapper,
  ) => Promise<void>,
  createDnsSession: typeof createDnsUdpSession = createDnsUdpSession,
): Response {
  const pair = new WebSocketPair();
  const [clientSock, serverSock] = Object.values(pair) as [WebSocket, WebSocket];

  try {
    (serverSock as HalfOpenWebSocket).accept({ allowHalfOpen: true });
  } catch {
    serverSock.accept();
  }
  serverSock.binaryType = 'arraybuffer';

  const wrapper = createRemoteConnWrapper();
  const writerProvider = createRemoteWriterProvider(wrapper);
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const shadowsocksMethod = ctx.url.searchParams.get('enc')?.toLowerCase() || null;
  let uploadQueue: ReturnType<typeof createUploadQueue> | null = null;

  uploadQueue = createUploadQueue({
    getWriter: writerProvider.getWriter,
    releaseWriter: writerProvider.releaseWriter,
    retryConnect: async () => {
      if (typeof wrapper.retryConnect !== 'function') throw new Error('retry unavailable');
      await wrapper.retryConnect();
    },
    closeConnection: () => {
      try {
        void wrapper.socket?.close();
      } catch {
        /* ignore */
      }
      writerProvider.releaseWriter();
      closeSocketQuietly(serverSock);
    },
    name: 'WS上行',
  });

  const bridge = shadowsocksMethod
    ? createShadowsocksBridge(serverSock, ctx.userId, shadowsocksMethod)
    : createWebSocketBridge(serverSock);
  const firstPacketReader = createFirstPacketReader(ctx.userId);
  const shadowsocksDecryptor = shadowsocksMethod
    ? createShadowsocksDecryptor(ctx.userId, shadowsocksMethod)
    : null;
  const shadowsocksAddressReader = shadowsocksMethod ? createShadowsocksAddressReader() : null;
  let shadowsocksConnected = false;
  let firstPacketHandled = false;
  let dnsSession: ReturnType<typeof createDnsUdpSession> | null = null;
  let processing = Promise.resolve();

  const processData = async (data: Uint8Array) => {
    if (shadowsocksDecryptor) {
      const plaintextChunks = await shadowsocksDecryptor.push(data);
      for (const plaintext of plaintextChunks) {
        if (!shadowsocksConnected) {
          const result = shadowsocksAddressReader!.push(plaintext);
          if (result.status === 'need_more') continue;
          if (result.status === 'invalid') throw new Error('Invalid Shadowsocks address');
          const target = result.target;
          await connectTCP(target.hostname, target.port, target.payload, bridge, wrapper);
          shadowsocksConnected = true;
        } else if (!uploadQueue!.enqueue(plaintext)) {
          throw new Error('Remote socket is not ready');
        }
      }
      return;
    }

    if (dnsSession) {
      await dnsSession.push(data);
      return;
    }

    if (!firstPacketHandled) {
      const result = firstPacketReader.push(data);
      if (result.status === 'need_more') return;
      if (result.status === 'invalid') throw new Error('Invalid first packet');
      const firstPacket = result.packet;
      firstPacketHandled = true;
      if (firstPacket.isUDP) {
        let dnsProtocol: DnsUdpProtocol = firstPacket.protocol;
        if (firstPacket.protocol === 'vless' && firstPacket.udpMode === 'xudp') {
          dnsProtocol = 'vless-xudp';
        } else if (firstPacket.protocol === 'vless' && firstPacket.port !== 53) {
          if (!isVlessPacketAddrTarget(firstPacket.hostname, firstPacket.port)) {
            throw new Error('UDP is not supported');
          }
          dnsProtocol = 'vless-packetaddr';
        }
        dnsSession = createDnsSession(dnsProtocol, bridge, firstPacket.respHeader);
        if (firstPacket.rawData.byteLength) await dnsSession.push(firstPacket.rawData);
        return;
      }
      if (firstPacket.respHeader) bridge.send(firstPacket.respHeader);
      await connectTCP(
        firstPacket.hostname,
        firstPacket.port,
        firstPacket.rawData,
        bridge,
        wrapper,
      );
      return;
    }

    if (!uploadQueue!.enqueue(data)) {
      throw new Error('Remote socket is not ready');
    }
  };

  const handleTransportError = (error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'websocket_transport_error',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    closeSocketQuietly(serverSock);
  };

  const earlyBytes = shadowsocksMethod ? null : decodeEarlyData(earlyDataHeader, ctx.userId);
  if (earlyBytes?.byteLength) {
    processing = processing.then(() => processData(earlyBytes)).catch(handleTransportError);
  }

  serverSock.addEventListener('message', (event) => {
    try {
      const data = toUint8Array(event.data as ArrayBuffer | ArrayBufferView);
      if (!data.byteLength) return;
      processing = processing.then(() => processData(data)).catch(handleTransportError);
    } catch (error) {
      handleTransportError(error);
    }
  });

  serverSock.addEventListener('close', () => {
    uploadQueue?.clear();
    writerProvider.releaseWriter();
    try {
      void wrapper.socket?.close();
    } catch {
      /* ignore */
    }
  });

  serverSock.addEventListener('error', () => {
    uploadQueue?.clear();
    writerProvider.releaseWriter();
    try {
      void wrapper.socket?.close();
    } catch {
      /* ignore */
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: clientSock,
  });
}

function createShadowsocksBridge(
  webSocket: WebSocket,
  password: string,
  method: string,
): TransportBridge {
  const encryptor = createShadowsocksEncryptor(password, method);
  let sendChain = Promise.resolve();

  return {
    get readyState() {
      return webSocket.readyState;
    },
    send(data) {
      const plaintext = toUint8Array(data);
      sendChain = sendChain
        .then(async () => {
          const encrypted = await (await encryptor).encrypt(plaintext);
          if (encrypted.byteLength && webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(encrypted);
          }
        })
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              event: 'shadowsocks_encrypt_error',
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          closeSocketQuietly(webSocket);
        });
    },
    close() {
      closeSocketQuietly(webSocket);
    },
  };
}
