import type { RequestContext } from './types';

const WORKER_VERSION = '2026.07.29';

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

export function routeVersion(context: RequestContext): Response | null {
  if (context.url.pathname !== '/version') return null;
  return new Response(JSON.stringify({ Version: WORKER_VERSION }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
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

function camouflageOrigin(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(new URL(value).origin);
  } catch {
    return null;
  }
}

export async function camouflageResponse(
  context: RequestContext,
  configuredUrl?: string,
): Promise<Response> {
  const origin = camouflageOrigin(configuredUrl);
  if (origin) {
    try {
      const target = new URL(`${context.url.pathname}${context.url.search}`, origin);
      const headers = new Headers(context.request.headers);
      for (const name of [
        'Authorization',
        'Cookie',
        'Proxy-Authorization',
        'CF-Connecting-IP',
        'True-Client-IP',
        'X-Forwarded-For',
        'X-Real-IP',
      ]) {
        headers.delete(name);
      }
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
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set('Cache-Control', 'no-store');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
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
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}
