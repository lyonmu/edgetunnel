import { describe, expect, it } from 'vitest';
import {
  SESSION_TTL_MS,
  createSession,
  expiredSessionCookie,
  sessionCookie,
  verifySession,
} from '../../src/auth/session';

const secret = 'correct horse battery staple';
const now = Date.UTC(2026, 6, 29, 8);

describe('HMAC admin session', () => {
  it('accepts a valid v1 token during its eight hour lifetime', async () => {
    const token = await createSession(secret, now);

    expect(token.startsWith('v1.')).toBe(true);
    await expect(verifySession(token, secret, now + SESSION_TTL_MS - 1)).resolves.toBe(true);
  });

  it('rejects expired, future, modified and wrong-secret tokens', async () => {
    const token = await createSession(secret, now);
    const modified = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    await expect(verifySession(token, secret, now + SESSION_TTL_MS + 1)).resolves.toBe(false);
    await expect(verifySession(token, secret, now - 61_000)).resolves.toBe(false);
    await expect(verifySession(modified, secret, now)).resolves.toBe(false);
    await expect(verifySession(token, 'wrong secret', now)).resolves.toBe(false);
  });

  it.each(['', 'v2.1.2.a.b', 'v1.bad.2.a.b', 'v1.1.2.!.b'])(
    'rejects malformed token %s',
    async (token) => {
      await expect(verifySession(token, secret, now)).resolves.toBe(false);
    },
  );

  it('creates hardened session cookies', async () => {
    const token = await createSession(secret, now);

    expect(sessionCookie(token)).toBe(
      `edt_session=${token}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(expiredSessionCookie()).toBe(
      'edt_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
    );
  });
});
