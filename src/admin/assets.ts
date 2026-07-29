import type { RequestContext } from '../app/types';

const ASSET_PATHS = {
  '/admin': '/admin/',
  '/login': '/login/',
} as const;

export function fetchAdminAsset(
  context: RequestContext,
  path: keyof typeof ASSET_PATHS,
): Promise<Response> {
  const assetUrl = new URL(ASSET_PATHS[path], context.url);
  return context.env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' })).then((response) => {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}
