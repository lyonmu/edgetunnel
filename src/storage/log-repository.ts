export const LOG_STORE_KEY = 'edgetunnel:logs:v1';
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
    this.retention = Math.max(0, Math.min(1_000, Math.floor(retention)));
  }

  async read(): Promise<SecurityEvent[]> {
    const text = await this.kv.get(LOG_STORE_KEY);
    if (!text) return [];
    try {
      const value: unknown = JSON.parse(text);
      return Array.isArray(value) ? value.filter(isSecurityEvent).slice(-this.retention) : [];
    } catch {
      return [];
    }
  }

  async append(event: SecurityEvent): Promise<void> {
    if (this.retention === 0) return;
    const sanitized = sanitize(event) as SecurityEvent;
    const events = [...(await this.read()), sanitized].slice(-this.retention);
    await this.kv.put(LOG_STORE_KEY, JSON.stringify(events));
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
    await this.kv.delete(LOG_STORE_KEY);
  }
}
