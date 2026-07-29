import { createUploadQueue } from '../networking/upload-queue';
import { closeSocketQuietly } from '../networking/stream-pump';
import {
  createResponseBridge,
  createFirstPacketReader,
  createRemoteConnWrapper,
  createRemoteWriterProvider,
  type TransportBridge,
  type RemoteConnWrapper,
} from './bridge';
import type { RequestContext } from '../app/types';
import {
  createDnsUdpSession,
  isVlessPacketAddrTarget,
  type DnsUdpProtocol,
} from '../networking/udp-dns';

export function handleXHTTP(
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
  if (!request.body) return new Response('Bad Request', { status: 400 });

  const reader = request.body.getReader();
  const wrapper = createRemoteConnWrapper();
  const writerProvider = createRemoteWriterProvider(wrapper);
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

        const uploadQueue = (uploadQueueRef = createUploadQueue({
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
            closeSocketQuietly(bridge);
          },
          name: 'XHTTP上行',
        }));

        const writeToRemote = async (payload: Uint8Array, allowRetry = true) => {
          return uploadQueue.enqueueAndWait(payload, allowRetry);
        };

        try {
          const firstPacketReader = createFirstPacketReader(ctx.userId);
          let firstPacket = null;
          while (!firstPacket) {
            const { value, done } = await reader.read();
            if (done || !value) {
              controller.close();
              return;
            }
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            const result = firstPacketReader.push(chunk);
            if (result.status === 'invalid') {
              controller.close();
              return;
            }
            if (result.status === 'ok') firstPacket = result.packet;
          }

          let dnsSession: ReturnType<typeof createDnsUdpSession> | null = null;
          if (firstPacket.isUDP) {
            let dnsProtocol: DnsUdpProtocol = firstPacket.protocol;
            if (firstPacket.protocol === 'vless' && firstPacket.port !== 53) {
              if (!isVlessPacketAddrTarget(firstPacket.hostname, firstPacket.port)) {
                throw new Error('UDP is not supported');
              }
              dnsProtocol = 'vless-packetaddr';
            }
            dnsSession = createDnsSession(dnsProtocol, bridge, firstPacket.respHeader);
            if (firstPacket.rawData.byteLength) await dnsSession.push(firstPacket.rawData);
          } else {
            if (firstPacket.respHeader) bridge.send(firstPacket.respHeader);
            await connectTCP(
              firstPacket.hostname,
              firstPacket.port,
              firstPacket.rawData,
              bridge,
              wrapper,
            );
          }

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            if (dnsSession) await dnsSession.push(chunk);
            else if (!(await writeToRemote(chunk))) throw new Error('Remote socket is not ready');
          }

          if (!dnsSession) {
            await uploadQueue.waitIdle();
            const writer = writerProvider.getWriter();
            if (writer) {
              try {
                await writer.close();
              } catch {
                /* ignore */
              }
            }
          } else {
            bridge.close();
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'xhttp_transport_error',
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          closeSocketQuietly(bridge);
        } finally {
          uploadQueue.clear();
          writerProvider.releaseWriter();
          try {
            reader.releaseLock();
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
    { status: 200, headers: responseHeaders },
  );
}
