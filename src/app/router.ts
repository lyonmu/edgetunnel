import type { RequestContext } from './types';
import { routeAdminRequest } from '../admin/routes';
import { fetchAdminAsset } from '../admin/assets';
import { handleSubscriptionRequest } from '../subscription/routes';
import { handleWebSocket } from '../transports/websocket';
import { handleGRPC } from '../transports/grpc';
import { handleXHTTP } from '../transports/xhttp';
import { createConnectTCP } from '../networking/tcp-connector';
import {
  camouflageResponse,
  routeLocations,
  routeQuickSubscription,
  routeVersion,
} from './response';

function isAdminPath(pathname: string): boolean {
  return pathname.startsWith('/admin/') || pathname === '/login';
}

function isGRPCTraffic(request: Request): boolean {
  const contentType = request.headers.get('Content-Type') || '';
  const referer = request.headers.get('Referer') || '';
  const isXHTTP = referer.includes('x_padding');
  return !isXHTTP && contentType.startsWith('application/grpc');
}

export async function routeRequest(context: RequestContext): Promise<Response> {
  const { request, url } = context;
  const upgradeHeader = request.headers.get('Upgrade');

  // 1. 版本接口必须优先于 Upgrade/POST 数据面。
  const version = routeVersion(context);
  if (version) return version;

  // 2. WebSocket 代理
  if (context.adminPassword && upgradeHeader === 'websocket') {
    const connectTCP = createConnectTCP(context);
    return handleWebSocket(request, context, connectTCP);
  }

  // 3. gRPC / XHTTP 代理 (POST, not admin/login)
  if (context.adminPassword && !isAdminPath(url.pathname) && request.method === 'POST') {
    const connectTCP = createConnectTCP(context);
    if (isGRPCTraffic(request)) {
      return handleGRPC(request, context, connectTCP);
    }
    return handleXHTTP(request, context, connectTCP);
  }

  // 4. HTTP → HTTPS 重定向
  if (url.protocol === 'http:') {
    const secure = new URL(url);
    secure.protocol = 'https:';
    return Response.redirect(secure.toString(), 301);
  }

  // 5. 缺少 ADMIN 密码
  if (!context.adminPassword) {
    const response = await fetchAdminAsset(context, '/noADMIN');
    return new Response(response.body, {
      status: 404,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // 6. 缺少 KV 绑定
  const kv = (context.env as Partial<Env>).KV;
  if (!kv || typeof kv.get !== 'function') {
    const response = await fetchAdminAsset(context, '/noKV');
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    headers.set('Pragma', 'no-cache');
    headers.set('Expires', '0');
    return new Response(response.body, {
      status: 404,
      statusText: response.statusText,
      headers,
    });
  }

  // 7. 快速订阅路径
  const quickSubscription = await routeQuickSubscription(context);
  if (quickSubscription) return quickSubscription;

  // 8. 管理后台路由
  const admin = await routeAdminRequest(context);
  if (admin) {
    return admin;
  }

  // 9. 订阅路由
  const subscription = await handleSubscriptionRequest(context);
  if (subscription) {
    return subscription;
  }

  // 10. locations
  const locations = await routeLocations(context);
  if (locations) return locations;

  // 11. robots.txt
  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /', {
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }

  // 12. 伪装页或本地 nginx fallback
  return camouflageResponse(context);
}
