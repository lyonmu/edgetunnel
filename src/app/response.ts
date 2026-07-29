import type { RequestContext } from './types';
import { DEFAULT_ENCRYPTION_KEY } from './request-context';
import { createLegacyAuthToken, readLegacyAuthCookie } from '../auth/legacy-session';
import { md5Twice } from '../shared/hash';

const WORKER_VERSION = 20260617014121;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function jsonData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function jsonError(
  code: string,
  message: string,
  requestId: string,
  status: number,
): Response {
  return new Response(JSON.stringify({ error: { code, message, requestId } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function identifierPartSum(identifier: string): number {
  let sum = 0;
  for (let index = 0; index < 8; index++) {
    const code = identifier.charCodeAt(index);
    sum += code <= 57 ? code - 48 : code - 87;
  }
  return sum;
}

export function routeVersion(context: RequestContext): Response | null {
  if (context.url.pathname.toLowerCase() !== '/version') return null;
  const requested = (context.url.searchParams.get('uuid') ?? '').toLowerCase();
  const expected = context.userId.toLowerCase();
  if (
    UUID_V4.test(requested) &&
    identifierPartSum(requested) === identifierPartSum(expected) &&
    requested.slice(-12) === expected.slice(-12)
  ) {
    return new Response(JSON.stringify({ Version: WORKER_VERSION }), {
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
    });
  }
  return null;
}

export async function routeQuickSubscription(context: RequestContext): Promise<Response | null> {
  if (
    context.encryptionKey === DEFAULT_ENCRYPTION_KEY ||
    context.url.pathname.slice(1) !== context.encryptionKey
  ) {
    return null;
  }
  const params = new URLSearchParams(context.url.search);
  params.set('token', await md5Twice(`${context.host}${context.userId}`));
  return new Response('重定向中...', {
    status: 302,
    headers: { Location: `/sub?${params.toString()}` },
  });
}

export async function routeLocations(context: RequestContext): Promise<Response | null> {
  if (context.url.pathname.toLowerCase() !== '/locations') return null;
  const actual = readLegacyAuthCookie(context.request);
  const expected = await createLegacyAuthToken(
    context.userAgent,
    context.encryptionKey,
    context.adminPassword,
  );
  if (!actual || actual !== expected) return null;
  return fetch(
    new Request('https://speed.cloudflare.com/locations', {
      headers: { Referer: 'https://speed.cloudflare.com/' },
    }),
  );
}

function nginxPage(): string {
  return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
}

function error1101Page(context: RequestContext): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Worker threw exception</title></head>
<body><h1>Error 1101</h1><p>Worker threw exception</p>
<hr><p>${context.url.host} · ${context.clientIp}</p></body></html>`;
}

function normalizeCamouflageOrigin(value: string | undefined): URL | null {
  const configured = (value ?? 'nginx').trim().replace(/\/$/, '');
  if (!configured || configured === 'nginx' || configured === '1101') return null;
  const withProtocol = /^https?:\/\//i.test(configured)
    ? configured.replace(/^http:\/\//i, 'https://')
    : `https://${configured}`;
  try {
    const parsed = new URL(withProtocol);
    return new URL(parsed.origin);
  } catch {
    return null;
  }
}

export async function camouflageResponse(context: RequestContext): Promise<Response> {
  if (context.env.URL?.trim() === '1101') {
    return new Response(error1101Page(context), {
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });
  }

  const origin = normalizeCamouflageOrigin(context.env.URL);
  if (origin) {
    try {
      const target = new URL(`${context.url.pathname}${context.url.search}`, origin);
      const headers = new Headers(context.request.headers);
      headers.set('Host', origin.host);
      headers.set('Referer', origin.origin);
      headers.set('Origin', origin.origin);
      const method = context.request.method;
      const upstream = await fetch(
        new Request(target, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? null : context.request.body,
          redirect: 'manual',
        }),
      );
      const contentType = upstream.headers.get('Content-Type') ?? '';
      if (/text|javascript|json|xml/i.test(contentType)) {
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.set('Cache-Control', 'no-store');
        responseHeaders.delete('Content-Length');
        responseHeaders.delete('Content-Encoding');
        const body = (await upstream.text()).replaceAll(origin.host, context.url.host);
        return new Response(body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      }
      return upstream;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'camouflage_proxy_failed',
          origin: origin.origin,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return new Response(nginxPage(), {
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}
