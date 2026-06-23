import type { RequestContext } from './types';
import legacyWorker from '../../_worker.js';
import { routeAdminRequest } from '../admin/routes';
import { fetchAdminAsset } from '../admin/assets';
import { handleSubscriptionRequest } from '../subscription/routes';
import { handleWebSocket } from '../transports/websocket';
import { handleGRPC } from '../transports/grpc';
import { handleXHTTP } from '../transports/xhttp';
import { createConnectTCP } from '../networking/tcp-connector';

function isAdminPath(pathname: string): boolean {
  return pathname.startsWith('/admin/') || pathname === '/login';
}

function isGRPCTraffic(request: Request): boolean {
  const contentType = request.headers.get('Content-Type') || '';
  return contentType.startsWith('application/grpc');
}

function isXHTTPTraffic(request: Request): boolean {
  const referer = request.headers.get('Referer') || '';
  return referer.includes('x_padding', 14) || referer.includes('x_padding=');
}

export async function routeRequest(context: RequestContext): Promise<Response> {
  const { request, url } = context;
  const upgradeHeader = request.headers.get('Upgrade');

  // 1. WebSocket 代理
  if (context.adminPassword && upgradeHeader === 'websocket') {
    const connectTCP = createConnectTCP(context);
    return handleWebSocket(request, context, connectTCP);
  }

  // 2. gRPC / XHTTP 代理 (POST, not admin/login)
  if (context.adminPassword && !isAdminPath(url.pathname) && request.method === 'POST') {
    const connectTCP = createConnectTCP(context);
    if (isGRPCTraffic(request)) {
      return handleGRPC(request, context, connectTCP);
    }
    return handleXHTTP(request, context, connectTCP);
  }

  // 3. HTTP → HTTPS 重定向
  if (url.protocol === 'http:') {
    const secure = new URL(url);
    secure.protocol = 'https:';
    return Response.redirect(secure.toString(), 301);
  }

  // 4. 缺少 ADMIN 密码
  if (!context.adminPassword) {
    const response = await fetchAdminAsset(context, '/noADMIN');
    return new Response(response.body, {
      status: 404,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // 5. 管理后台路由
  const admin = await routeAdminRequest(context);
  if (admin) {
    return admin;
  }

  // 6. 订阅路由
  const subscription = await handleSubscriptionRequest(context);
  if (subscription) {
    return subscription;
  }

  // 7. robots.txt
  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /', {
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }

  // 8. Legacy 兜底
  return legacyWorker.fetch(context.request, context.env, context.execution);
}
