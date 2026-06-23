import type { RequestContext } from '../app/types';

const ASSET_PATHS = {
  '/admin': '/admin/',
  '/login': '/login/',
  '/noADMIN': '/noADMIN/',
  '/noKV': '/noKV/',
} as const;

export function fetchAdminAsset(
  context: RequestContext,
  path: keyof typeof ASSET_PATHS,
): Promise<Response> {
  const assetUrl = new URL(ASSET_PATHS[path], context.url);
  return context.env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
}
