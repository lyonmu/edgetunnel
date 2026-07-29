import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from '../../src/security/crypto';
import {
  SECRET_STORE_KEY,
  SecretStore,
  type ProfileCredential,
} from '../../src/security/secret-store';

class MemoryKv {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  namespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}

const encryptionKey = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index));
const credential: ProfileCredential = { username: 'alice', password: 'correct-horse' };

describe('SecretStore', () => {
  it('stores only an encrypted envelope in KV', async () => {
    const kv = new MemoryKv();
    const store = new SecretStore(kv.namespace(), encryptionKey);

    await store.write('proxy-main', credential);

    const persisted = kv.values.get(SECRET_STORE_KEY) ?? '';
    expect(persisted).not.toContain(credential.username ?? '');
    expect(persisted).not.toContain(credential.password);
    await expect(store.read('proxy-main')).resolves.toEqual(credential);
  });

  it('binds ciphertext to its credential reference', async () => {
    const kv = new MemoryKv();
    const store = new SecretStore(kv.namespace(), encryptionKey);
    await store.write('profile-a', credential);
    const document = JSON.parse(kv.values.get(SECRET_STORE_KEY) ?? '{}') as Record<string, unknown>;
    document['profile-b'] = document['profile-a'];
    kv.values.set(SECRET_STORE_KEY, JSON.stringify(document));

    await expect(store.read('profile-b')).rejects.toThrow();
  });

  it('returns null for an absent reference and removes an existing reference', async () => {
    const kv = new MemoryKv();
    const store = new SecretStore(kv.namespace(), encryptionKey);

    await expect(store.read('missing')).resolves.toBeNull();
    await store.write('proxy-main', credential);
    await store.delete('proxy-main');

    await expect(store.read('proxy-main')).resolves.toBeNull();
    expect(kv.values.get(SECRET_STORE_KEY)).not.toContain('proxy-main');
  });

  it('rejects invalid credential references', async () => {
    const store = new SecretStore(new MemoryKv().namespace(), encryptionKey);

    await expect(store.write('../secret', credential)).rejects.toThrow(/引用/);
    await expect(store.read('')).rejects.toThrow(/引用/);
  });
});
