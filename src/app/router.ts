import type { RequestContext } from './types';
import { routeAdminRequest } from '../admin/routes';
import { fetchAdminAsset } from '../admin/assets';

export async function routeRequest(context: RequestContext): Promise<Response> {
  if (context.url.protocol === 'http:') {
    const secure = new URL(context.url);
    secure.protocol = 'https:';
    return Response.redirect(secure.toString(), 301);
  }
  if (!context.adminPassword) {
    const response = await fetchAdminAsset(context, '/noADMIN');
    return new Response(response.body, {
      status: 404,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const admin = await routeAdminRequest(context);
  if (admin) {
    return admin;
  }
  if (context.url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /', {
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }
  return context.env.ASSETS.fetch(context.request);
}
