import { decodeBase64Url, encodeBase64Url, signHmac, timingSafeEqual } from '../security/crypto';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const COOKIE_NAME = 'edt_session';
const encoder = new TextEncoder();

function canonicalBase64Url(value: string): Uint8Array | null {
  try {
    const decoded = decodeBase64Url(value);
    return encodeBase64Url(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie') ?? '';
  return (
    cookies
      .split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null
  );
}

export async function createSession(adminSecret: string, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1_000);
  const expiresAt = Math.floor((now + SESSION_TTL_MS) / 1_000);
  const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  const payload = `v1.${issuedAt}.${expiresAt}.${nonce}`;
  const signature = encodeBase64Url(await signHmac(adminSecret, encoder.encode(payload)));
  return `${payload}.${signature}`;
}

export async function verifySession(
  token: string,
  adminSecret: string,
  now = Date.now(),
): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 5) return false;
  const [version, issuedText, expiresText, nonce, signatureText] = parts;
  if (version !== 'v1' || !/^\d+$/u.test(issuedText ?? '') || !/^\d+$/u.test(expiresText ?? '')) {
    return false;
  }
  if (!nonce || canonicalBase64Url(nonce) === null || !signatureText) return false;
  const signature = canonicalBase64Url(signatureText);
  if (!signature) return false;

  const issuedAt = Number(issuedText) * 1_000;
  const expiresAt = Number(expiresText) * 1_000;
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt - issuedAt !== SESSION_TTL_MS ||
    issuedAt > now + MAX_CLOCK_SKEW_MS ||
    now >= expiresAt
  ) {
    return false;
  }

  const payload = `${version}.${issuedText}.${expiresText}.${nonce}`;
  const expected = await signHmac(adminSecret, encoder.encode(payload));
  return timingSafeEqual(signature, expected);
}

export function readSessionCookie(request: Request): string | null {
  return readCookie(request, COOKIE_NAME);
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict`;
}

export function expiredSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
