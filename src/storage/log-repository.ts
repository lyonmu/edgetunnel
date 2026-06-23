export class LogRepository {
  constructor(private readonly kv: KVNamespace) {}

  private isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
  }

  async read(): Promise<unknown[]> {
    const text = await this.kv.get('log.json');
    if (!text) {
      return [];
    }
    try {
      const value: unknown = JSON.parse(text);
      return this.isUnknownArray(value) ? value : [];
    } catch {
      return [];
    }
  }
}
