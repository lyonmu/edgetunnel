import { ConfigRevisionConflict, loadConfig, saveConfig } from '../config/repository';
import type { RuntimeSnapshot } from '../config/runtime';
import { ConfigValidationError } from '../config/schema';
import { parseWorkerConfig } from '../config/validate';
import { createConnectorRegistry } from '../networking/connectors/registry';
import type { ConnectorRegistry, DialTarget } from '../networking/connectors/types';
import { createDialer, resolveTargetAddresses, type TargetResolver } from '../networking/dialer';
import {
  SecretStore,
  type ProfileCredential,
  validateCredentialRef,
  validateProfileCredential,
} from '../security/secret-store';
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
    private readonly connectorRegistry: ConnectorRegistry = createConnectorRegistry(),
    private readonly targetResolver: TargetResolver = resolveTargetAddresses,
  ) {
    this.secrets = new SecretStore(kv, configKey);
    this.logs = new LogRepository(kv, retention);
  }

  async readConfig() {
    return loadConfig(this.kv);
  }

  async updateConfig(request: ConfigUpdateRequest) {
    const config = parseWorkerConfig(request.config);
    const current = await loadConfig(this.kv);
    if (current.revision !== request.expectedRevision) {
      throw new ConfigRevisionConflict(request.expectedRevision, current.revision);
    }
    if (request.credentials) {
      for (const [ref, credential] of Object.entries(request.credentials)) {
        try {
          validateCredentialRef(ref);
          if (credential !== null) validateProfileCredential(ref, credential);
        } catch (error) {
          throw new ConfigValidationError([
            {
              path: `/credentials/${ref}`,
              message: error instanceof Error ? error.message : '凭据无效',
            },
          ]);
        }
      }
    }
    const saved = await saveConfig(this.kv, config, request.expectedRevision);
    if (request.credentials) {
      await this.secrets.apply(request.credentials);
    }
    return saved;
  }

  async testProfile(snapshot: RuntimeSnapshot, profileId: string, target: DialTarget) {
    const config = structuredClone(snapshot.config);
    config.routing.defaultProfileId = profileId;
    config.routing.rules = [];
    config.routing.blockPrivateTargets = true;
    const testSnapshot: RuntimeSnapshot = { ...snapshot, config };
    const dialer = createDialer(testSnapshot, {
      registry: this.connectorRegistry,
      resolveCredential: (ref) => this.secrets.read(ref),
      resolveTarget: this.targetResolver,
    });
    const started = performance.now();
    const result = await dialer.connect(target, 'vless', new AbortController().signal);
    try {
      return {
        profileId: result.profile.id,
        profileType: result.profile.type,
        target,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      };
    } finally {
      await result.socket.close().catch(() => undefined);
    }
  }
}

export { ConfigRevisionConflict, ConfigValidationError };
