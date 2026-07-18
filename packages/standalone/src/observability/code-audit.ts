/**
 * Deterministic code-based system audit.
 *
 * Lands the 2026-04-22 owner decision (mama_conductor_audit_code_based_read_only):
 * the hourly audit is fact collection and recording, executed by code - no LLM
 * invocation, no auto-fix, no filesystem access beyond explicit read-only checks.
 * The previous LLM audit loop once exfiltrated a credential when its report
 * path failed; this module removes that class of failure structurally.
 *
 * Every check here is read-only and local. MAJOR findings are alerted through
 * a caller-provided callback subject to the 24h dedup contract the checklist
 * established (alert only NEW / ESCALATED / older-than-24h re-alerts). MINOR
 * and INFO findings are recorded in the state file, never alerted.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as yaml from 'js-yaml';

export type AuditSeverity = 'INFO' | 'MINOR' | 'MAJOR';

export interface AuditFinding {
  id: string;
  severity: AuditSeverity;
  summary: string;
  detail?: string;
}

interface StoredFinding {
  id: string;
  severity: AuditSeverity;
  summary?: string;
  detail?: string;
  first_seen: string;
  last_seen: string;
  last_alerted_at: string | null;
}

export interface AuditStateFile {
  audit_date: string;
  audit_timestamp: string;
  checklist_version: string;
  findings: StoredFinding[];
  resolved_since_last_run: string[];
  pass_items: string[];
}

export interface CodeAuditReport {
  mode: 'code';
  timestamp: string;
  duration_ms: number;
  findings: AuditFinding[];
  pass_items: string[];
  alerted: string[];
  alert_delivery_failures: string[];
  resolved_since_last_run: string[];
}

export type AuditAlertReason = 'new' | 'escalated' | 're-alert';

export interface CodeAuditConfigView {
  telegram?: { enabled?: boolean; allowed_chats?: string[] };
  multi_agent?: {
    enabled?: boolean;
    agents?: Record<string, { persona_file?: string; enabled?: boolean }>;
  };
  roles?: {
    sourceMapping?: Record<string, string>;
    definitions?: Record<string, unknown>;
  };
}

export interface CodeAuditOptions {
  /** Base dir for ~/.mama files. Tests inject a temp dir. */
  mamaDir?: string;
  /** Findings/dedup state file. Default: <mamaDir>/state/audit-findings.json */
  stateFilePath?: string;
  /** Daemon log whose size is checked. Default: <mamaDir>/logs/daemon.log */
  daemonLogPath?: string;
  /** Local health endpoint. Default: http://127.0.0.1:3847/health. '' disables. */
  healthUrl?: string;
  /** Loaded runtime config (already-validated view). */
  config?: CodeAuditConfigView;
  /** True when a security alert sender is registered (checklist hygiene item). */
  securityAlertConfigured?: boolean;
  /** MAJOR-only alert callback, invoked per the 24h dedup contract. */
  alert?: (finding: AuditFinding, reason: AuditAlertReason) => void | Promise<void>;
  /** Injectable clock for tests. */
  now?: () => Date;
}

const CHECKLIST_VERSION = 'code-2026-07-17';
const REALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MEMORY_WAL_LIMIT = 10 * 1024 * 1024;
const METRICS_WAL_LIMIT = 5 * 1024 * 1024;
const DAEMON_LOG_LIMIT = 50 * 1024 * 1024;
const SEVERITY_RANK: Record<AuditSeverity, number> = { INFO: 0, MINOR: 1, MAJOR: 2 };

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * First line of a parse error only, length-capped. js-yaml's YAMLException
 * message embeds a source snippet of the malformed file; config files hold
 * tokens, so the snippet must never travel into alert payloads.
 */
function sanitizeParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 200);
}

function checkParseable(
  path: string,
  kind: 'yaml' | 'json',
  findings: AuditFinding[],
  passes: string[]
): void {
  const name = basename(path);
  if (!existsSync(path)) {
    passes.push(`${name}: absent (nothing to validate)`);
    return;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    if (kind === 'yaml') {
      yaml.load(raw);
    } else {
      JSON.parse(raw);
    }
    passes.push(`${name}: valid ${kind.toUpperCase()}`);
  } catch (error) {
    findings.push({
      id: `config-parse-${name}`,
      severity: 'MAJOR',
      summary: `${name} is not valid ${kind.toUpperCase()}`,
      detail: sanitizeParseError(error),
    });
  }
}

function checkFileSizeLimit(
  id: string,
  path: string,
  limit: number,
  severity: AuditSeverity,
  findings: AuditFinding[],
  passes: string[]
): void {
  const size = fileSize(path);
  const name = basename(path);
  if (size === null) {
    passes.push(`${name}: absent`);
    return;
  }
  const mb = (size / 1024 / 1024).toFixed(1);
  const limitMb = (limit / 1024 / 1024).toFixed(0);
  if (size < limit) {
    passes.push(`${name}: ${mb}MB < ${limitMb}MB limit`);
  } else {
    findings.push({
      id,
      severity,
      summary: `${name} is ${mb}MB (limit ${limitMb}MB)`,
    });
  }
}

async function checkHealthEndpoint(
  url: string,
  findings: AuditFinding[],
  passes: string[]
): Promise<void> {
  let outcome: { ok: boolean; detail: string };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    let structurallyOk = false;
    try {
      const parsed = JSON.parse(body) as { status?: unknown };
      structurallyOk = parsed.status === 'ok';
    } catch {
      structurallyOk = false;
    }
    outcome = {
      ok: res.status === 200 && structurallyOk,
      detail: `HTTP ${res.status} ${body.slice(0, 120)}`,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    outcome = {
      ok: false,
      detail: aborted ? 'timeout after 3s' : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }

  if (outcome.ok) {
    passes.push(`health endpoint: ${outcome.detail}`);
  } else {
    findings.push({
      id: 'health-endpoint',
      severity: 'MAJOR',
      summary: 'Local /health endpoint is not answering ok',
      detail: outcome.detail,
    });
  }
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

async function readState(stateFilePath: string): Promise<StoredFinding[]> {
  let raw: string;
  try {
    raw = await readFile(stateFilePath, 'utf8');
  } catch (error) {
    // Missing file is the normal first run. Anything else (EACCES, EIO) is a
    // real system problem: fail the audit run loudly instead of silently
    // resetting dedup history - the subsequent state write would fail anyway.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { findings?: StoredFinding[] };
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch (error) {
    // Corrupt state is NOT silent: dedup history is lost, so every current
    // MAJOR re-alerts as new. Over-alerting is the safe direction, but the
    // owner must be able to see why.
    console.warn(
      `[code-audit] audit state file is corrupt, resetting dedup history (${stateFilePath}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

export async function runCodeAudit(options: CodeAuditOptions = {}): Promise<CodeAuditReport> {
  const startedAt = Date.now();
  const now = options.now ? options.now() : new Date();
  const nowIso = now.toISOString();
  const mamaDir = options.mamaDir || join(homedir(), '.mama');
  const stateFilePath = options.stateFilePath || join(mamaDir, 'state', 'audit-findings.json');
  const daemonLogPath = options.daemonLogPath || join(mamaDir, 'logs', 'daemon.log');
  const healthUrl = options.healthUrl ?? 'http://127.0.0.1:3847/health';

  const findings: AuditFinding[] = [];
  const passes: string[] = [];

  // Config parse checks
  checkParseable(join(mamaDir, 'config.yaml'), 'yaml', findings, passes);
  checkParseable(join(mamaDir, 'config.json'), 'json', findings, passes);
  checkParseable(join(mamaDir, 'connectors.json'), 'json', findings, passes);

  // Size limits
  checkFileSizeLimit(
    'memory-db-wal',
    join(mamaDir, 'mama-memory.db-wal'),
    MEMORY_WAL_LIMIT,
    'MINOR',
    findings,
    passes
  );
  checkFileSizeLimit(
    'metrics-db-wal',
    join(mamaDir, 'mama-metrics.db-wal'),
    METRICS_WAL_LIMIT,
    'MINOR',
    findings,
    passes
  );
  checkFileSizeLimit('daemon-log-size', daemonLogPath, DAEMON_LOG_LIMIT, 'MINOR', findings, passes);

  // Health endpoint (self-check through the real server socket)
  if (healthUrl) {
    await checkHealthEndpoint(healthUrl, findings, passes);
  }

  // Persona files referenced by multi-agent config
  const agents = options.config?.multi_agent?.agents || {};
  const multiAgentEnabled = options.config?.multi_agent?.enabled === true;
  for (const [agentId, agent] of Object.entries(agents)) {
    if (!agent?.persona_file) {
      continue;
    }
    const personaPath = expandHome(agent.persona_file);
    if (existsSync(personaPath)) {
      passes.push(`persona ${agentId}: file exists`);
    } else {
      findings.push({
        id: `persona-missing-${agentId}`,
        severity: multiAgentEnabled ? 'MINOR' : 'INFO',
        summary: `Persona file for agent "${agentId}" is missing`,
        detail: personaPath,
      });
    }
  }

  // Security hygiene
  if (options.securityAlertConfigured === false) {
    findings.push({
      id: 'security-alert-channel-missing',
      severity: 'MINOR',
      summary:
        'No security alert channel configured (MAMA_SECURITY_ALERT_CHANNELS or gateway default)',
    });
  } else if (options.securityAlertConfigured === true) {
    passes.push('security alert channel configured');
  }

  const telegram = options.config?.telegram;
  if (telegram?.enabled) {
    if (Array.isArray(telegram.allowed_chats) && telegram.allowed_chats.length > 0) {
      passes.push(`telegram inbound allowlist: ${telegram.allowed_chats.length} chat(s)`);
    } else {
      findings.push({
        id: 'telegram-open-inbound',
        severity: 'MAJOR',
        summary: 'Telegram gateway accepts messages from ANY chat (allowed_chats unset)',
        detail: 'Set telegram.allowed_chats in config.yaml to the owner chat id(s).',
      });
    }
  }

  // owner_console must ONLY resolve via trust-conditional escalation (locked
  // allowlist + private DM). A static sourceMapping grants the owner surface
  // to unverified inbound - that is the open-console failure class.
  const sourceMapping = options.config?.roles?.sourceMapping ?? {};
  const staticOwnerSources = Object.entries(sourceMapping)
    .filter(([, roleName]) => roleName === 'owner_console')
    .map(([source]) => source);
  if (staticOwnerSources.length > 0) {
    findings.push({
      id: 'owner-console-static-mapping',
      severity: 'MAJOR',
      summary: `owner_console statically mapped to source(s): ${staticOwnerSources.join(', ')}`,
      detail:
        'Remove the mapping; owner_console is granted per-message by RoleManager trust checks only.',
    });
  } else {
    passes.push('owner_console has no static source mapping');
  }

  // The trust escalation silently no-ops when the owner_console definition is
  // missing from the RESOLVED roles config (an older persisted roles section
  // that skipped the additive merge). Locked allowlist + missing definition =
  // the flagship console is dead without a sound (review B1 class).
  if (
    Array.isArray(telegram?.allowed_chats) &&
    telegram.allowed_chats.length > 0 &&
    options.config?.roles?.definitions &&
    !('owner_console' in options.config.roles.definitions)
  ) {
    findings.push({
      id: 'owner-console-definition-missing',
      severity: 'MAJOR',
      summary: 'telegram allowlist is locked but roles.definitions lacks owner_console',
      detail:
        'Trust escalation falls through to chat_bot silently. The config loader should merge default definitions; check for a stale roles section.',
    });
  }

  // Stage-2 (plan B7): a CUSTOMIZED persisted owner_console definition freezes
  // its allowedTools at save time - new default tools (workorder_request/
  // status class) silently never reach it. Observe-only: warn the owner, no
  // forced merge (observability over restriction).
  const persistedOwnerConsole = options.config?.roles?.definitions?.owner_console as
    | { allowedTools?: string[] }
    | undefined;
  if (persistedOwnerConsole?.allowedTools && !persistedOwnerConsole.allowedTools.includes('*')) {
    // Wildcard allowlists cover everything - flagging them for "missing"
    // default tools would be a false positive (PR bot round).
    const { DEFAULT_ROLES } = await import('../cli/config/types.js');
    const defaultTools = DEFAULT_ROLES.definitions?.owner_console?.allowedTools ?? [];
    const missing = defaultTools.filter(
      (tool) => !persistedOwnerConsole.allowedTools?.includes(tool)
    );
    if (missing.length > 0) {
      findings.push({
        id: 'owner-console-stale-allowlist',
        severity: 'MAJOR',
        summary: `persisted owner_console.allowedTools lacks current default tool(s): ${missing.join(', ')}`,
        detail:
          'A customized owner_console definition does not receive new default tools. ' +
          'Add them to the persisted definition (or delete it to re-adopt defaults).',
      });
    } else {
      passes.push('owner_console allowlist covers all current default tools');
    }
  }

  // Telegram group/supergroup ids are negative. An allowlisted group does not
  // escalate (RoleManager requires chatType private) but signals a config
  // misunderstanding worth flagging.
  const groupChats = (telegram?.allowed_chats ?? []).filter((id) => String(id).startsWith('-'));
  if (groupChats.length > 0) {
    findings.push({
      id: 'telegram-allowlist-group-chat',
      severity: 'MINOR',
      summary: `telegram.allowed_chats contains group chat id(s): ${groupChats.join(', ')}`,
      detail:
        'Group members are third parties; groups never receive owner_console, but review whether the allowlist entry is intended.',
    });
  }

  // Dedup + alert per the 24h contract
  const previous = await readState(stateFilePath);
  const previousById = new Map(previous.map((f) => [f.id, f]));
  const alerted: string[] = [];
  const alertDeliveryFailures: string[] = [];
  const stored: StoredFinding[] = [];

  for (const finding of findings) {
    const prior = previousById.get(finding.id);
    const firstSeen = prior?.first_seen || nowIso;
    let lastAlertedAt = prior?.last_alerted_at ?? null;

    if (finding.severity === 'MAJOR') {
      let reason: AuditAlertReason | null = null;
      if (!prior) {
        reason = 'new';
      } else if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[prior.severity]) {
        // Reachable across checklist_version upgrades: when a check's grading
        // changes (e.g. a MINOR becomes MAJOR in a new release), the stored
        // lower severity escalates and must alert immediately instead of
        // waiting out a 24h window stamped under the old grading.
        reason = 'escalated';
      } else if (
        !prior.last_alerted_at ||
        now.getTime() - Date.parse(prior.last_alerted_at) >= REALERT_INTERVAL_MS
      ) {
        reason = 're-alert';
      }

      if (reason && options.alert) {
        try {
          await options.alert(finding, reason);
          alerted.push(finding.id);
          lastAlertedAt = nowIso;
        } catch (error) {
          // Fail loud in the report; the finding stays un-alerted so the next
          // run retries instead of silently swallowing delivery failure.
          alertDeliveryFailures.push(
            `${finding.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    stored.push({
      id: finding.id,
      severity: finding.severity,
      summary: finding.summary,
      detail: finding.detail,
      first_seen: firstSeen,
      last_seen: nowIso,
      last_alerted_at: lastAlertedAt,
    });
  }

  const currentIds = new Set(findings.map((f) => f.id));
  const resolved = previous.filter((f) => !currentIds.has(f.id)).map((f) => f.id);

  const state: AuditStateFile = {
    audit_date: nowIso.slice(0, 10),
    audit_timestamp: nowIso,
    checklist_version: CHECKLIST_VERSION,
    findings: stored,
    resolved_since_last_run: resolved,
    pass_items: passes,
  };

  await mkdir(dirname(stateFilePath), { recursive: true });
  await writeFile(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  return {
    mode: 'code',
    timestamp: nowIso,
    duration_ms: Date.now() - startedAt,
    findings,
    pass_items: passes,
    alerted,
    alert_delivery_failures: alertDeliveryFailures,
    resolved_since_last_run: resolved,
  };
}
