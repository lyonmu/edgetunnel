export async function md5Twice(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const first = new Uint8Array(await crypto.subtle.digest('MD5', encoder.encode(value)));
  const firstHex = Array.from(first, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const second = new Uint8Array(
    await crypto.subtle.digest('MD5', encoder.encode(firstHex.slice(7, 27))),
  );
  return Array.from(second, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
