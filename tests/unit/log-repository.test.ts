import { describe, expect, it } from 'vitest';
import {
  LOG_STORE_PREFIX,
  LogRepository,
  type SecurityEvent,
} from '../../src/storage/log-repository';

class MemoryKv {
  readonly values = new Map<string, string>();
  failWrites = false;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    if (this.failWrites) throw new Error('KV unavailable');
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(options: { prefix?: string; limit?: number }) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ''))
      .sort()
      .slice(0, options.limit)
      .map((name) => ({ name }));
    return { keys, list_complete: true, cacheStatus: null };
  }

  namespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}

function event(index: number): SecurityEvent {
  return {
    id: `event-${index}`,
    timestamp: `2026-07-29T00:00:${String(index).padStart(2, '0')}.000Z`,
    type: 'login_failed',
    outcome: 'denied',
    requestId: `request-${index}`,
    details: {
      password: 'must-not-leak',
      token: 'must-not-leak',
      clientIp: '203.0.113.42',
      note: `event ${index}`,
    },
  };
}

describe('LogRepository', () => {
  it('bounds retention and redacts sensitive fields', async () => {
    const kv = new MemoryKv();
    const repository = new LogRepository(kv.namespace(), 2);

    await repository.append(event(1));
    await repository.append(event(2));
    await repository.append(event(3));

    const logs = await repository.read();
    expect(logs.map((item) => item.id)).toEqual(['event-2', 'event-3']);
    const persisted = [...kv.values.entries()]
      .filter(([key]) => key.startsWith(LOG_STORE_PREFIX))
      .map(([, value]) => value)
      .join('');
    expect(persisted).not.toContain('must-not-leak');
    expect(persisted).not.toContain('203.0.113.42');
    expect(persisted).toContain('203.0.113.0/24');
  });

  it('limits oversized detail values and clears all events', async () => {
    const kv = new MemoryKv();
    const repository = new LogRepository(kv.namespace(), 10);
    const oversized = event(1);
    oversized.details = { note: 'x'.repeat(4_000) };

    await repository.append(oversized);
    expect(JSON.stringify(await repository.read()).length).toBeLessThan(2_000);
    await repository.clear();
    expect(await repository.read()).toEqual([]);
  });

  it('isolates KV write failures when requested', async () => {
    const kv = new MemoryKv();
    kv.failWrites = true;
    const repository = new LogRepository(kv.namespace(), 10);

    await expect(repository.appendSafely(event(1))).resolves.toBe(false);
  });

  it('stores concurrent events under independent KV keys', async () => {
    const kv = new MemoryKv();
    const repository = new LogRepository(kv.namespace(), 10);

    await Promise.all([repository.append(event(1)), repository.append(event(2))]);

    expect([...kv.values.keys()].filter((key) => key.startsWith(LOG_STORE_PREFIX))).toHaveLength(2);
    expect((await repository.read()).map((item) => item.id)).toEqual(['event-1', 'event-2']);
  });
});
