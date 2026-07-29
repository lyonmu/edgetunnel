import type { RequestContext } from '../app/types';

const ASSET_PATHS = {
  '/admin': '/admin/',
  '/login': '/login/',
  '/admin/app.js': '/admin/app.js',
  '/admin/styles.css': '/admin/styles.css',
  '/login/app.js': '/login/app.js',
  '/shared/styles.css': '/shared/styles.css',
} as const;

export type AdminAssetPath = keyof typeof ASSET_PATHS;

export function isAdminAssetPath(path: string): path is AdminAssetPath {
  return Object.hasOwn(ASSET_PATHS, path);
}

export function fetchAdminAsset(context: RequestContext, path: AdminAssetPath): Promise<Response> {
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
