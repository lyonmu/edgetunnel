import type { RequestContext } from '../app/types';

export function applySurgePatch(content: string, url: URL, context: RequestContext): string {
  void url;
  void context;
  const lines = content.includes('\r\n') ? content.split('\r\n') : content.split('\n');

  let output = '';
  for (const line of lines) {
    if (
      line.includes('= tro' + 'jan,') &&
      !line.includes('ws=true') &&
      !line.includes('ws-path=')
    ) {
      const host = line.split('sni=')[1]?.split(',')[0] || '';
      const oldContent = `sni=${host}, skip-cert-verify=false`;
      const newContent = `sni=${host}, skip-cert-verify=false, ws=true, ws-path=/, ws-headers=Host:"${host}"`;
      output += line.replace(new RegExp(oldContent, 'g'), newContent) + '\n';
    } else {
      output += line + '\n';
    }
  }

  return output;
}
