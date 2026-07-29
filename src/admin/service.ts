import { ConfigRevisionConflict, loadConfig, saveConfig } from '../config/repository';
import { ConfigValidationError } from '../config/schema';
import { parseWorkerConfig } from '../config/validate';
import { SecretStore, type ProfileCredential } from '../security/secret-store';
import { LogRepository } from '../storage/log-repository';

export interface ConfigUpdateRequest {
  config: unknown;
  expectedRevision: number;
  credentials?: Record<string, ProfileCredential | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseConfigUpdateRequest(value: unknown): ConfigUpdateRequest {
  if (!isRecord(value) || !Number.isInteger(value.expectedRevision)) {
    throw new ConfigValidationError([
      { path: '/', message: '必须包含 config 和整数 expectedRevision' },
    ]);
  }
  const credentials = value.credentials;
  if (
    credentials !== undefined &&
    (!isRecord(credentials) ||
      Object.values(credentials).some((credential) => credential !== null && !isRecord(credential)))
  ) {
    throw new ConfigValidationError([{ path: '/credentials', message: '必须是凭据对象映射' }]);
  }
  return {
    config: value.config,
    expectedRevision: value.expectedRevision as number,
    ...(credentials
      ? { credentials: credentials as Record<string, ProfileCredential | null> }
      : {}),
  };
}

export class AdminService {
  readonly logs: LogRepository;
  private readonly secrets: SecretStore;

  constructor(
    private readonly kv: KVNamespace,
    configKey: string,
    retention: number,
  ) {
    this.secrets = new SecretStore(kv, configKey);
    this.logs = new LogRepository(kv, retention);
  }

  async readConfig() {
    return loadConfig(this.kv);
  }

  async updateConfig(request: ConfigUpdateRequest) {
    const config = parseWorkerConfig(request.config);
    if (request.credentials) {
      for (const [ref, credential] of Object.entries(request.credentials)) {
        if (credential === null) await this.secrets.delete(ref);
        else await this.secrets.write(ref, credential);
      }
    }
    return saveConfig(this.kv, config, request.expectedRevision);
  }
}

export { ConfigRevisionConflict, ConfigValidationError };
