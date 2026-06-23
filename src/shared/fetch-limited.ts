export interface FetchLimit {
  timeoutMs: number;
  maxBytes: number;
}

export interface FetchTextResult {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  headers: Headers;
}

export async function fetchTextLimited(
  input: RequestInfo,
  init: RequestInit | undefined,
  limit: FetchLimit,
): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), limit.timeoutMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > limit.maxBytes) {
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        text: '',
        headers: response.headers,
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        text,
        headers: response.headers,
      };
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let cancelled = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          const remaining = limit.maxBytes - totalBytes;
          if (remaining <= 0) {
            cancelled = true;
            reader.cancel();
            break;
          }

          const chunk = value.length > remaining ? value.slice(0, remaining) : value;
          chunks.push(chunk);
          totalBytes += chunk.length;

          if (totalBytes >= limit.maxBytes) {
            cancelled = true;
            reader.cancel();
            break;
          }
        }
      }
    } catch (error) {
      if (!cancelled) throw error;
    }

    const decoder = new TextDecoder();
    const text = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('');

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text,
      headers: response.headers,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}
