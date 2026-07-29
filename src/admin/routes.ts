import type { RequestContext, RuntimeEnv } from '../app/types';
import { createRequestMetadata } from '../app/request-context';
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
import { fetchAdminAsset } from './assets';

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
  const metadata = createRequestMetadata(
    context.request,
    context.env as RuntimeEnv,
    context.execution,
  );
  return {
    metadata,
    snapshot: await loadRuntimeSnapshot(metadata),
  };
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
      return jsonError('INVALID_CREDENTIALS', '用户名或密码无效', metadata.requestId, 401);
    }
    const password =
      typeof body === 'object' && body !== null && 'password' in body
        ? String((body as { password: unknown }).password)
        : '';
    if (!timingSafeEqual(encoder.encode(password), encoder.encode(snapshot.secrets.admin))) {
      return jsonError('INVALID_CREDENTIALS', '用户名或密码无效', metadata.requestId, 401);
    }
    const response = jsonData({ authenticated: true }, 201);
    response.headers.set('Set-Cookie', sessionCookie(await createSession(snapshot.secrets.admin)));
    return response;
  }

  if (context.request.method === 'DELETE') {
    const response = new Response(null, { status: 204 });
    response.headers.set('Set-Cookie', expiredSessionCookie());
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
        return jsonData({ config: await service.updateConfig(update) });
      }
    }
    if (context.url.pathname === '/api/admin/v1/logs') {
      if (context.request.method === 'GET') return jsonData({ logs: await service.logs.read() });
      if (context.request.method === 'DELETE') {
        await service.logs.clear();
        return new Response(null, { status: 204 });
      }
    }
    if (
      context.url.pathname === '/api/admin/v1/subscriptions/preview' ||
      /^\/api\/admin\/v1\/profiles\/[^/]+\/test$/.test(context.url.pathname)
    ) {
      return jsonError('NOT_READY', '该能力将在后续数据面任务中接入', metadata.requestId, 501);
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
    if (error instanceof RuntimeConfigurationError) {
      return jsonError('RUNTIME_NOT_CONFIGURED', error.message, requestId, 503);
    }
    console.error({ event: 'admin_request_failed', requestId, error: String(error) });
    return jsonError('INTERNAL_ERROR', '管理接口处理失败', requestId, 500);
  }
}

export async function routeAdminRequest(context: RequestContext): Promise<Response | null> {
  const path = context.url.pathname;
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
