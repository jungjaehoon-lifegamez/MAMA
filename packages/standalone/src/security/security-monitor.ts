import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

const logger = new DebugLogger('SecurityMonitor');
const ALERT_COOLDOWN_MS = Number(process.env.MAMA_SECURITY_ALERT_COOLDOWN_MS || 60_000);
const HONEYPOT_DELAY_MS = Number(process.env.MAMA_HONEYPOT_DELAY_MS || 2_000);
const MAX_TARPIT_DELAY_MS = Number(process.env.MAMA_TARPIT_MAX_DELAY_MS || 5_000);
const SECURITY_ENRICHMENT_TIMEOUT_MS = Number(
  process.env.MAMA_SECURITY_ENRICHMENT_TIMEOUT_MS || 4_000
);

const suspicionScores = new Map<string, { score: number; updatedAt: number }>();
const attributionCache = new Map<string, NetworkAttribution | null>();
const HONEYPOT_PATTERNS = [
  /^\/\.git(?:\/|$)/i,
  /^\/\.env(?:\.|$)/i,
  /^\/\.DS_Store$/i,
  /^\/wp-login\.php$/i,
  /^\/xmlrpc\.php$/i,
  /^\/phpmyadmin(?:\/|$)/i,
  /^\/server-status$/i,
  /^\/nginx_status$/i,
  /^\/backup(?:\.(?:zip|tar|gz|sql|bak))?$/i,
  /^\/mama-memory\.db$/i,
  /^\/debug$/i,
  /^\/metrics$/i,
];

export type SecuritySeverity = 'info' | 'warn' | 'critical';

export interface SecurityEvent {
  type: string;
  severity: SecuritySeverity;
  message: string;
  clientAddress?: string | null;
  remoteAddress?: string | null;
  forwardedFor?: string | null;
  cfConnectingIp?: string | null;
  cfRay?: string | null;
  method?: string | null;
  path?: string | null;
  viaTunnel?: boolean;
  details?: Record<string, unknown>;
  timestamp?: string;
}

interface NetworkAttribution {
  source: 'rdap';
  networkName?: string | null;
  organization?: string | null;
  country?: string | null;
  cidr?: string | null;
  abuseEmails?: string[];
  asn?: string | null;
  handle?: string | null;
}

type SecurityAlertSender = (event: SecurityEvent) => Promise<void>;

let alertSender: SecurityAlertSender | null = null;
const lastAlertAt = new Map<string, number>();
const incidentIds = new Map<string, string>();
const pendingTasks = new Set<Promise<void>>();

function buildFingerprint(event: SecurityEvent): string {
  return JSON.stringify([
    event.type,
    event.clientAddress || event.remoteAddress || 'unknown',
    event.path || 'unknown',
  ]);
}

function normalizeClientKey(clientAddress: string | null | undefined): string {
  if (!clientAddress || clientAddress === 'unknown') {
    return 'unknown';
  }
  return clientAddress.replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

function getIncidentId(event: SecurityEvent): string {
  const clientKey = normalizeClientKey(event.clientAddress || event.remoteAddress);
  const existing = incidentIds.get(clientKey);
  if (existing) {
    return existing;
  }

  const incidentId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${clientKey}`;
  incidentIds.set(clientKey, incidentId);
  return incidentId;
}

function getRiskWeight(severity: SecuritySeverity): number {
  switch (severity) {
    case 'critical':
      return 4;
    case 'warn':
      return 2;
    default:
      return 1;
  }
}

function isLocalAddress(address: string | null | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function getClientAddressFromRequestLike(req: {
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string | null };
}): string {
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim();
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function getPathFromRequestLike(req: {
  originalUrl?: string;
  url?: string;
  headers: Record<string, unknown>;
}): string {
  const rawUrl = req.originalUrl || req.url || '/';
  try {
    return new URL(rawUrl, `http://${String(req.headers.host || 'localhost')}`).pathname;
  } catch {
    return rawUrl;
  }
}

function rememberSuspiciousClient(
  clientAddress: string | null | undefined,
  severity: SecuritySeverity
): void {
  if (!clientAddress || clientAddress === 'unknown' || isLocalAddress(clientAddress)) {
    return;
  }

  const existing = suspicionScores.get(clientAddress);
  const nextScore = Math.min(20, (existing?.score || 0) + getRiskWeight(severity));
  suspicionScores.set(clientAddress, { score: nextScore, updatedAt: Date.now() });
}

export function getTarpitDelayMs(clientAddress: string | null | undefined): number {
  if (!clientAddress || clientAddress === 'unknown' || isLocalAddress(clientAddress)) {
    return 0;
  }

  const entry = suspicionScores.get(clientAddress);
  if (!entry || entry.score < 3) {
    return 0;
  }

  return Math.min(MAX_TARPIT_DELAY_MS, entry.score * 250);
}

export function isHoneypotPath(pathname: string): boolean {
  return HONEYPOT_PATTERNS.some((pattern) => pattern.test(pathname));
}

function shouldSendAlert(event: SecurityEvent): boolean {
  if (!alertSender) {
    return false;
  }

  const fingerprint = buildFingerprint(event);
  const now = Date.now();
  const last = lastAlertAt.get(fingerprint) || 0;
  if (now - last < ALERT_COOLDOWN_MS) {
    return false;
  }
  lastAlertAt.set(fingerprint, now);
  return true;
}

function trackBackgroundTask(task: Promise<void>): void {
  pendingTasks.add(task);
  void task.finally(() => {
    pendingTasks.delete(task);
  });
}

async function appendSecurityLog(event: SecurityEvent): Promise<void> {
  await mkdir(getSecurityLogDir(), { recursive: true });
  await appendFile(getSecurityLogPath(), `${JSON.stringify(event)}\n`, 'utf8');
}

function extractAbuseEmails(rdap: Record<string, unknown>): string[] {
  const entities = Array.isArray(rdap.entities) ? rdap.entities : [];
  const emails = new Set<string>();

  for (const entity of entities) {
    if (!entity || typeof entity !== 'object') {
      continue;
    }
    const roles = Array.isArray((entity as { roles?: unknown[] }).roles)
      ? ((entity as { roles?: unknown[] }).roles as unknown[])
      : [];
    const isAbuseRelated = roles.some(
      (role) =>
        typeof role === 'string' &&
        ['abuse', 'technical', 'administrative', 'noc'].includes(role.toLowerCase())
    );
    if (!isAbuseRelated) {
      continue;
    }

    const vcardArray = (entity as { vcardArray?: unknown }).vcardArray;
    if (!Array.isArray(vcardArray) || vcardArray.length < 2 || !Array.isArray(vcardArray[1])) {
      continue;
    }

    for (const entry of vcardArray[1]) {
      if (!Array.isArray(entry) || entry[0] !== 'email' || typeof entry[3] !== 'string') {
        continue;
      }
      emails.add(entry[3]);
    }
  }

  return [...emails];
}

async function lookupNetworkAttribution(ip: string): Promise<NetworkAttribution | null> {
  if (!ip || ip === 'unknown' || isLocalAddress(ip)) {
    return null;
  }

  if (attributionCache.has(ip)) {
    return attributionCache.get(ip)!;
  }

  if (process.env.MAMA_SECURITY_ENRICHMENT === 'false') {
    attributionCache.set(ip, null);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SECURITY_ENRICHMENT_TIMEOUT_MS);

  try {
    const res = await fetch(`https://rdap.org/ip/${encodeURIComponent(ip)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/rdap+json, application/json' },
    });
    if (!res.ok) {
      attributionCache.set(ip, null);
      return null;
    }

    const rdap = (await res.json()) as Record<string, unknown>;
    const cidrEntries = Array.isArray(rdap.cidr0_cidrs)
      ? (rdap.cidr0_cidrs as Array<Record<string, unknown>>)
      : [];
    const cidr = cidrEntries
      .map((entry) =>
        entry.v4prefix && entry.length
          ? `${entry.v4prefix}/${entry.length}`
          : entry.v6prefix && entry.length
            ? `${entry.v6prefix}/${entry.length}`
            : null
      )
      .find(Boolean);

    const attribution: NetworkAttribution = {
      source: 'rdap',
      networkName: typeof rdap.name === 'string' ? rdap.name : null,
      organization:
        typeof rdap.port43 === 'string'
          ? rdap.port43
          : typeof rdap.objectClassName === 'string'
            ? rdap.objectClassName
            : null,
      country: typeof rdap.country === 'string' ? rdap.country : null,
      cidr: typeof cidr === 'string' ? cidr : null,
      abuseEmails: extractAbuseEmails(rdap),
      asn:
        typeof rdap.asn === 'string'
          ? rdap.asn
          : typeof rdap.startAutnum === 'number'
            ? `AS${rdap.startAutnum}`
            : null,
      handle: typeof rdap.handle === 'string' ? rdap.handle : null,
    };

    attributionCache.set(ip, attribution);
    return attribution;
  } catch (error) {
    logger.warn('Network attribution lookup failed', { ip, error: String(error) });
    attributionCache.set(ip, null);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function formatAbuseReport(incidentId: string, incidentSummary: IncidentSummary): string {
  return [
    '# Abuse Report Draft',
    '',
    `- Incident ID: ${incidentId}`,
    `- Generated At: ${new Date().toISOString()}`,
    `- Severity: ${incidentSummary.highestSeverity}`,
    `- Suspected Source IP: ${incidentSummary.clientAddress || 'unknown'}`,
    `- First Seen: ${incidentSummary.firstSeen}`,
    `- Last Seen: ${incidentSummary.lastSeen}`,
    `- Event Count: ${incidentSummary.eventCount}`,
    '',
    '## Summary',
    incidentSummary.summary,
    '',
    '## Network Attribution',
    `- ASN: ${incidentSummary.attribution?.asn || 'unknown'}`,
    `- Network: ${incidentSummary.attribution?.networkName || 'unknown'}`,
    `- Organization: ${incidentSummary.attribution?.organization || 'unknown'}`,
    `- Country: ${incidentSummary.attribution?.country || 'unknown'}`,
    `- CIDR: ${incidentSummary.attribution?.cidr || 'unknown'}`,
    `- Handle: ${incidentSummary.attribution?.handle || 'unknown'}`,
    `- Abuse Contacts: ${incidentSummary.attribution?.abuseEmails?.join(', ') || 'unknown'}`,
    '',
    '## Evidence',
    `- Client Address: ${incidentSummary.clientAddress || 'unknown'}`,
    `- Remote Address: ${incidentSummary.remoteAddress || 'unknown'}`,
    `- Forwarded For: ${incidentSummary.forwardedFor || 'unknown'}`,
    `- Cloudflare Connecting IP: ${incidentSummary.cfConnectingIp || 'unknown'}`,
    `- Cloudflare Ray: ${incidentSummary.cfRay || 'unknown'}`,
    `- Latest Path: ${incidentSummary.path || 'unknown'}`,
    `- Latest Method: ${incidentSummary.method || 'unknown'}`,
    '',
    '## Recommended Submission',
    '- Submit this report to your hosting provider, Cloudflare abuse contact, or upstream ISP abuse desk.',
    `- Attach the JSON evidence file: ${incidentSummary.evidenceJsonPath}`,
    `- Attach the timeline log: ${incidentSummary.timelinePath}`,
    `- Review denylist candidates: ${incidentSummary.denylistCandidatePath}`,
    `- Cloudflare custom list CSV: ${incidentSummary.cloudflareCustomListPath}`,
    `- Cloudflare WAF rule expression: ${incidentSummary.cloudflareWafExpressionPath}`,
    '',
    '## Latest Event Details',
    `\`\`\`json`,
    JSON.stringify(incidentSummary.latestEvent, null, 2),
    '```',
    '',
  ].join('\n');
}

interface IncidentSummary {
  incidentId: string;
  clientAddress: string | null;
  remoteAddress: string | null;
  forwardedFor: string | null;
  cfConnectingIp: string | null;
  cfRay: string | null;
  path: string | null;
  method: string | null;
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
  highestSeverity: SecuritySeverity;
  summary: string;
  latestEvent: SecurityEvent;
  attribution?: NetworkAttribution | null;
  evidenceJsonPath: string;
  timelinePath: string;
  abuseReportPath: string;
  denylistCandidatePath: string;
  cloudflareCustomListPath: string;
  cloudflareWafExpressionPath: string;
}

interface DenylistCandidate {
  ip: string;
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
  highestSeverity: SecuritySeverity;
  reasons: string[];
  suggestedAction: string;
  attribution?: NetworkAttribution | null;
}

function getSecurityLogDir(): string {
  return join(homedir(), '.mama', 'logs');
}

function getSecurityLogPath(): string {
  return join(getSecurityLogDir(), 'security-events.jsonl');
}

function getIncidentLogDir(): string {
  return join(getSecurityLogDir(), 'security-incidents');
}

function getDenylistJsonPath(): string {
  return join(getSecurityLogDir(), 'security-denylist-candidates.json');
}

function getDenylistTxtPath(): string {
  return join(getSecurityLogDir(), 'security-denylist-candidates.txt');
}

function getCloudflareCustomListCsvPath(): string {
  return join(getSecurityLogDir(), 'cloudflare-ip-list.csv');
}

function getCloudflareWafExpressionPath(): string {
  return join(getSecurityLogDir(), 'cloudflare-waf-expression.txt');
}

async function readIncidentSummary(path: string): Promise<IncidentSummary | null> {
  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content) as IncidentSummary;
  } catch {
    return null;
  }
}

async function writeDenylistCandidate(summary: IncidentSummary): Promise<void> {
  const ip = summary.clientAddress;
  if (!ip || ip === 'unknown' || isLocalAddress(ip)) {
    return;
  }

  const denylistJsonPath = getDenylistJsonPath();
  const denylistTxtPath = getDenylistTxtPath();
  const raw = await readFile(denylistJsonPath, 'utf8').catch(() => '[]');
  let candidates: DenylistCandidate[] = [];
  try {
    candidates = JSON.parse(raw) as DenylistCandidate[];
  } catch {
    candidates = [];
  }

  const existing = candidates.find((candidate) => candidate.ip === ip);
  const updated: DenylistCandidate = {
    ip,
    firstSeen: existing?.firstSeen || summary.firstSeen,
    lastSeen: summary.lastSeen,
    eventCount: Math.max(existing?.eventCount || 0, summary.eventCount),
    highestSeverity:
      existing && getRiskWeight(existing.highestSeverity) > getRiskWeight(summary.highestSeverity)
        ? existing.highestSeverity
        : summary.highestSeverity,
    reasons: Array.from(new Set([...(existing?.reasons || []), summary.summary])),
    suggestedAction: 'Review and block via Cloudflare/WAF if malicious activity is confirmed.',
    attribution: summary.attribution || existing?.attribution || null,
  };

  const next = candidates.filter((candidate) => candidate.ip !== ip);
  next.push(updated);
  next.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  await mkdir(getSecurityLogDir(), { recursive: true });
  await writeFile(denylistJsonPath, JSON.stringify(next, null, 2), 'utf8');
  await writeFile(denylistTxtPath, `${next.map((candidate) => candidate.ip).join('\n')}\n`, 'utf8');
  await writeCloudflareExports(next);
}

async function writeCloudflareExports(candidates: DenylistCandidate[]): Promise<void> {
  const csvLines = candidates.map((candidate) => {
    const reason = candidate.reasons[0] || 'security-monitor candidate';
    const description = `${candidate.highestSeverity}:${reason}`
      .replace(/[\r\n]+/g, ' ')
      .replace(/,/g, ';')
      .slice(0, 500);
    return `${candidate.ip},${description}`;
  });

  const expressionLines = [
    '# Cloudflare WAF custom rule expression',
    '# Create/import a custom IP list using cloudflare-ip-list.csv, then use:',
    'ip.src in $mama_security_blocklist',
  ];

  await writeFile(getCloudflareCustomListCsvPath(), `${csvLines.join('\n')}\n`, 'utf8');
  await writeFile(getCloudflareWafExpressionPath(), `${expressionLines.join('\n')}\n`, 'utf8');
}

async function preserveEvidence(event: SecurityEvent): Promise<IncidentSummary> {
  const incidentId = getIncidentId(event);
  const incidentDir = join(getIncidentLogDir(), incidentId);
  const summaryPath = join(incidentDir, 'incident.json');
  const timelinePath = join(incidentDir, 'timeline.jsonl');
  const abuseReportPath = join(incidentDir, 'abuse-report.md');
  const attribution = await lookupNetworkAttribution(
    event.clientAddress || event.remoteAddress || ''
  );

  await mkdir(incidentDir, { recursive: true });
  await appendFile(timelinePath, `${JSON.stringify(event)}\n`, 'utf8');

  const previous = await readIncidentSummary(summaryPath);
  const highestSeverity =
    previous && getRiskWeight(previous.highestSeverity) > getRiskWeight(event.severity)
      ? previous.highestSeverity
      : event.severity;

  const summary: IncidentSummary = {
    incidentId,
    clientAddress: event.clientAddress || previous?.clientAddress || null,
    remoteAddress: event.remoteAddress || previous?.remoteAddress || null,
    forwardedFor: event.forwardedFor || previous?.forwardedFor || null,
    cfConnectingIp: event.cfConnectingIp || previous?.cfConnectingIp || null,
    cfRay: event.cfRay || previous?.cfRay || null,
    path: event.path || previous?.path || null,
    method: event.method || previous?.method || null,
    firstSeen: previous?.firstSeen || event.timestamp || new Date().toISOString(),
    lastSeen: event.timestamp || new Date().toISOString(),
    eventCount: (previous?.eventCount || 0) + 1,
    highestSeverity,
    summary: `${event.message} (${event.type})`,
    latestEvent: event,
    attribution: previous?.attribution || attribution,
    evidenceJsonPath: summaryPath,
    timelinePath,
    abuseReportPath,
    denylistCandidatePath: getDenylistJsonPath(),
    cloudflareCustomListPath: getCloudflareCustomListCsvPath(),
    cloudflareWafExpressionPath: getCloudflareWafExpressionPath(),
  };

  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  await writeFile(abuseReportPath, formatAbuseReport(incidentId, summary), 'utf8');
  await writeDenylistCandidate(summary);

  return summary;
}

export function setSecurityAlertSender(sender: SecurityAlertSender | null): void {
  alertSender = sender;
  if (sender) {
    logger.info('Security alert sender registered');
  }
}

export function resetSecurityMonitorForTests(): void {
  alertSender = null;
  lastAlertAt.clear();
  suspicionScores.clear();
  incidentIds.clear();
  attributionCache.clear();
}

export async function flushSecurityMonitor(): Promise<void> {
  if (pendingTasks.size === 0) {
    return;
  }
  await Promise.allSettled([...pendingTasks]);
}

export function formatSecurityAlert(event: SecurityEvent): string {
  const incidentId = getIncidentId(event);
  const incidentDir = join(getIncidentLogDir(), incidentId);
  const lines = [
    `🚨 [Security] ${event.message}`,
    `type: ${event.type}`,
    `severity: ${event.severity}`,
    `client: ${event.clientAddress || event.remoteAddress || 'unknown'}`,
  ];

  if (event.path) {
    lines.push(`path: ${event.path}`);
  }
  if (event.method) {
    lines.push(`method: ${event.method}`);
  }
  if (event.cfRay) {
    lines.push(`cfRay: ${event.cfRay}`);
  }
  if (event.details && Object.keys(event.details).length > 0) {
    lines.push(`details: ${JSON.stringify(event.details)}`);
  }
  lines.push(`evidence: ${join(incidentDir, 'incident.json')}`);
  lines.push(`abuse_draft: ${join(incidentDir, 'abuse-report.md')}`);
  lines.push(`denylist: ${getDenylistJsonPath()}`);
  lines.push(`cloudflare_csv: ${getCloudflareCustomListCsvPath()}`);
  lines.push(`cloudflare_waf: ${getCloudflareWafExpressionPath()}`);

  return lines.join('\n');
}

export function recordSecurityEvent(event: SecurityEvent): void {
  const normalized: SecurityEvent = {
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
  };

  rememberSuspiciousClient(
    normalized.clientAddress || normalized.remoteAddress,
    normalized.severity
  );

  logger.warn(`[SECURITY] ${normalized.message}`, normalized);

  trackBackgroundTask(
    appendSecurityLog(normalized).catch((error) => {
      logger.error('Failed to append security event log', error);
    })
  );

  trackBackgroundTask(
    preserveEvidence(normalized)
      .then(() => undefined)
      .catch((error) => {
        logger.error('Failed to preserve security evidence', error);
      })
  );

  if (!shouldSendAlert(normalized) || !alertSender) {
    return;
  }

  trackBackgroundTask(
    alertSender(normalized).catch((error) => {
      logger.error('Failed to deliver security alert', error);
    })
  );
}

export function createSecurityMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const clientAddress = getClientAddressFromRequestLike(req);
    const pathname = getPathFromRequestLike(req);

    if (isHoneypotPath(pathname) && !isLocalAddress(clientAddress)) {
      const delayMs = Math.max(HONEYPOT_DELAY_MS, getTarpitDelayMs(clientAddress));
      recordSecurityEvent({
        type: 'honeypot_hit',
        severity: 'critical',
        message: 'Honeypot path accessed',
        clientAddress,
        remoteAddress: req.socket?.remoteAddress || null,
        forwardedFor:
          typeof req.headers['x-forwarded-for'] === 'string'
            ? req.headers['x-forwarded-for']
            : null,
        cfConnectingIp:
          typeof req.headers['cf-connecting-ip'] === 'string'
            ? req.headers['cf-connecting-ip']
            : null,
        cfRay: typeof req.headers['cf-ray'] === 'string' ? req.headers['cf-ray'] : null,
        method: req.method,
        path: pathname,
        viaTunnel: !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']),
        details: { delayMs },
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      res.status(404).type('text/plain').send('Not Found');
      return;
    }

    const delayMs = getTarpitDelayMs(clientAddress);
    if (delayMs > 0 && pathname !== '/health') {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    next();
  };
}

export {
  getCloudflareCustomListCsvPath,
  getCloudflareWafExpressionPath,
  getDenylistJsonPath,
  getDenylistTxtPath,
  getIncidentLogDir,
  getSecurityLogPath,
};
