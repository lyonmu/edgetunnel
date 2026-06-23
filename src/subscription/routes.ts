import type { RequestContext } from '../app/types';
import type { SubscriptionType } from './types';
import { generateMixedSubscription } from './generate';
import { fetchTextLimited } from '../shared/fetch-limited';
import { applyClashPatch } from './clash';
import { applySingboxPatch } from './singbox';
import { applySurgePatch } from './surge';

export async function handleSubscriptionRequest(context: RequestContext): Promise<Response | null> {
  if (context.url.pathname !== '/sub') {
    return null;
  }

  const { url, request, env } = context;
  const ua = request.headers.get('User-Agent') || '';

  const subscriptionType = detectSubscriptionType(url, ua);

  const responseHeaders: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  if (!ua.includes('mozilla')) {
    responseHeaders['Content-Disposition'] = `attachment; filename*=utf-8''edgetunnel`;
  }

  try {
    let content = '';

    if (subscriptionType === 'mixed' || subscriptionType === 'base64') {
      content = await generateMixedSubscription(context);
    } else {
      const mixedContent = await generateMixedSubscription(context);
      const converterUrl = buildConverterUrl(url, subscriptionType, mixedContent, context);

      const response = await fetchTextLimited(converterUrl, {
        headers: {
          'User-Agent': `Subconverter for ${subscriptionType} edgetunnel`,
        },
      }, {
        timeoutMs: 10000,
        maxBytes: 1024 * 1024,
      });

      if (!response.ok) {
        return new Response('订阅转换后端异常：' + response.statusText, {
          status: response.status,
        });
      }

      content = response.text;

      if (subscriptionType === 'clash') {
        content = applyClashPatch(content, context);
        responseHeaders['Content-Type'] = 'application/x-yaml; charset=utf-8';
      } else if (subscriptionType === 'singbox') {
        content = await applySingboxPatch(content, context);
        responseHeaders['Content-Type'] = 'application/json; charset=utf-8';
      } else if (subscriptionType === 'surge') {
        content = applySurgePatch(content, url, context);
      }
    }

    if (subscriptionType === 'base64') {
      content = btoa(content);
    }

    return new Response(content, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Subscription generation failed:', error);
    return new Response('订阅生成失败', { status: 500 });
  }
}

function detectSubscriptionType(url: URL, ua: string): SubscriptionType {
  const uaLower = ua.toLowerCase();

  if (url.searchParams.has('b64') || url.searchParams.has('base64')) {
    return 'base64';
  }

  if (url.searchParams.has('target')) {
    return url.searchParams.get('target') as SubscriptionType;
  }

  if (url.searchParams.has('clash') || uaLower.includes('clash') || uaLower.includes('meta') || uaLower.includes('mihomo')) {
    return 'clash';
  }

  if (url.searchParams.has('sb') || url.searchParams.has('singbox') || uaLower.includes('singbox') || uaLower.includes('sing-box')) {
    return 'singbox';
  }

  if (url.searchParams.has('surge') || uaLower.includes('surge')) {
    return 'surge';
  }

  if (url.searchParams.has('quanx') || uaLower.includes('quantumult')) {
    return 'quanx';
  }

  if (url.searchParams.has('loon') || uaLower.includes('loon')) {
    return 'loon';
  }

  return 'mixed';
}

function buildConverterUrl(
  originalUrl: URL,
  targetType: SubscriptionType,
  mixedContent: string,
  context: RequestContext,
): string {
  const { env } = context;
  const subApi = env.SUBAPI || 'https://subapi.example.com';
  const subConfig = env.SUBCONFIG || '';

  return `${subApi}/sub?target=${targetType}&url=${encodeURIComponent(mixedContent)}&config=${encodeURIComponent(subConfig)}`;
}
