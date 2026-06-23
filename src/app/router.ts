import type { RequestContext } from './types';
import legacyWorker from '../../_worker.js';
import { routeAdminRequest } from '../admin/routes';
import { fetchAdminAsset } from '../admin/assets';
import { handleSubscriptionRequest } from '../subscription/routes';

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

  const subscription = await handleSubscriptionRequest(context);
  if (subscription) {
    return subscription;
  }

  if (context.url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /', {
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }
  return legacyWorker.fetch(context.request, context.env, context.execution);
}
