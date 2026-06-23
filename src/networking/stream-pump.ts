const GRAIN_PACKET_BYTES = 32 * 1024;
const GRAIN_TAIL_THRESHOLD = 512;
const GRAIN_SILENT_MS = 0;
const BYOB_READ_LIMIT = 64 * 1024;

export function closeSocketQuietly(ws: WebSocket | null | undefined) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.close(); } catch { /* ignore */ }
  }
}

export interface DownlinkSender {
  sendDirect(data: Uint8Array): Promise<void>;
  send(data: Uint8Array): Promise<void>;
  flush(): Promise<void>;
}

function wsSendAndAwait(ws: WebSocket, data: Uint8Array | ArrayBuffer): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) throw new Error('ws.readyState is not open');
  return new Promise<void>((resolve, reject) => {
    try {
      ws.send(data);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

export function createDownloadGrainSender(ws: WebSocket, headerData: Uint8Array | null = null): DownlinkSender {
  let header = headerData;
  let pendingBuffer = new Uint8Array(GRAIN_PACKET_BYTES);
  let pendingBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let microtaskQueued = false;
  let generation = 0;
  let scheduledGeneration = 0;
  let waitRounds = 0;
  let flushPromise: Promise<void> | null = null;

  const sendRaw = async (chunk: Uint8Array) => {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('ws.readyState is not open');
    await wsSendAndAwait(ws, chunk);
  };

  const attachHeader = (chunk: Uint8Array): Uint8Array => {
    if (!header) return chunk;
    const merged = new Uint8Array(header.length + chunk.byteLength);
    merged.set(header, 0);
    merged.set(chunk, header.length);
    header = null;
    return merged;
  };

  const flush = async (): Promise<void> => {
    while (flushPromise) await flushPromise;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    microtaskQueued = false;
    if (!pendingBytes) return;
    const output = pendingBuffer.subarray(0, pendingBytes).slice();
    pendingBuffer = new Uint8Array(GRAIN_PACKET_BYTES);
    pendingBytes = 0;
    waitRounds = 0;
    flushPromise = sendRaw(output).finally(() => { flushPromise = null; });
    return flushPromise;
  };

  const scheduleFlush = () => {
    if (flushTimer || microtaskQueued) return;
    microtaskQueued = true;
    scheduledGeneration = generation;
    queueMicrotask(() => {
      microtaskQueued = false;
      if (!pendingBytes || flushTimer) return;
      if (GRAIN_PACKET_BYTES - pendingBytes < GRAIN_TAIL_THRESHOLD) {
        flush().catch(() => closeSocketQuietly(ws));
        return;
      }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (!pendingBytes) return;
        if (GRAIN_PACKET_BYTES - pendingBytes < GRAIN_TAIL_THRESHOLD) {
          flush().catch(() => closeSocketQuietly(ws));
          return;
        }
        if (waitRounds < 2 && (generation !== scheduledGeneration || pendingBytes < Math.max(4096, GRAIN_TAIL_THRESHOLD << 3))) {
          waitRounds++;
          scheduledGeneration = generation;
          scheduleFlush();
          return;
        }
        flush().catch(() => closeSocketQuietly(ws));
      }, Math.max(GRAIN_SILENT_MS, 1));
    });
  };

  return {
    async sendDirect(data) {
      let chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (!chunk.byteLength) return;
      chunk = attachHeader(chunk);
      await sendRaw(chunk);
    },
    async send(data) {
      let chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (!chunk.byteLength) return;
      chunk = attachHeader(chunk);
      let offset = 0;
      const totalBytes = chunk.byteLength;
      while (offset < totalBytes) {
        if (!pendingBytes && totalBytes - offset >= GRAIN_PACKET_BYTES) {
          const sendBytes = Math.min(GRAIN_PACKET_BYTES, totalBytes - offset);
          const view = offset || sendBytes !== totalBytes ? chunk.subarray(offset, offset + sendBytes) : chunk;
          await sendRaw(view);
          offset += sendBytes;
          continue;
        }
        const copyBytes = Math.min(GRAIN_PACKET_BYTES - pendingBytes, totalBytes - offset);
        pendingBuffer.set(chunk.subarray(offset, offset + copyBytes), pendingBytes);
        pendingBytes += copyBytes;
        offset += copyBytes;
        generation++;
        if (pendingBytes === GRAIN_PACKET_BYTES || GRAIN_PACKET_BYTES - pendingBytes < GRAIN_TAIL_THRESHOLD) await flush();
        else scheduleFlush();
      }
    },
    flush,
  };
}

export async function connectStreams(
  remoteSocket: { readable: ReadableStream; writable?: WritableStream },
  webSocket: WebSocket,
  headerData: Uint8Array | null,
  retryFunc?: () => Promise<void>,
): Promise<void> {
  let header = headerData;
  let hasData = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
  let useBYOB = false;
  const downlinkSender = createDownloadGrainSender(webSocket, header);
  header = null;

  try {
    reader = remoteSocket.readable.getReader({ mode: 'byob' } as any);
    useBYOB = true;
  } catch {
    reader = remoteSocket.readable.getReader();
  }

  try {
    if (!useBYOB) {
      while (true) {
        const { done, value } = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        hasData = true;
        await downlinkSender.send(value);
      }
    } else {
      let readBuffer = new ArrayBuffer(BYOB_READ_LIMIT);
      while (true) {
        const { done, value } = await (reader as ReadableStreamBYOBReader).read(
          new Uint8Array(readBuffer, 0, BYOB_READ_LIMIT),
        );
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        hasData = true;
        if (value.byteLength >= GRAIN_PACKET_BYTES) {
          await downlinkSender.flush();
          await downlinkSender.sendDirect(value);
          readBuffer = new ArrayBuffer(BYOB_READ_LIMIT);
        } else {
          await downlinkSender.send(value);
          readBuffer = (value as any).buffer.byteLength >= BYOB_READ_LIMIT ? (value as any).buffer : new ArrayBuffer(BYOB_READ_LIMIT);
        }
      }
    }
    await downlinkSender.flush();
  } catch {
    closeSocketQuietly(webSocket);
  } finally {
    try { await (reader as any).cancel(); } catch { /* ignore */ }
    try { (reader as any).releaseLock(); } catch { /* ignore */ }
  }
  if (!hasData && retryFunc) await retryFunc();
}
