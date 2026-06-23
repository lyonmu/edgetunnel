import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const exportedNames = [
  '整理成数组',
  '获取SOCKS5账号',
  '获取代理默认端口',
  '数据转Uint8Array',
  '拼接字节数据',
  '解析木马请求',
  '解析魏烈思请求',
  '获取传输协议配置',
  '获取传输路径参数值',
] as const;

type LegacyExportName = (typeof exportedNames)[number];
type LegacyExports = Record<LegacyExportName, unknown>;

export async function loadLegacyWorker(): Promise<LegacyExports> {
  const source = await readFile('_worker.js', 'utf8');
  const transformed = source
    .replace("import { connect as cloudflareConnect } from 'cloudflare:sockets';", '')
    .replace('export default {', 'const legacyWorker = {');
  const exportSource = `\n;globalThis.__legacy = { ${exportedNames.join(', ')} };`;
  const context = vm.createContext({
    URL,
    Proxy,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    crypto,
    atob,
    btoa,
    console,
  }) as vm.Context & { __legacy?: LegacyExports };

  vm.runInContext(`${transformed}${exportSource}`, context);

  if (!context.__legacy) {
    throw new Error('Legacy exports were not created');
  }
  return context.__legacy;
}
