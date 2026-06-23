import type { RequestContext } from '../app/types';

export function applyClashPatch(content: string, context: RequestContext): string {
  void context;

  let yaml = content.replace(/mode:\s*Rule\b/g, 'mode: rule');

  const baseDnsBlock = `dns:
  enable: true
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
    - 114.114.114.114
  use-hosts: true
  nameserver:
    - https://sm2.doh.pub/dns-query
    - https://dns.alidns.com/dns-query
  fallback:
    - 8.8.4.4
    - 208.67.220.220
  fallback-filter:
    geoip: true
    geoip-code: CN
    ipcidr:
      - 240.0.0.0/4
      - 127.0.0.1/32
      - 0.0.0.0/32
    domain:
      - '+.google.com'
      - '+.facebook.com'
      - '+.youtube.com'
`;

  if (!/^dns:\s*(?:\n|$)/m.test(yaml)) {
    yaml = baseDnsBlock + yaml;
  }

  return yaml;
}
