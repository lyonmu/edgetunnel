import { fetchTextLimited, type FetchLimit } from '../shared/fetch-limited';

export interface UpstreamResult {
  ok: boolean;
  text: string;
  status: number;
  statusText: string;
}

export async function fetchUpstreamSubscription(
  url: string,
  limit: FetchLimit = { timeoutMs: 10000, maxBytes: 1024 * 1024 },
): Promise<UpstreamResult> {
  try {
    const result = await fetchTextLimited(url, undefined, limit);

    return {
      ok: result.ok,
      text: result.text,
      status: result.status,
      statusText: result.statusText,
    };
  } catch (error) {
    return {
      ok: false,
      text: '',
      status: 0,
      statusText: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function fetchOptimizedIPs(
  apiUrl: string,
  timeoutMs: number = 3000,
): Promise<string[]> {
  try {
    const result = await fetchTextLimited(apiUrl, undefined, {
      timeoutMs,
      maxBytes: 1024 * 1024,
    });

    if (!result.ok) {
      return [];
    }

    return parseIPList(result.text);
  } catch {
    return [];
  }
}

function parseIPList(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}
