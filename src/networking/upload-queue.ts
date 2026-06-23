const BUNDLE_TARGET_BYTES = 16 * 1024;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_QUEUE_ITEMS = 4096;

interface QueueItem {
  chunk: Uint8Array;
  allowRetry: boolean;
  completions: Array<{ resolve: () => void; reject: (err: unknown) => void }> | null;
}

interface UploadQueueOptions {
  getWriter: () => WritableStreamDefaultWriter<Uint8Array> | null;
  releaseWriter?: () => void;
  retryConnect?: () => Promise<void>;
  closeConnection?: (err: unknown) => void;
  name?: string;
}

export function createUploadQueue(options: UploadQueueOptions) {
  const { getWriter, releaseWriter, retryConnect, closeConnection, name = 'upload' } = options;

  let chunks: (QueueItem | undefined)[] = [];
  let head = 0;
  let queuedBytes = 0;
  let draining = false;
  let closed = false;
  let bundleBuffer: Uint8Array | null = null;
  let idleResolvers: Array<() => void> = [];
  let activeCompletions: QueueItem['completions'] = null;

  const settleCompletions = (completions: QueueItem['completions'], err: unknown = null) => {
    if (!completions) return;
    for (const c of completions) {
      if (err) c.reject(err);
      else c.resolve();
    }
  };

  const rejectQueued = (err: unknown) => {
    for (let i = head; i < chunks.length; i++) {
      const item = chunks[i];
      if (item?.completions) settleCompletions(item.completions, err);
    }
  };

  const compact = () => {
    if (head > 32 && head * 2 >= chunks.length) {
      chunks = chunks.slice(head);
      head = 0;
    }
  };

  const resolveIdle = () => {
    if (queuedBytes || draining || !idleResolvers.length) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  };

  const clear = (err: unknown = null) => {
    const closeErr = err || (closed ? new Error(`${name}: queue closed`) : null);
    if (closeErr) {
      rejectQueued(closeErr);
      settleCompletions(activeCompletions, closeErr);
      activeCompletions = null;
    }
    chunks = [];
    head = 0;
    queuedBytes = 0;
    resolveIdle();
  };

  const shift = (): QueueItem | null => {
    if (head >= chunks.length) return null;
    const item = chunks[head]!;
    chunks[head++] = undefined;
    queuedBytes -= item.chunk.byteLength;
    compact();
    return item;
  };

  const bundle = (): QueueItem | null => {
    const first = shift();
    if (!first) return null;
    if (head >= chunks.length || first.chunk.byteLength >= BUNDLE_TARGET_BYTES) return first;

    let byteLength = first.chunk.byteLength;
    let end = head;
    let allowRetry = first.allowRetry;
    let completions = first.completions || null;

    while (end < chunks.length) {
      const next = chunks[end]!;
      const nextLength = byteLength + next.chunk.byteLength;
      if (nextLength > BUNDLE_TARGET_BYTES) break;
      byteLength = nextLength;
      allowRetry = allowRetry && next.allowRetry;
      if (next.completions)
        completions = completions ? completions.concat(next.completions) : next.completions;
      end++;
    }
    if (end === head) return first;

    const output = (bundleBuffer ||= new Uint8Array(BUNDLE_TARGET_BYTES));
    output.set(first.chunk);
    let offset = first.chunk.byteLength;
    while (head < end) {
      const next = chunks[head]!;
      chunks[head++] = undefined;
      queuedBytes -= next.chunk.byteLength;
      output.set(next.chunk, offset);
      offset += next.chunk.byteLength;
    }
    compact();
    return { chunk: output.subarray(0, byteLength), allowRetry, completions };
  };

  const drain = async () => {
    if (draining || closed) return;
    draining = true;
    try {
      for (;;) {
        if (closed) break;
        const item = bundle();
        if (!item) break;
        let writer = getWriter();
        if (!writer) throw new Error(`${name}: remote writer unavailable`);
        const completions = item.completions || null;
        activeCompletions = completions;
        try {
          try {
            await writer.write(item.chunk);
          } catch (err) {
            releaseWriter?.();
            if (!item.allowRetry || typeof retryConnect !== 'function') throw err;
            await retryConnect();
            writer = getWriter();
            if (!writer) throw err;
            await writer.write(item.chunk);
          }
          settleCompletions(completions);
        } catch (err) {
          settleCompletions(completions, err);
          throw err;
        } finally {
          if (activeCompletions === completions) activeCompletions = null;
        }
      }
    } catch (err) {
      closed = true;
      clear(err);
      try {
        closeConnection?.(err);
      } catch {
        /* ignore */
      }
    } finally {
      draining = false;
      if (!closed && head < chunks.length) queueMicrotask(drain);
      else resolveIdle();
    }
  };

  const enqueueBase = (
    data: Uint8Array | ArrayBuffer,
    allowRetry = true,
    waitForFlush = false,
  ): boolean | Promise<boolean> => {
    if (closed) return false;
    if (!getWriter()) return false;
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!chunk.byteLength) return true;
    const nextBytes = queuedBytes + chunk.byteLength;
    const nextItems = chunks.length - head + 1;
    if (nextBytes > MAX_QUEUE_BYTES || nextItems > MAX_QUEUE_ITEMS) {
      closed = true;
      const err = Object.assign(
        new Error(`${name}: upload queue overflow (${nextBytes}B/${nextItems})`),
        { isQueueOverflow: true },
      );
      clear(err);
      try {
        closeConnection?.(err);
      } catch {
        /* ignore */
      }
      throw err;
    }
    let completionPromise: Promise<boolean> | null = null;
    let completions: QueueItem['completions'] = null;
    if (waitForFlush) {
      completions = [];
      completionPromise = new Promise<boolean>((resolve, reject) =>
        completions!.push({ resolve: () => resolve(true), reject }),
      );
    }
    chunks.push({ chunk, allowRetry, completions });
    queuedBytes = nextBytes;
    if (!draining) queueMicrotask(drain);
    return waitForFlush ? completionPromise! : true;
  };

  return {
    enqueue(data: Uint8Array | ArrayBuffer, allowRetry = true): boolean {
      return enqueueBase(data, allowRetry, false) as boolean;
    },
    enqueueAndWait(data: Uint8Array | ArrayBuffer, allowRetry = true): Promise<boolean> {
      return enqueueBase(data, allowRetry, true) as Promise<boolean>;
    },
    async waitIdle() {
      if (!queuedBytes && !draining) return;
      await new Promise<void>((resolve) => idleResolvers.push(resolve));
    },
    clear() {
      closed = true;
      clear();
    },
  };
}
