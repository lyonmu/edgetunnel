import { createUploadQueue } from '../networking/upload-queue';
import { buildGrpcFrame, parseGrpcFrames, parseGrpcPayload } from './common';
import {
  createRemoteConnWrapper,
  parseFirstPacket,
  type TransportBridge,
  type RemoteConnWrapper,
} from './bridge';
import type { RequestContext } from '../app/types';

export function handleGRPC(
  request: Request,
  ctx: RequestContext,
  connectTCP: (
    host: string,
    port: number,
    data: Uint8Array | null,
    bridge: TransportBridge,
    wrapper: RemoteConnWrapper,
  ) => Promise<void>,
): Response {
  if (!request.body) return new Response('Bad Request', { status: 400 });

  const reader = request.body.getReader();
  const wrapper = createRemoteConnWrapper();
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

        const getRemoteWriter = () => {
          const socket = wrapper.socket;
          if (!socket) return null;
          return socket.writable.getWriter();
        };

        uploadQueue = uploadQueueRef = createUploadQueue({
          getWriter: getRemoteWriter,
          releaseWriter: () => {},
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

              if (isFirstFrame) {
                isFirstFrame = false;
                const firstPacket = parseFirstPacket(payload, ctx.userId);
                if (!firstPacket) throw new Error('Invalid first packet');

                if (
                  firstPacket.isUDP &&
                  firstPacket.protocol !== 'trojan' &&
                  firstPacket.port !== 53
                ) {
                  throw new Error('UDP is not supported');
                }

                if (firstPacket.respHeader) {
                  grpcBridge.send(firstPacket.respHeader);
                }

                await connectTCP(
                  firstPacket.hostname,
                  firstPacket.port,
                  firstPacket.rawData,
                  grpcBridge,
                  wrapper,
                );
                if (firstPacket.rawData.byteLength > 0) continue;
              } else {
                if (!(await writeToRemote(payload))) throw new Error('Remote socket is not ready');
              }
            }
            grpcBridge.flushPending();
          }

          await uploadQueue.waitIdle();
        } catch {
          // error during gRPC processing
        } finally {
          uploadQueue?.clear();
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

function createGrpcBridge(controller: ReadableStreamDefaultController): GrpcBridge {
  let closed = false;
  const sendQueue: Uint8Array[] = [];
  let queuedBytes = 0;

  const flush = () => {
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
      if (queuedBytes >= 32 * 1024) flush();
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
