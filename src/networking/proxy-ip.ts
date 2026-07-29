import { resolveDns, type DnsAnswer } from './dns';
import { isIPHostname } from './proxy-connectors';
import type { DialCandidate } from './sockets';

export type DnsResolver = (domain: string, recordType: string) => Promise<DnsAnswer[]>;

function parseCandidate(value: string, defaultPort = 443): DialCandidate | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  let hostname = normalized;
  let port = defaultPort;
  const transportPort = /\.tp(\d+)/i.exec(normalized);
  if (transportPort?.[1]) {
    port = Number(transportPort[1]);
  }

  if (normalized.includes(']:')) {
    const separator = normalized.lastIndexOf(']:');
    hostname = `${normalized.slice(0, separator)}]`;
    port = Number(normalized.slice(separator + 2)) || port;
  } else if (!normalized.startsWith('[') && (normalized.match(/:/g) ?? []).length === 1) {
    const separator = normalized.lastIndexOf(':');
    hostname = normalized.slice(0, separator);
    port = Number(normalized.slice(separator + 1)) || port;
  }

  return { hostname, port };
}

function parseTxtCandidates(answers: readonly DnsAnswer[]): DialCandidate[] {
  return answers
    .filter((answer) => answer.type.toUpperCase() === 'TXT')
    .flatMap((answer) =>
      answer.data
        .replace(/^"|"$/g, '')
        .replaceAll('\\010', ',')
        .replaceAll('\n', ',')
        .split(',')
        .map((entry) => parseCandidate(entry))
        .filter((entry): entry is DialCandidate => entry !== null),
    );
}

function candidateKey(candidate: DialCandidate): string {
  return `${candidate.hostname}:${candidate.port}`;
}

function stableScore(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export async function resolveProxyCandidates(
  proxyIp: string,
  targetHost: string,
  userId: string,
  resolver: DnsResolver = resolveDns,
): Promise<DialCandidate[]> {
  const resolved: DialCandidate[] = [];
  const configured = proxyIp
    .split(',')
    .map((entry) => parseCandidate(entry))
    .filter((entry): entry is DialCandidate => entry !== null);

  for (const candidate of configured) {
    if (isIPHostname(candidate.hostname)) {
      resolved.push(candidate);
      continue;
    }

    const [txtAnswers, aAnswers] = await Promise.all([
      resolver(candidate.hostname, 'TXT'),
      resolver(candidate.hostname, 'A'),
    ]);
    const txtCandidates = parseTxtCandidates(txtAnswers);
    if (txtCandidates.length > 0) {
      resolved.push(...txtCandidates);
      continue;
    }

    const ipv4 = aAnswers
      .filter((answer) => answer.type.toUpperCase() === 'A')
      .map((answer) => ({ hostname: answer.data, port: candidate.port }));
    if (ipv4.length > 0) {
      resolved.push(...ipv4);
      continue;
    }

    const ipv6 = (await resolver(candidate.hostname, 'AAAA'))
      .filter((answer) => answer.type.toUpperCase() === 'AAAA')
      .map((answer) => ({ hostname: `[${answer.data}]`, port: candidate.port }));
    resolved.push(...(ipv6.length > 0 ? ipv6 : [candidate]));
  }

  const unique = [
    ...new Map(resolved.map((candidate) => [candidateKey(candidate), candidate])).values(),
  ];
  unique.sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
  if (unique.length <= 8) return unique;

  const rootDomain = targetHost.includes('.')
    ? targetHost.split('.').slice(-2).join('.')
    : targetHost;
  return unique
    .map((candidate) => ({
      candidate,
      score: stableScore(`${rootDomain}:${userId}:${candidateKey(candidate)}`),
    }))
    .sort((left, right) => left.score - right.score)
    .slice(0, 8)
    .map(({ candidate }) => candidate);
}
