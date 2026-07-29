import type { DataPlaneContext, RequestContext } from './types';
import { routeAdminRequest } from '../admin/routes';
import { handleSubscriptionRequest } from '../subscription/routes';
import { handleWebSocket } from '../transports/websocket';
import { handleGRPC } from '../transports/grpc';
import { handleXHTTP } from '../transports/xhttp';
import { loadConfig } from '../config/repository';
import { loadRuntimeSnapshot, RuntimeConfigurationError } from '../config/runtime';
import { SecretStore } from '../security/secret-store';
import { createConnectorRegistry } from '../networking/connectors/registry';
import { createDialer, resolveTargetAddresses } from '../networking/dialer';
import { createTunnelConnectTCP } from '../transports/session';
import { camouflageResponse, jsonData, jsonError, routeVersion } from './response';

function isAdminPath(pathname: string): boolean {
  return (
    pathname.startsWith('/admin/') ||
    pathname === '/admin' ||
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/shared/') ||
    pathname.startsWith('/api/admin/')
  );
}

function isGRPCTraffic(request: Request): boolean {
  const contentType = request.headers.get('Content-Type') || '';
  const referer = request.headers.get('Referer') || '';
  return !referer.includes('x_padding') && contentType.startsWith('application/grpc');
}

function matchesXHTTPPath(pathname: string, configuredPath: string): boolean {
  const normalized = configuredPath === '/' ? '/' : configuredPath.replace(/\/+$/, '');
  return pathname === normalized || (normalized !== '/' && pathname === `${normalized}/`);
}

function runtimeUnavailable(context: RequestContext, error?: unknown): Response {
  const message =
    error instanceof RuntimeConfigurationError ? error.message : 'Worker 运行时尚未完成配置';
  return jsonError('RUNTIME_NOT_CONFIGURED', message, context.requestId, 503);
}

async function createDataPlane(context: RequestContext) {
  if (!context.env.KV || typeof context.env.KV.get !== 'function') {
    throw new RuntimeConfigurationError('MISSING_SECRET', 'KV', '缺少 Worker KV 绑定');
  }
  const snapshot = await loadRuntimeSnapshot(context);
  const store = new SecretStore(context.env.KV, snapshot.secrets.configKey);
  const dialer = createDialer(snapshot, {
    registry: createConnectorRegistry(),
    resolveCredential: (ref) => store.read(ref),
    resolveTarget: resolveTargetAddresses,
  });
  const dataPlaneContext: DataPlaneContext = {
    ...context,
    userId: snapshot.identity.vlessUuid,
    runtimeSnapshot: snapshot,
  };
  return {
    snapshot,
    connectTCP: createTunnelConnectTCP(dialer, context.request.signal),
    context: dataPlaneContext,
  };
}

async function routeDataPlane(context: RequestContext): Promise<Response | null> {
  const { request, url } = context;
  const websocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const streamPost = !isAdminPath(url.pathname) && request.method === 'POST';
  if (!websocket && !streamPost) return null;

  try {
    const dataPlane = await createDataPlane(context);
    if (
      websocket &&
      dataPlane.snapshot.config.transports.websocket.enabled &&
      url.pathname === dataPlane.snapshot.config.transports.websocket.path
    ) {
      return handleWebSocket(request, dataPlane.context, dataPlane.connectTCP);
    }
    if (
      streamPost &&
      isGRPCTraffic(request) &&
      dataPlane.snapshot.config.transports.grpc.enabled &&
      url.pathname ===
        `/${dataPlane.snapshot.config.transports.grpc.serviceName.replace(/^\/+|\/+$/g, '')}/Tun`
    ) {
      return handleGRPC(request, dataPlane.context, dataPlane.connectTCP);
    }
    if (
      streamPost &&
      dataPlane.snapshot.config.transports.xhttp.enabled &&
      matchesXHTTPPath(url.pathname, dataPlane.snapshot.config.transports.xhttp.path)
    ) {
      return handleXHTTP(request, dataPlane.context, dataPlane.connectTCP);
    }
    return null;
  } catch (error) {
    if (error instanceof RuntimeConfigurationError || !context.env.KV) {
      return runtimeUnavailable(context, error);
    }
    throw error;
  }
}

async function routeSubscription(context: RequestContext): Promise<Response | null> {
  if (context.url.pathname !== '/sub') return null;
  if (!context.env.KV) return runtimeUnavailable(context);
  try {
    return await handleSubscriptionRequest(context);
  } catch (error) {
    if (error instanceof RuntimeConfigurationError) return runtimeUnavailable(context, error);
    throw error;
  }
}

async function configuredCamouflageUrl(context: RequestContext): Promise<string | undefined> {
  if (!context.env.KV) return undefined;
  try {
    return (await loadConfig(context.env.KV)).site.camouflageUrl;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'camouflage_config_failed',
        requestId: context.requestId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }
}

export async function routeRequest(context: RequestContext): Promise<Response> {
  const { url } = context;

  const version = routeVersion(context);
  if (version) return version;

  if (url.pathname === '/healthz') {
    return jsonData({ status: 'ok', service: 'edgetunnel' });
  }

  if (url.protocol === 'http:') {
    const secure = new URL(url);
    secure.protocol = 'https:';
    return Response.redirect(secure.toString(), 301);
  }

  if (isAdminPath(url.pathname)) {
    const admin = await routeAdminRequest(context);
    if (admin) return admin;
  }

  const dataPlane = await routeDataPlane(context);
  if (dataPlane) return dataPlane;

  const subscription = await routeSubscription(context);
  if (subscription) return subscription;

  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /', {
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }

  return camouflageResponse(context, await configuredCamouflageUrl(context));
}
