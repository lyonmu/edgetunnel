export const LOG_STORE_KEY = 'edgetunnel:logs:v1';
export const LOG_STORE_PREFIX = `${LOG_STORE_KEY}:`;
const SENSITIVE_KEY = /password|token|cookie|authorization|uuid|secret|credential/i;
const MAX_DETAIL_LENGTH = 512;

export interface SecurityEvent {
  id: string;
  timestamp: string;
  type: string;
  outcome: 'success' | 'denied' | 'error';
  requestId: string;
  details?: Record<string, unknown>;
}

function redactIp(value: string): string {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (value.includes(':')) {
    return `${value.split(':').slice(0, 3).join(':')}::/48`;
  }
  return value;
}

function sanitize(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) {
    if (/ip$/i.test(key) && typeof value === 'string') return redactIp(value);
    return '[redacted]';
  }
  if (typeof value === 'string') {
    const limited = value.slice(0, MAX_DETAIL_LENGTH);
    return /ip$/i.test(key) ? redactIp(limited) : limited;
  }
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitize(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([childKey, child]) => [childKey, sanitize(child, childKey)]),
    );
  }
  return value;
}

function isSecurityEvent(value: unknown): value is SecurityEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === 'string' &&
    typeof event.timestamp === 'string' &&
    typeof event.type === 'string' &&
    ['success', 'denied', 'error'].includes(String(event.outcome)) &&
    typeof event.requestId === 'string'
  );
}

export class LogRepository {
  private readonly retention: number;

  constructor(
    private readonly kv: KVNamespace,
    retention = 100,
  ) {
    this.retention = Math.max(0, Math.min(100, Math.floor(retention)));
  }

  async read(): Promise<SecurityEvent[]> {
    if (this.retention === 0) return [];
    const listed = await this.kv.list({ prefix: LOG_STORE_PREFIX, limit: 1_000 });
    const current = (
      await Promise.all(
        listed.keys.slice(-this.retention).map(async ({ name }) => {
          const text = await this.kv.get(name);
          if (!text) return null;
          try {
            const value: unknown = JSON.parse(text);
            return isSecurityEvent(value) ? value : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter((event): event is SecurityEvent => event !== null);
    const legacyText = await this.kv.get(LOG_STORE_KEY);
    if (!legacyText) return current.slice(-this.retention);
    try {
      const value: unknown = JSON.parse(legacyText);
      const legacy = Array.isArray(value) ? value.filter(isSecurityEvent) : [];
      return [...legacy, ...current]
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-this.retention);
    } catch {
      return current.slice(-this.retention);
    }
  }

  async append(event: SecurityEvent): Promise<void> {
    if (this.retention === 0) return;
    const sanitized = sanitize(event) as SecurityEvent;
    const key = `${LOG_STORE_PREFIX}${sanitized.timestamp}:${sanitized.id}`;
    await this.kv.put(key, JSON.stringify(sanitized));
    const listed = await this.kv.list({ prefix: LOG_STORE_PREFIX, limit: 1_000 });
    const overflow = listed.keys.length - this.retention;
    if (overflow > 0) {
      await Promise.all(listed.keys.slice(0, overflow).map(({ name }) => this.kv.delete(name)));
    }
  }

  async appendSafely(event: SecurityEvent): Promise<boolean> {
    try {
      await this.append(event);
      return true;
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    const listed = await this.kv.list({ prefix: LOG_STORE_PREFIX, limit: 1_000 });
    await Promise.all([
      this.kv.delete(LOG_STORE_KEY),
      ...listed.keys.map(({ name }) => this.kv.delete(name)),
    ]);
  }
}
