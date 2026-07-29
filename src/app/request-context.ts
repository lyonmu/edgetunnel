import type { RequestContext, RequestMetadata, RuntimeEnv } from './types';

export type { RequestMetadata, RuntimeEnv } from './types';

export function createRequestMetadata(
  request: Request,
  env: RuntimeEnv,
  execution: ExecutionContext,
): RequestMetadata {
  return {
    request,
    env,
    execution,
    url: new URL(request.url),
    clientIp: request.headers.get('CF-Connecting-IP') ?? 'unknown',
    userAgent: request.headers.get('User-Agent') ?? '',
    requestId: crypto.randomUUID(),
  };
}

export function createRequestContext(
  request: Request,
  env: RuntimeEnv,
  execution: ExecutionContext,
): RequestContext {
  return createRequestMetadata(request, env, execution);
}
