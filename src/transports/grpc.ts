import { createUploadQueue } from '../networking/upload-queue';
import { buildGrpcFrame, parseGrpcFrames, parseGrpcPayload } from './common';
import {
  createFirstPacketReader,
  createRemoteConnWrapper,
  createRemoteWriterProvider,
  type TransportBridge,
} from './bridge';
import type { ConnectTCPFn } from './session';
import type { DataPlaneContext } from '../app/types';
import {
  createDnsUdpSession,
  isVlessPacketAddrTarget,
  type DnsUdpProtocol,
} from '../networking/udp-dns';

export function handleGRPC(
  request: Request,
  ctx: DataPlaneContext,
  connectTCP: ConnectTCPFn,
  createDnsSession: typeof createDnsUdpSession = createDnsUdpSession,
): Response {
  if (!request.body) return new Response('Bad Request', { status: 400 });

  const reader = request.body.getReader();
  const wrapper = createRemoteConnWrapper();
  const writerProvider = createRemoteWriterProvider(wrapper);
  const grpcHeaders = new Headers({
    'Content-Type': 'application/grpc',
    'grpc-status': '0',
    'X-Accel-Buffering': 'no',
    'Cache-Control': 'no-store',
  });

  let uploadQueueRef: ReturnType<typeof createUploadQueue> | null = null;

  return new Response(
    new ReadableStream({
      async start(controller) {
        const grpcBridge = createGrpcBridge(controller);
        let uploadQueue: ReturnType<typeof createUploadQueue> | null = null;

        uploadQueue = uploadQueueRef = createUploadQueue({
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
            grpcBridge.close();
          },
          name: 'gRPC上行',
        });

        const writeToRemote = async (payload: Uint8Array, allowRetry = true) => {
          return uploadQueue.enqueueAndWait(payload, allowRetry);
        };

        try {
          let pending = new Uint8Array(0);
          let isFirstFrame = true;
          const firstPacketReader = createFirstPacketReader(
            ctx.userId,
            ctx.runtimeSnapshot.secrets.trojanPassword,
          );
          let dnsSession: ReturnType<typeof createDnsUdpSession> | null = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            const merged = new Uint8Array(pending.length + chunk.length);
            merged.set(pending, 0);
            merged.set(chunk, pending.length);
            pending = merged;

            const { frames, remainder } = parseGrpcFrames(pending);
            pending = remainder as unknown as Uint8Array<ArrayBuffer>;

            for (const grpcPayload of frames) {
              if (!grpcPayload.byteLength) continue;
              const payload = parseGrpcPayload(grpcPayload);
              if (!payload.byteLength) continue;

              if (dnsSession) {
                await dnsSession.push(payload);
                continue;
              }

              if (isFirstFrame) {
                const result = firstPacketReader.push(payload);
                if (result.status === 'need_more') continue;
                if (result.status === 'invalid') throw new Error('Invalid first packet');
                isFirstFrame = false;
                const firstPacket = result.packet;
                if (!ctx.runtimeSnapshot.config.inbound[firstPacket.protocol].enabled) {
                  throw new Error(`${firstPacket.protocol} is not enabled`);
                }

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
                  dnsSession = createDnsSession(dnsProtocol, grpcBridge, firstPacket.respHeader);
                  if (firstPacket.rawData.byteLength) {
                    await dnsSession.push(firstPacket.rawData);
                  }
                  continue;
                }

                if (firstPacket.respHeader) grpcBridge.send(firstPacket.respHeader);
                await connectTCP(
                  firstPacket.hostname,
                  firstPacket.port,
                  firstPacket.rawData,
                  grpcBridge,
                  wrapper,
                  firstPacket.protocol,
                );
                if (firstPacket.rawData.byteLength > 0) continue;
              } else {
                if (!(await writeToRemote(payload))) throw new Error('Remote socket is not ready');
              }
            }
            grpcBridge.flushPending();
          }

          await uploadQueue.waitIdle();
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'grpc_transport_error',
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        } finally {
          uploadQueue?.clear();
          writerProvider.releaseWriter();
          try {
            reader.releaseLock();
          } catch {
            /* ignore */
          }
          grpcBridge.close();
          try {
            void wrapper.socket?.close();
          } catch {
            /* ignore */
          }
        }
      },
      cancel() {
        uploadQueueRef?.clear();
        writerProvider.releaseWriter();
        try {
          void wrapper.socket?.close();
        } catch {
          /* ignore */
        }
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      },
    }),
    { status: 200, headers: grpcHeaders },
  );
}

interface GrpcBridge extends TransportBridge {
  flushPending(): void;
}

export function createGrpcBridge(controller: ReadableStreamDefaultController): GrpcBridge {
  let closed = false;
  const sendQueue: Uint8Array[] = [];
  let queuedBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queuedBytes) return;
    const out = new Uint8Array(queuedBytes);
    let offset = 0;
    for (const item of sendQueue) {
      out.set(item, offset);
      offset += item.byteLength;
    }
    sendQueue.length = 0;
    queuedBytes = 0;
    try {
      controller.enqueue(out);
    } catch {
      closed = true;
    }
  };

  return {
    get readyState() {
      return closed ? WebSocket.CLOSED : WebSocket.OPEN;
    },
    send(data) {
      if (closed) return;
      const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
      const frame = buildGrpcFrame(chunk);
      sendQueue.push(frame);
      queuedBytes += frame.byteLength;
      if (queuedBytes >= 32 * 1024) {
        flush();
      } else if (flushTimer === null) {
        flushTimer = setTimeout(flush, 1);
      }
    },
    flushPending() {
      flush();
    },
    close() {
      if (closed) return;
      flush();
      closed = true;
      try {
        controller.close();
      } catch {
        /* ignore */
      }
    },
  };
}
