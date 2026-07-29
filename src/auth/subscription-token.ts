import { decodeBase64Url, encodeBase64Url, signHmac, timingSafeEqual } from '../security/crypto';

const encoder = new TextEncoder();

function payload(uuid: string): Uint8Array {
  return encoder.encode(`edgetunnel:subscription:v1:${uuid.toLowerCase()}`);
}

export async function createSubscriptionToken(adminSecret: string, uuid: string): Promise<string> {
  return `v1.${encodeBase64Url(await signHmac(adminSecret, payload(uuid)))}`;
}

export async function verifySubscriptionToken(
  candidate: string,
  adminSecret: string,
  uuid: string,
): Promise<boolean> {
  const [version, encoded, extra] = candidate.split('.');
  if (version !== 'v1' || !encoded || extra !== undefined) return false;
  let signature: Uint8Array;
  try {
    signature = decodeBase64Url(encoded);
    if (encodeBase64Url(signature) !== encoded) return false;
  } catch {
    return false;
  }
  const expected = await signHmac(adminSecret, payload(uuid));
  return timingSafeEqual(signature, expected);
}
