import type { RequestContext } from '../app/types';
import { createLegacyAuthToken, readLegacyAuthCookie } from '../auth/legacy-session';
import { createLegacyDefaultConfig } from '../config/legacy-defaults';
import { loadStoredConfig, saveStoredConfig } from '../config/repository';
import { buildRuntimeConfig } from '../config/runtime';
import { LogRepository } from '../storage/log-repository';
import { fetchAdminAsset } from './assets';
import { md5Twice } from '../shared/hash';
import type { StoredConfig } from '../config/types';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
  });
}

function redirect(location: string): Response {
  return new Response('重定向中...', { status: 302, headers: { Location: location } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function expectedAuthToken(context: RequestContext): Promise<string> {
  return createLegacyAuthToken(context.userAgent, context.encryptionKey, context.adminPassword);
}

async function isAuthenticated(context: RequestContext): Promise<boolean> {
  const cookie = readLegacyAuthCookie(context.request);
  return Boolean(cookie && cookie === (await expectedAuthToken(context)));
}

async function buildAdminRuntime(context: RequestContext, stored: StoredConfig) {
  const runtime = buildRuntimeConfig(stored, context);
  runtime.优选订阅生成.TOKEN = await md5Twice(`${context.host}${context.userId}`);
  return runtime;
}

async function handleLogin(context: RequestContext): Promise<Response> {
  if (await isAuthenticated(context)) {
    return redirect('/admin');
  }
  if (context.request.method === 'POST') {
    const form = await context.request.formData();
    const input = form.get('password');
    if (input === context.adminPassword.replace(/[\r\n]/g, '')) {
      const response = json({ success: true });
      response.headers.set(
        'Set-Cookie',
        `auth=${await expectedAuthToken(context)}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`,
      );
      return response;
    }
  }
  return fetchAdminAsset(context, '/login');
}

async function handleAdmin(context: RequestContext): Promise<Response> {
  if (!(await isAuthenticated(context))) {
    return redirect('/login');
  }
  const path = context.url.pathname;
  if (path === '/admin/log.json') {
    return json(await new LogRepository(context.env.KV).read());
  }
  if (path === '/admin/cf.json' && context.request.method !== 'POST') {
    return json(context.request.cf ?? {});
  }
  const stored = await loadStoredConfig(context.env.KV, context.host, context.userId);
  const runtime = await buildAdminRuntime(context, stored);

  if (path === '/admin/init') {
    const defaults = createLegacyDefaultConfig(context.host, context.userId);
    await saveStoredConfig(context.env.KV, defaults);
    return json({ ...(await buildAdminRuntime(context, defaults)), init: '配置已重置为默认值' });
  }

  if (context.request.method === 'POST') {
    if (path === '/admin/config.json') {
      const config: unknown = await context.request.json();
      if (!isRecord(config) || !config.UUID || !config.HOST) {
        return json({ error: '配置不完整' }, 400);
      }
      await saveStoredConfig(context.env.KV, config);
      return json({ success: true, message: '配置已保存' });
    }
    if (path === '/admin/ADD.txt') {
      await context.env.KV.put('ADD.txt', await context.request.text());
      return json({ success: true, message: '自定义IP已保存' });
    }
    if (path === '/admin/tg.json') {
      await context.env.KV.put('tg.json', JSON.stringify(await context.request.json(), null, 2));
      return json({ success: true, message: '配置已保存' });
    }
    if (path === '/admin/cf.json') {
      await context.env.KV.put('cf.json', JSON.stringify(await context.request.json(), null, 2));
      return json({ success: true, message: '配置已保存' });
    }
    return json({ error: '不支持的POST请求路径' }, 404);
  }

  if (path === '/admin/config.json') {
    return json(runtime);
  }
  if (path === '/admin/ADD.txt') {
    return new Response((await context.env.KV.get('ADD.txt')) ?? 'null', {
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    });
  }
  return fetchAdminAsset(context, '/admin');
}

export async function routeAdminRequest(context: RequestContext): Promise<Response | null> {
  if (context.url.pathname === '/login') {
    return handleLogin(context);
  }
  if (context.url.pathname === '/logout') {
    const response = redirect('/login');
    response.headers.set('Set-Cookie', 'auth=; Path=/; Max-Age=0; HttpOnly');
    return response;
  }
  if (context.url.pathname === '/admin' || context.url.pathname.startsWith('/admin/')) {
    return handleAdmin(context);
  }
  return null;
}
