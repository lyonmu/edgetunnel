import { md5Twice } from '../shared/hash';

/**
 * Task 4-6 迁移期间供旧管理路由使用，版本化管理 API 接入后删除。
 */
export async function createLegacyAuthToken(
  userAgent: string,
  key: string,
  admin: string,
): Promise<string> {
  return md5Twice(`${userAgent}${key}${admin}`);
}

export function readLegacyAuthCookie(request: Request): string | null {
  const cookies = request.headers.get('Cookie') ?? '';
  return (
    cookies
      .split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith('auth='))
      ?.slice('auth='.length) ?? null
  );
}
