import { describe, expect, it } from 'vitest';
import {
  createSubscriptionToken,
  verifySubscriptionToken,
} from '../../src/auth/subscription-token';

const adminSecret = 'admin-secret';
const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';

describe('subscription token', () => {
  it('is stable without exposing either input', async () => {
    const first = await createSubscriptionToken(adminSecret, uuid);
    const second = await createSubscriptionToken(adminSecret, uuid);

    expect(first).toBe(second);
    expect(first.startsWith('v1.')).toBe(true);
    expect(first).not.toContain(adminSecret);
    expect(first).not.toContain(uuid);
    expect(first).not.toMatch(/^[a-f0-9]{32}$/);
  });

  it('verifies only the matching admin secret and UUID', async () => {
    const token = await createSubscriptionToken(adminSecret, uuid);

    await expect(verifySubscriptionToken(token, adminSecret, uuid)).resolves.toBe(true);
    await expect(verifySubscriptionToken(token, 'wrong', uuid)).resolves.toBe(false);
    await expect(
      verifySubscriptionToken(token, adminSecret, '00000000-0000-4000-8000-000000000000'),
    ).resolves.toBe(false);
    await expect(verifySubscriptionToken(`${token}x`, adminSecret, uuid)).resolves.toBe(false);
  });
});
