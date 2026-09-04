/**
 * repair_request: the agent files a code-defect report the developer session picks up.
 *
 * The bundle is a markdown file under ~/.mama/repairs/, DELIBERATELY outside the private
 * workspace root, so resolvePrivateWorkspaceFile refuses it and no send or upload tool can
 * move it out. It carries a log WINDOW (path + range), never log content, and every
 * model-authored field passes the same redaction gate operational issues use: the model
 * read connector data this turn, and anything it types can carry it. This module never
 * spawns, signals, edits config, or restarts anything - a source-text test pins that.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { redactIssueError } from '../observability/operational-issues.js';

export interface RepairRequestInput {
  issue_id: string;
  title: string;
  symptom: string;
  impact: string;
  evidence?: {
    run_ids?: string[];
    trace_ids?: string[];
    /** A WINDOW, never log content: file path plus from/to ISO timestamps. */
    log_window?: { file: string; from: string; to: string };
    queries?: string[];
  };
  reproduction: string;
  attempted: string;
}

export interface RepairBundleResult {
  repairId: string;
  path: string;
  created: boolean;
}

const ISSUE_ID = /^iss_[0-9a-f]{16}$/;
const SAFE_ID = /^[A-Za-z0-9_:.-]{1,120}$/;
const MAX_FIELD = 4_000;

export function resolveRepairRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.MAMA_REPAIRS_DIR || join(homedir(), '.mama', 'repairs'));
}

function field(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`repair_request: ${name} is required`);
  }
  return redactIssueError(value.slice(0, MAX_FIELD));
}

function idList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.filter((v): v is string => typeof v === 'string' && SAFE_ID.test(v)).slice(0, 20);
}

export function repairIdFor(issueId: string): string {
  return `rep_${createHash('sha1').update(issueId).digest('hex').slice(0, 16)}`;
}

/** Writes the bundle once per issue; a second request returns the existing id, created:false. */
export function writeRepairBundle(
  input: RepairRequestInput,
  root: string,
  nowMs: number = Date.now()
): RepairBundleResult {
  if (typeof input.issue_id !== 'string' || !ISSUE_ID.test(input.issue_id)) {
    throw new Error('repair_request: issue_id must be an operational issue id (iss_<16 hex>)');
  }
  const realRoot = resolve(root);
  const repairId = repairIdFor(input.issue_id);
  const path = resolve(realRoot, `${repairId}.md`);
  if (path !== realRoot && !path.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`repair_request: refusing to write outside ${realRoot}`);
  }
  if (existsSync(path)) {
    return { repairId, path, created: false };
  }
  const title = field(input.title, 'title');
  const symptom = field(input.symptom, 'symptom');
  const impact = field(input.impact, 'impact');
  const reproduction = field(input.reproduction, 'reproduction');
  const attempted = field(input.attempted, 'attempted');
  const evidence = input.evidence ?? {};
  const runIds = idList(evidence.run_ids);
  const traceIds = idList(evidence.trace_ids);
  const queries = Array.isArray(evidence.queries)
    ? evidence.queries
        .filter((q): q is string => typeof q === 'string' && q.trim() !== '')
        .slice(0, 10)
        .map((q) => redactIssueError(q.slice(0, 500)))
    : [];
  const window = evidence.log_window;
  const logWindow =
    window &&
    typeof window.file === 'string' &&
    typeof window.from === 'string' &&
    typeof window.to === 'string'
      ? `- log window: ${redactIssueError(window.file.slice(0, 300))} from ${window.from.slice(0, 40)} to ${window.to.slice(0, 40)} (read the log yourself; no content is embedded)`
      : '- log window: (none)';
  const createdAt = new Date(nowMs).toISOString();
  const body = [
    '---',
    `repair_id: ${repairId}`,
    `issue_id: ${input.issue_id}`,
    `created_at: ${createdAt}`,
    'status: requested',
    '---',
    '',
    `# ${title}`,
    '',
    '## Symptom',
    symptom,
    '',
    '## Impact',
    impact,
    '',
    '## Evidence',
    `- run ids: ${runIds.length ? runIds.join(', ') : '(none)'}`,
    `- trace ids: ${traceIds.length ? traceIds.join(', ') : '(none)'}`,
    logWindow,
    ...(queries.length ? ['- queries:', ...queries.map((q) => `  - ${q}`)] : ['- queries: (none)']),
    '',
    '## Reproduction',
    reproduction,
    '',
    '## Attempted',
    attempted,
    '',
    '## Repair',
    'Filed by the MAMA self-check turn. A development session lands the fix through tests, a',
    'PR and a release; the agent never edits or restarts its own daemon.',
    '',
  ].join('\n');
  mkdirSync(realRoot, { recursive: true });
  writeFileSync(path, body, { encoding: 'utf-8', flag: 'wx' });
  return { repairId, path, created: true };
}
