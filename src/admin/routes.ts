import type { RequestContext } from '../app/types';
import { jsonData, jsonError } from '../app/response';
import {
  createSession,
  expiredSessionCookie,
  readSessionCookie,
  sessionCookie,
  verifySession,
} from '../auth/session';
import { loadRuntimeSnapshot, RuntimeConfigurationError } from '../config/runtime';
import { timingSafeEqual } from '../security/crypto';
import {
  AdminService,
  ConfigRevisionConflict,
  ConfigValidationError,
  parseConfigUpdateRequest,
} from './service';
import { fetchAdminAsset, isAdminAssetPath } from './assets';
import type { SubscriptionFormat } from '../config/schema';
import { createSubscriptionToken } from '../auth/subscription-token';
import { buildSubscriptionNodes, serializeSubscription } from '../subscription/model';
import { LogRepository, type SecurityEvent } from '../storage/log-repository';

const encoder = new TextEncoder();

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api/admin/v1' || pathname.startsWith('/api/admin/v1/');
}

function isWriteRequest(request: Request): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
}

function validateWriteRequest(context: RequestContext): Response | null {
  if (!isWriteRequest(context.request)) return null;
  if (context.request.headers.get('Origin') !== context.url.origin) {
    return jsonError('INVALID_ORIGIN', '请求来源无效', crypto.randomUUID(), 403);
  }
  if (
    context.request.method !== 'DELETE' &&
    !context.request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')
  ) {
    return jsonError(
      'INVALID_CONTENT_TYPE',
      '请求必须使用 application/json',
      crypto.randomUUID(),
      415,
    );
  }
  return null;
}

async function runtime(context: RequestContext) {
  return {
    metadata: context,
    snapshot: await loadRuntimeSnapshot(context),
  };
}

function audit(
  context: RequestContext,
  retention: number,
  type: string,
  outcome: SecurityEvent['outcome'],
  details?: Record<string, unknown>,
): void {
  const logs = new LogRepository(context.env.KV, retention);
  context.execution.waitUntil(
    logs.appendSafely({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      outcome,
      requestId: context.requestId,
      ...(details ? { details } : {}),
    }),
  );
}

function parseProfileTarget(value: unknown): { hostname: string; port: number } {
  if (value === undefined) return { hostname: 'www.gstatic.com', port: 443 };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigValidationError([{ path: '/', message: '连接测试参数必须是对象' }]);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'hostname' && key !== 'port')) {
    throw new ConfigValidationError([{ path: '/', message: '连接测试包含未知字段' }]);
  }
  const hostname = record.hostname === undefined ? 'www.gstatic.com' : record.hostname;
  const port = record.port === undefined ? 443 : record.port;
  if (
    typeof hostname !== 'string' ||
    hostname.length < 1 ||
    hostname.length > 253 ||
    /[\s/@]/.test(hostname)
  ) {
    throw new ConfigValidationError([{ path: '/hostname', message: '目标主机名无效' }]);
  }
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new ConfigValidationError([{ path: '/port', message: '目标端口无效' }]);
  }
  return { hostname: hostname.toLowerCase(), port: Number(port) };
}

async function authenticated(context: RequestContext, admin: string): Promise<boolean> {
  const token = readSessionCookie(context.request);
  return Boolean(token && (await verifySession(token, admin)));
}

async function handleSession(context: RequestContext): Promise<Response> {
  const { metadata, snapshot } = await runtime(context);
  const invalidWrite = validateWriteRequest(context);
  if (invalidWrite) return invalidWrite;

  if (context.request.method === 'POST') {
    let body: unknown;
    try {
      body = await context.request.json();
    } catch {
      audit(context, snapshot.config.observability.retention, 'admin_login', 'denied', {
        clientIp: context.clientIp,
      });
      return jsonError('INVALID_CREDENTIALS', '用户名或密码无效', metadata.requestId, 401);
    }
    const password =
      typeof body === 'object' && body !== null && 'password' in body
        ? String((body as { password: unknown }).password)
        : '';
    if (!timingSafeEqual(encoder.encode(password), encoder.encode(snapshot.secrets.admin))) {
      audit(context, snapshot.config.observability.retention, 'admin_login', 'denied', {
        clientIp: context.clientIp,
      });
      return jsonError('INVALID_CREDENTIALS', '用户名或密码无效', metadata.requestId, 401);
    }
    const response = jsonData({ authenticated: true }, 201);
    response.headers.set('Set-Cookie', sessionCookie(await createSession(snapshot.secrets.admin)));
    audit(context, snapshot.config.observability.retention, 'admin_login', 'success', {
      clientIp: context.clientIp,
    });
    return response;
  }

  if (context.request.method === 'DELETE') {
    const response = new Response(null, { status: 204 });
    response.headers.set('Set-Cookie', expiredSessionCookie());
    audit(context, snapshot.config.observability.retention, 'admin_logout', 'success');
    return response;
  }

  if (context.request.method === 'GET') {
    if (!(await authenticated(context, snapshot.secrets.admin))) {
      return jsonError('AUTH_REQUIRED', '需要管理员登录', metadata.requestId, 401);
    }
    return jsonData({ authenticated: true });
  }
  return jsonError('METHOD_NOT_ALLOWED', '不支持的请求方法', metadata.requestId, 405);
}

async function handleApi(context: RequestContext): Promise<Response> {
  const kv = (context.env as Partial<Env>).KV;
  if (!kv || typeof kv.get !== 'function') {
    return jsonError(
      'RUNTIME_NOT_CONFIGURED',
      'Worker 运行时尚未完成配置',
      crypto.randomUUID(),
      503,
    );
  }
  try {
    if (context.url.pathname === '/api/admin/v1/session') {
      return await handleSession(context);
    }
    const { metadata, snapshot } = await runtime(context);
    if (!(await authenticated(context, snapshot.secrets.admin))) {
      return jsonError('AUTH_REQUIRED', '需要管理员登录', metadata.requestId, 401);
    }
    const invalidWrite = validateWriteRequest(context);
    if (invalidWrite) return invalidWrite;
    const service = new AdminService(
      context.env.KV,
      snapshot.secrets.configKey,
      snapshot.config.observability.retention,
    );

    if (context.url.pathname === '/api/admin/v1/config') {
      if (context.request.method === 'GET') {
        return jsonData({ config: await service.readConfig() });
      }
      if (context.request.method === 'PUT') {
        const update = parseConfigUpdateRequest(await context.request.json());
        const config = await service.updateConfig(update);
        audit(context, config.observability.retention, 'config_update', 'success', {
          revision: config.revision,
        });
        return jsonData({ config });
      }
    }
    if (context.url.pathname === '/api/admin/v1/logs') {
      if (context.request.method === 'GET') return jsonData({ logs: await service.logs.read() });
      if (context.request.method === 'DELETE') {
        await service.logs.clear();
        return new Response(null, { status: 204 });
      }
    }
    if (context.url.pathname === '/api/admin/v1/subscriptions/preview') {
      if (context.request.method !== 'GET') {
        return jsonError('METHOD_NOT_ALLOWED', '不支持的请求方法', metadata.requestId, 405);
      }
      const format = (context.url.searchParams.get('format') ?? 'mixed') as SubscriptionFormat;
      if (!snapshot.config.subscription.formats.includes(format)) {
        return jsonError('FORMAT_NOT_ENABLED', '订阅格式未启用', metadata.requestId, 400);
      }
      const nodes = buildSubscriptionNodes(snapshot, context.url);
      const subscriptionUrl = new URL(
        '/sub',
        snapshot.config.subscription.publicBaseUrl ?? context.url.origin,
      );
      subscriptionUrl.searchParams.set(
        'token',
        await createSubscriptionToken(snapshot.secrets.admin, snapshot.identity.vlessUuid),
      );
      subscriptionUrl.searchParams.set('format', format);
      return jsonData({
        format,
        nodeCount: nodes.length,
        subscriptionUrl: subscriptionUrl.toString(),
        content: serializeSubscription(format, nodes),
      });
    }
    const profileMatch = context.url.pathname.match(/^\/api\/admin\/v1\/profiles\/([^/]+)\/test$/);
    if (profileMatch) {
      if (context.request.method !== 'POST') {
        return jsonError('METHOD_NOT_ALLOWED', '不支持的请求方法', metadata.requestId, 405);
      }
      const profileId = decodeURIComponent(profileMatch[1]!);
      const profile = snapshot.config.egressProfiles.find(
        (candidate) => candidate.id === profileId && candidate.enabled,
      );
      if (!profile) {
        return jsonError(
          'PROFILE_NOT_FOUND',
          '出站 Profile 不存在或未启用',
          metadata.requestId,
          404,
        );
      }
      const body: unknown = await context.request.json();
      const target = parseProfileTarget(body);
      try {
        const result = await service.testProfile(snapshot, profileId, target);
        audit(context, snapshot.config.observability.retention, 'profile_test', 'success', {
          profileId,
          profileType: profile.type,
          durationMs: result.durationMs,
        });
        return jsonData(result);
      } catch {
        audit(context, snapshot.config.observability.retention, 'profile_test', 'error', {
          profileId,
          profileType: profile.type,
        });
        return jsonError(
          'PROFILE_TEST_FAILED',
          '出站 Profile 连接测试失败',
          metadata.requestId,
          502,
        );
      }
    }
    return jsonError('NOT_FOUND', '接口不存在', metadata.requestId, 404);
  } catch (error) {
    const requestId = crypto.randomUUID();
    if (error instanceof ConfigRevisionConflict) {
      return jsonError('CONFIG_REVISION_CONFLICT', error.message, requestId, 409);
    }
    if (error instanceof ConfigValidationError) {
      return jsonError('CONFIG_INVALID', error.message, requestId, 422);
    }
    if (error instanceof SyntaxError || error instanceof URIError) {
      return jsonError('INVALID_JSON', '请求 JSON 或路径编码无效', requestId, 400);
    }
    if (error instanceof RuntimeConfigurationError) {
      return jsonError('RUNTIME_NOT_CONFIGURED', error.message, requestId, 503);
    }
    console.error({ event: 'admin_request_failed', requestId, error: String(error) });
    return jsonError('INTERNAL_ERROR', '管理接口处理失败', requestId, 500);
  }
}

export async function routeAdminRequest(context: RequestContext): Promise<Response | null> {
  const path = context.url.pathname;
  if (isAdminAssetPath(path) && path !== '/admin' && path !== '/login') {
    return fetchAdminAsset(context, path);
  }
  if (isApiPath(path)) return handleApi(context);
  if (path === '/login') {
    try {
      const { snapshot } = await runtime(context);
      if (await authenticated(context, snapshot.secrets.admin)) return redirect('/admin');
    } catch {
      // 登录页面仍需可访问，以显示运行时配置错误。
    }
    return fetchAdminAsset(context, '/login');
  }
  if (path === '/admin') {
    try {
      const { snapshot } = await runtime(context);
      if (!(await authenticated(context, snapshot.secrets.admin))) return redirect('/login');
      return fetchAdminAsset(context, '/admin');
    } catch {
      return redirect('/login');
    }
  }
  if (path.startsWith('/admin/')) {
    return jsonError('NOT_FOUND', '旧管理接口已删除', crypto.randomUUID(), 404);
  }
  return null;
}
