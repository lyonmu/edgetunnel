import { createUploadQueue } from '../networking/upload-queue';
import { closeSocketQuietly } from '../networking/stream-pump';
import { decodeEarlyData } from './common';
import {
  createResponseBridge,
  createRemoteConnWrapper,
  parseFirstPacket,
  type TransportBridge,
  type RemoteConnWrapper,
} from './bridge';
import type { RequestContext } from '../app/types';

export function handleXHTTP(
  request: Request,
  ctx: RequestContext,
  connectTCP: (host: string, port: number, data: Uint8Array | null, bridge: TransportBridge, wrapper: RemoteConnWrapper) => Promise<void>,
): Response {
  if (!request.body) return new Response('Bad Request', { status: 400 });

  const reader = request.body.getReader();
  const wrapper = createRemoteConnWrapper();
  const responseHeaders = new Headers({
    'Content-Type': 'application/octet-stream',
    'X-Accel-Buffering': 'no',
    'Cache-Control': 'no-store',
  });

  let uploadQueueRef: ReturnType<typeof createUploadQueue> | null = null;

  return new Response(
    new ReadableStream({
      async start(controller) {
        const bridge = createResponseBridge(controller);

        const getRemoteWriter = () => {
          const socket = wrapper.socket;
          if (!socket) return null;
          return (socket as any).writable.getWriter();
        };

        const uploadQueue = (uploadQueueRef = createUploadQueue({
          getWriter: getRemoteWriter,
          releaseWriter: () => {},
          retryConnect: async () => {
            if (typeof wrapper.retryConnect !== 'function') throw new Error('retry unavailable');
            await wrapper.retryConnect();
          },
          closeConnection: () => {
            try { wrapper.socket?.close(); } catch { /* ignore */ }
            closeSocketQuietly(bridge as any);
          },
          name: 'XHTTP上行',
        }));

        const writeToRemote = async (payload: Uint8Array, allowRetry = true) => {
          return uploadQueue.enqueueAndWait(payload, allowRetry);
        };

        try {
          const { value: firstChunk, done: firstDone } = await reader.read();
          if (firstDone || !firstChunk) {
            controller.close();
            return;
          }

          const firstData = firstChunk instanceof Uint8Array ? firstChunk : new Uint8Array(firstChunk);
          const firstPacket = parseFirstPacket(firstData, ctx.userId);
          if (!firstPacket) {
            controller.close();
            return;
          }

          await connectTCP(firstPacket.hostname, firstPacket.port, firstPacket.rawData, bridge, wrapper);

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || (value as any).byteLength === 0) continue;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as any);
            if (!(await writeToRemote(chunk))) throw new Error('Remote socket is not ready');
          }

          await uploadQueue.waitIdle();
          const writer = getRemoteWriter();
          if (writer) {
            try { await writer.close(); } catch { /* ignore */ }
          }
        } catch (err) {
          closeSocketQuietly(bridge as any);
        } finally {
          uploadQueue.clear();
          try { reader.releaseLock(); } catch { /* ignore */ }
        }
      },
      cancel() {
        uploadQueueRef?.clear();
        try { wrapper.socket?.close(); } catch { /* ignore */ }
        try { reader.releaseLock(); } catch { /* ignore */ }
      },
    }),
    { status: 200, headers: responseHeaders },
  );
}
