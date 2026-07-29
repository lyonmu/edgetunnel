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
  queryDnsDoh,
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
  let grpcBridgeRef: GrpcBridge | null = null;

  return new Response(
    new ReadableStream({
      async start(controller) {
        const grpcBridge = (grpcBridgeRef = createGrpcBridge(controller));
        let uploadQueue: ReturnType<typeof createUploadQueue> | null = null;
        let failed = false;
        let dnsSession: ReturnType<typeof createDnsUdpSession> | null = null;

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
                  const dnsConfig = ctx.runtimeSnapshot.config.dns;
                  if (!dnsConfig.enabled) throw new Error('DNS is not enabled');
                  dnsSession =
                    createDnsSession === createDnsUdpSession
                      ? createDnsUdpSession(
                          dnsProtocol,
                          grpcBridge,
                          firstPacket.respHeader,
                          (payload) =>
                            queryDnsDoh(payload, fetch, {
                              endpoint: dnsConfig.dohUrl,
                              timeoutMs: dnsConfig.timeoutMs,
                              maxMessageBytes: dnsConfig.maxMessageBytes,
                            }),
                          { maxMessageBytes: dnsConfig.maxMessageBytes },
                        )
                      : createDnsSession(dnsProtocol, grpcBridge, firstPacket.respHeader);
                  if (firstPacket.rawData.byteLength) {
                    await dnsSession.push(firstPacket.rawData);
                  }
                  continue;
                }

                if (firstPacket.respHeader) await grpcBridge.send(firstPacket.respHeader);
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
          if (dnsSession) {
            grpcBridge.close();
          } else if (wrapper.socket) {
            const writer = writerProvider.getWriter();
            if (writer) {
              try {
                await writer.close();
              } finally {
                writerProvider.releaseWriter();
              }
            }
            await grpcBridge.closed;
          } else {
            grpcBridge.close();
          }
        } catch (error) {
          failed = true;
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
          if (failed) {
            grpcBridge.close();
            try {
              void wrapper.socket?.close();
            } catch {
              /* ignore */
            }
          }
        }
      },
      pull() {
        grpcBridgeRef?.notifyPull();
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
  notifyPull(): void;
  readonly closed: Promise<void>;
}

export function createGrpcBridge(controller: ReadableStreamDefaultController): GrpcBridge {
  const maxQueuedBytes = 1024 * 1024;
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const sendQueue: Array<{
    frame: Uint8Array;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  let queuedBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queuedBytes || (controller.desiredSize ?? 1) <= 0) return;
    const out = new Uint8Array(queuedBytes);
    let offset = 0;
    for (const item of sendQueue) {
      out.set(item.frame, offset);
      offset += item.frame.byteLength;
    }
    const flushed = sendQueue.splice(0);
    queuedBytes = 0;
    try {
      controller.enqueue(out);
      for (const item of flushed) item.resolve();
    } catch (error) {
      closed = true;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const item of flushed) item.reject(failure);
      resolveClosed();
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
      if (queuedBytes + frame.byteLength > maxQueuedBytes) {
        const error = new Error('gRPC response queue limit exceeded');
        this.close();
        return Promise.reject(error);
      }
      queuedBytes += frame.byteLength;
      const pending = new Promise<void>((resolve, reject) => {
        sendQueue.push({ frame, resolve, reject });
      });
      if (queuedBytes >= 32 * 1024) flush();
      else if (flushTimer === null) flushTimer = setTimeout(flush, 1);
      return pending;
    },
    flushPending() {
      flush();
    },
    notifyPull() {
      flush();
    },
    get closed() {
      return closedPromise;
    },
    close() {
      if (closed) return;
      flush();
      closed = true;
      const error = new Error('gRPC bridge closed');
      for (const item of sendQueue.splice(0)) item.reject(error);
      queuedBytes = 0;
      try {
        controller.close();
      } catch {
        /* ignore */
      }
      resolveClosed();
    },
  };
}
