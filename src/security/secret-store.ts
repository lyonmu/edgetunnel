import { decryptJson, encryptJson, type EncryptedEnvelope } from './crypto';

export const SECRET_STORE_KEY = 'edgetunnel:secrets:v1';
const CREDENTIAL_REF_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface ProfileCredential {
  username?: string;
  password: string;
}

type SecretDocument = Record<string, EncryptedEnvelope>;

function assertCredentialRef(ref: string): void {
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    throw new Error('凭据引用必须是 1 到 64 位的小写字母、数字或连字符');
  }
}

function assertCredential(value: unknown): asserts value is ProfileCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('凭据必须是对象');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== 'username' && key !== 'password')) {
    throw new Error('凭据包含不支持的字段');
  }
  if (
    typeof record.password !== 'string' ||
    record.password.length === 0 ||
    record.password.length > 1_024
  ) {
    throw new Error('凭据 password 长度必须在 1 到 1024 之间');
  }
  if (
    record.username !== undefined &&
    (typeof record.username !== 'string' || record.username.length > 512)
  ) {
    throw new Error('凭据 username 长度不能超过 512');
  }
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    record.algorithm === 'AES-256-GCM' &&
    typeof record.nonce === 'string' &&
    typeof record.ciphertext === 'string'
  );
}

export class SecretStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly encryptionKey: string,
  ) {}

  private async loadDocument(): Promise<SecretDocument> {
    const text = await this.kv.get(SECRET_STORE_KEY);
    if (text === null) return {};
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Secret Store 文档格式无效');
    }
    const document: SecretDocument = {};
    for (const [ref, envelope] of Object.entries(value)) {
      assertCredentialRef(ref);
      if (!isEnvelope(envelope)) {
        throw new Error(`Secret Store 中 ${ref} 的 envelope 无效`);
      }
      document[ref] = envelope;
    }
    return document;
  }

  async read(ref: string): Promise<ProfileCredential | null> {
    assertCredentialRef(ref);
    const document = await this.loadDocument();
    const envelope = document[ref];
    if (!envelope) return null;
    const credential = await decryptJson<unknown>(
      this.encryptionKey,
      `${SECRET_STORE_KEY}:${ref}`,
      envelope,
    );
    assertCredential(credential);
    return credential;
  }

  async write(ref: string, credential: ProfileCredential): Promise<void> {
    assertCredentialRef(ref);
    assertCredential(credential);
    const document = await this.loadDocument();
    document[ref] = await encryptJson(this.encryptionKey, `${SECRET_STORE_KEY}:${ref}`, credential);
    await this.kv.put(SECRET_STORE_KEY, JSON.stringify(document));
  }

  async delete(ref: string): Promise<void> {
    assertCredentialRef(ref);
    const document = await this.loadDocument();
    delete document[ref];
    await this.kv.put(SECRET_STORE_KEY, JSON.stringify(document));
  }
}
