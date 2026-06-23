import { md5Twice } from '../shared/hash';

export async function createAuthToken(
  userAgent: string,
  key: string,
  admin: string,
): Promise<string> {
  return md5Twice(`${userAgent}${key}${admin}`);
}

export function readAuthCookie(request: Request): string | null {
  const cookies = request.headers.get('Cookie') ?? '';
  return (
    cookies
      .split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith('auth='))
      ?.slice('auth='.length) ?? null
  );
}
