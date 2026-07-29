import type { RequestContext } from './types';
import { routeAdminRequest } from '../admin/routes';
import { fetchAdminAsset } from '../admin/assets';
import { handleSubscriptionRequest } from '../subscription/routes';
import { handleWebSocket } from '../transports/websocket';
import { handleGRPC } from '../transports/grpc';
import { handleXHTTP } from '../transports/xhttp';
import { createRequestMetadata } from './request-context';
import { loadRuntimeSnapshot } from '../config/runtime';
import { SecretStore } from '../security/secret-store';
import { createConnectorRegistry } from '../networking/connectors/registry';
import { createDialer } from '../networking/dialer';
import { createTunnelConnectTCP } from '../transports/session';
import {
  camouflageResponse,
  routeLocations,
  routeQuickSubscription,
  routeVersion,
} from './response';

function isAdminPath(pathname: string): boolean {
  return (
    pathname.startsWith('/admin/') ||
    pathname === '/admin' ||
    pathname === '/login' ||
    pathname.startsWith('/api/admin/')
  );
}

function isGRPCTraffic(request: Request): boolean {
  const contentType = request.headers.get('Content-Type') || '';
  const referer = request.headers.get('Referer') || '';
  const isXHTTP = referer.includes('x_padding');
  return !isXHTTP && contentType.startsWith('application/grpc');
}

async function createDataPlane(context: RequestContext) {
  const metadata = createRequestMetadata(context.request, context.env, context.execution);
  const snapshot = await loadRuntimeSnapshot(metadata);
  const store = new SecretStore(context.env.KV, snapshot.secrets.configKey);
  const dialer = createDialer(snapshot, {
    registry: createConnectorRegistry(),
    resolveCredential: (ref) => store.read(ref),
  });
  return {
    snapshot,
    connectTCP: createTunnelConnectTCP(dialer, context.request.signal),
    context: {
      ...context,
      userId: snapshot.identity.vlessUuid,
      runtimeSnapshot: snapshot,
    } satisfies RequestContext,
  };
}

export async function routeRequest(context: RequestContext): Promise<Response> {
  const { request, url } = context;
  const upgradeHeader = request.headers.get('Upgrade');

  // 1. 版本接口必须优先于 Upgrade/POST 数据面。
  const version = routeVersion(context);
  if (version) return version;

  // 2. 管理 API 必须优先于 POST 数据面。
  if (isAdminPath(url.pathname)) {
    const admin = await routeAdminRequest(context);
    if (admin) return admin;
  }

  // 3. WebSocket 代理
  if (context.adminPassword && upgradeHeader === 'websocket') {
    const dataPlane = await createDataPlane(context);
    if (
      dataPlane.snapshot.config.transports.websocket.enabled &&
      url.pathname === dataPlane.snapshot.config.transports.websocket.path
    ) {
      return handleWebSocket(request, dataPlane.context, dataPlane.connectTCP);
    }
  }

  // 4. gRPC / XHTTP 代理 (POST, not admin/login)
  if (context.adminPassword && !isAdminPath(url.pathname) && request.method === 'POST') {
    const dataPlane = await createDataPlane(context);
    if (
      isGRPCTraffic(request) &&
      dataPlane.snapshot.config.transports.grpc.enabled &&
      url.pathname === `/${dataPlane.snapshot.config.transports.grpc.serviceName}`
    ) {
      return handleGRPC(request, dataPlane.context, dataPlane.connectTCP);
    }
    if (
      dataPlane.snapshot.config.transports.xhttp.enabled &&
      url.pathname === dataPlane.snapshot.config.transports.xhttp.path
    ) {
      return handleXHTTP(request, dataPlane.context, dataPlane.connectTCP);
    }
  }

  // 5. HTTP → HTTPS 重定向
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

  // 8. 其余管理后台路由
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
