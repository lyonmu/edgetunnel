import type { RequestContext } from '../app/types';

export async function applySingboxPatch(content: string, context: RequestContext): Promise<string> {
  const { env } = context;
  const uuid = env.UUID || '';
  const fingerprint = 'chrome';

  try {
    const config = JSON.parse(content);

    if (config.dns) {
      if (!config.dns.servers) {
        config.dns.servers = [];
      }

      const hasFakeip = config.dns.servers.some((s: any) => s?.type === 'fakeip');
      if (!hasFakeip) {
        config.dns.servers.push({
          type: 'fakeip',
          tag: 'fakeip',
        });
      }
    }

    if (config.route) {
      delete config.route.geoip;
      delete config.route.geosite;
    }

    if (Array.isArray(config.outbounds)) {
      for (const outbound of config.outbounds) {
        if (outbound.uuid === uuid || outbound.password === uuid) {
          if (!outbound.tls) {
            outbound.tls = { enabled: true };
          }

          if (fingerprint) {
            outbound.tls.utls = {
              enabled: true,
              fingerprint: fingerprint,
            };
          }
        }
      }
    }

    return JSON.stringify(config, null, 2);
  } catch (e) {
    console.error('Singbox热补丁执行失败:', e);
    return JSON.stringify(JSON.parse(content), null, 2);
  }
}
