import type { RequestContext } from '../app/types';
import { createRequestMetadata } from '../app/request-context';
import { verifySubscriptionToken } from '../auth/subscription-token';
import { loadRuntimeSnapshot } from '../config/runtime';
import type { SubscriptionFormat } from '../config/schema';
import { buildSubscriptionNodes, serializeSubscription } from './model';

const FORMATS = new Set<SubscriptionFormat>(['mixed', 'base64', 'clash', 'singbox', 'surge']);

function detectSubscriptionFormat(url: URL, userAgent: string): SubscriptionFormat | null {
  const explicit = url.searchParams.get('format');
  if (explicit !== null) {
    return FORMATS.has(explicit as SubscriptionFormat) ? (explicit as SubscriptionFormat) : null;
  }

  const ua = userAgent.toLowerCase();
  if (ua.includes('clash') || ua.includes('mihomo')) return 'clash';
  if (ua.includes('sing-box') || ua.includes('singbox')) return 'singbox';
  if (ua.includes('surge')) return 'surge';
  return ua.includes('mozilla') ? 'mixed' : 'base64';
}

function contentType(format: SubscriptionFormat): string {
  if (format === 'clash') return 'application/x-yaml; charset=utf-8';
  if (format === 'singbox') return 'application/json; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

export async function handleSubscriptionRequest(context: RequestContext): Promise<Response | null> {
  if (context.url.pathname !== '/sub') return null;

  const metadata = createRequestMetadata(context.request, context.env, context.execution);
  const snapshot = await loadRuntimeSnapshot(metadata);
  const candidate = context.url.searchParams.get('token') ?? '';
  if (
    !candidate ||
    !(await verifySubscriptionToken(candidate, snapshot.secrets.admin, snapshot.identity.vlessUuid))
  ) {
    return null;
  }
  if (!snapshot.config.subscription.enabled) {
    return new Response('订阅功能未启用', { status: 404 });
  }

  const format = detectSubscriptionFormat(context.url, context.userAgent);
  if (!format) return new Response('不支持的订阅格式', { status: 400 });
  if (!snapshot.config.subscription.formats.includes(format)) {
    return new Response('订阅格式未启用', { status: 400 });
  }

  const nodes = buildSubscriptionNodes(snapshot, context.url);
  if (!nodes.length) return new Response('没有可用的订阅节点', { status: 503 });

  const headers = new Headers({
    'Content-Type': contentType(format),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (!context.userAgent.toLowerCase().includes('mozilla')) {
    headers.set('Content-Disposition', `attachment; filename="edgetunnel-${format}"`);
  }
  return new Response(serializeSubscription(format, nodes), { status: 200, headers });
}
