/**
 * Brief files - the procedural knowledge of the Stage-2 workers.
 *
 * Location: ~/.mama/briefs/brief-<kind>.md - a DEDICATED directory, not
 * ~/.mama/skills/ (plan A5/F5: skills-root flat files leak into the chat
 * system prompt, the skills UI, and PromptEnhancer keyword injection; the
 * consumer reads by path, so loader invisibility is the desired property).
 *
 * Missing brief -> the caller fails the workorder loudly (never a silent
 * skip). Seeding of packaged defaults is ensureBriefs() (S2-T5).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WORKORDER_KINDS, type WorkOrderKind } from './task-ledger.js';
// Persona constants are generic procedure text (no personal content); they
// relocate INTO this file when the persona modules are deleted at cutover.
import { DASHBOARD_AGENT_PERSONA } from '../multi-agent/dashboard-agent-persona.js';
import { WIKI_AGENT_PERSONA } from '../multi-agent/wiki-agent-persona.js';
import { buildTemporalWorkerBrief } from './temporal-worker.js';
import {
  resolveWorkOrderPrivateSurface,
  type PrivateConnectorPolicy,
} from '../connectors/private-connector-policy.js';
import {
  buildPrivatePromptOverlay,
  stripDisabledPrivatePromptRecipes,
  stripMarkedPrivatePromptOverlays,
} from '../connectors/private-prompt-overlay.js';

const LEGACY_PRIVATE_LINES: Readonly<Record<WorkOrderKind, ReadonlySet<string>>> = {
  board: new Set([
    '- kagemusha_tasks({status?}) -- the bridge task board. Statuses are real lifecycle states: pending, in_progress, review, done, completed, cancelled, dismissed. Includes title, priority, deadline, source_room, confirmed.',
    '- kagemusha_overview() -- room/task/message counts for the stat line',
    '- kagemusha_entities({channel?, activeOnly?}) -- list rooms/people with activity stats; find the busiest rooms',
    '- kagemusha_messages({channelId, since?, limit?}) -- read recent raw messages from a room for deltas and evidence',
    "- context_compile({task, connectors?, limit?, max_tool_calls?, strictness?}) -- compile a scoped evidence packet for the board. Trello is external connector evidence and is available only through context_compile; when intentionally isolating Trello, pass connectors: ['trello']. Never treat kagemusha_* as Trello.",
    '- kagemusha_tasks is the read-only project-task truth. task_list/task_create/task_update is YOUR task board (you maintain its data) and the pipeline projection source. Never infer or copy lifecycle status across those stores.',
    '- Never copy Trello or Kagemusha lifecycle status into your task board.',
    '- Project-task completion/progress comes ONLY from kagemusha_tasks. NEVER infer a project task\'s state from message archaeology ("no approval message found" is not a status).',
    '- Never copy Trello or Kagemusha lifecycle status into the native ledger.',
    '1. Read the REAL task state first: kagemusha_tasks({}) for open work, plus kagemusha_tasks({status: "review"}) and kagemusha_tasks({status: "pending"}) slices; kagemusha_overview() for the stat line',
    '2. Gather deltas: kagemusha_entities({activeOnly: true}), then kagemusha_messages({channelId, since}) on the busiest 2-3 rooms (since = ISO timestamp for the last 24-48h) for what changed since the last board',
    '- Use kagemusha_tasks for owner work.',
  ]),
  wiki: new Set(),
  'memory-curation': new Set([
    '2. kagemusha_entities({activeOnly: true}) to find the rooms active since the',
    'boundary, then kagemusha_messages({channelId, since: <boundary ISO>}) on',
    'the busiest 3-4 rooms.',
  ]),
  temporal: new Set([
    '- Kagemusha is read-only project truth. Do not copy its lifecycle state into the native task.',
  ]),
};

export function briefsDir(homeDir: string = homedir()): string {
  return join(homeDir, '.mama', 'briefs');
}

export function briefPath(kind: WorkOrderKind, homeDir: string = homedir()): string {
  return join(briefsDir(homeDir), `brief-${kind}.md`);
}

/** Sidecar recording WHICH packaged seed each brief file was written from. */
export function briefSeedManifestPath(homeDir: string = homedir()): string {
  return join(briefsDir(homeDir), 'seed-manifest.json');
}

/** null = missing (caller fails the workorder); read errors propagate loudly. */
export function loadBrief(kind: WorkOrderKind, homeDir: string = homedir()): string | null {
  const path = briefPath(kind, homeDir);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

const stripManagedMarker = (persona: string): string =>
  persona.replace(/^<!-- MAMA managed [^\n]*-->\n*/, '');

const BOARD_WORKORDER_CONTRACT = `
## Work order contract (Stage 2)
This managed contract supersedes any earlier Stage-2 instructions in this brief.

Your work order input is a JSON object:
- mode: "full" | "reconcile"
- force: true when the owner explicitly requested a fresh board - do NOT reply
  NO_UPDATE; rebuild and publish even if nothing changed.
- repairGeneration: the host-captured Board repair generation.
- noUpdateScope: the exact host-authored scope for a full-run no-op.
- deltaWatermark: host bookkeeping for the scheduler's delta gate. Ignore it.
- channelKey + deltaLines: present in reconcile mode only.
- attempts: retry counter (informational).

mode "full" = the scheduled board rewrite. Before writing, check whether an
update is needed: agent_notices({limit: 100}) for the last board publish
boundary, then a recency check (mama_search({limit: 30}) with NO query,
compare created_at). If nothing substantive is newer and force is not set,
call contract_no_update({reason, scope: input.noUpdateScope}) with that exact
scope when noUpdateScope is present, then respond NO_UPDATE and stop. When
noUpdateScope is absent, respond NO_UPDATE and stop without calling
contract_no_update; do not substitute or derive another scope. Otherwise follow
"How to Write" and publish ALL
FOUR slots in ONE report_publish({slots: {briefing, action_required, decisions, pipeline}}) call.

mode "reconcile" = a single-channel delta reconcile for input.channelKey using
input.deltaLines. Apply the RECONCILE RUN rules from this brief (the mode
field replaces the "RECONCILE RUN" message sentinel): judge affected slots,
publish ONLY those, use task_create/task_update with source_channel and
source_event_id from the delta, or contract_no_update({reason, scope:
"reconcile:<channelKey>"}) when nothing is affected. Finish with exactly one
line: RECONCILED <comma-separated slots or none>.

When a reconcile payload contains candidates, they are host-authored immutable
evidence; deltaLines are only human-readable context. Name every candidate by
its candidateId and make exactly one candidate-bound decision per candidate:
use task_external_bind for a binding candidate (choose bind or decline), or
task_lifecycle_reconcile for a lifecycle candidate (choose apply or retain).
The available choices are bind/decline/apply/retain. Use your judgment; the
host does not prescribe an outcome or tool order. You must not use task_update for status or latest_event changes to a candidate task. Do not invent candidates, ids,
statuses, or evidence. When there are no candidates, preserve ordinary reconcile
behavior unchanged.
`;

const MANAGED_BOARD_CONTRACT_START = '<!-- MAMA managed board work-order contract v1:start -->';
const MANAGED_BOARD_CONTRACT_END = '<!-- MAMA managed board work-order contract v1:end -->';
const MANAGED_BOARD_WORKORDER_CONTRACT = [
  MANAGED_BOARD_CONTRACT_START,
  BOARD_WORKORDER_CONTRACT.trim(),
  MANAGED_BOARD_CONTRACT_END,
].join('\n');

const WIKI_WORKORDER_CONTRACT = `
## Work order contract (Stage 2)
Your work order input is a JSON object: { batchId, events, attempts }.
The events array names what triggered this compile (extraction:completed,
memory:promoted, boot, manual) - provenance only, it carries no content.
Follow the MANDATORY Workflow exactly; the novelty check decides NO_UPDATE.
`;

const PROMOTION_BRIEF = `You are curating durable business memory from recent data (PROMOTION RUN).

## Work order contract (Stage 2)
Your work order input is a JSON object: { scheduledAt, attempts }. Use
scheduledAt as the current time reference.

## Procedure
1. agent_notices({limit: 100}): find your latest promotion notice (action
   "promoted" or "no_update") and treat it as the boundary; default to the
   last 24h when absent.
2. Use the business-data readers present in this run's catalog to find active
   channels since the boundary, then inspect the busiest 3-4 channels without
   widening the boundary.
3. For each candidate judgment, mama_search first to find the existing topic;
   reuse it so the evolution chain stays intact.
4. Promote at most 5 durable judgments per run via mama_save: pricing/scope
   agreements, standing client preferences, process rules, recurring risk
   patterns. NEVER task lifecycle states, greetings, or logistics. Include
   scopes (the source channel, and the project when identifiable) and
   event_date.
5. Finish with exactly PROMOTED <n> or NO_UPDATE.
`;

export function buildDefaultBrief(kind: WorkOrderKind): string {
  switch (kind) {
    case 'board':
      return `${stripManagedMarker(DASHBOARD_AGENT_PERSONA)}\n\n${MANAGED_BOARD_WORKORDER_CONTRACT}\n`;
    case 'wiki':
      return `${stripManagedMarker(WIKI_AGENT_PERSONA)}\n${WIKI_WORKORDER_CONTRACT}`;
    case 'memory-curation':
      return PROMOTION_BRIEF;
    case 'temporal':
      return buildTemporalWorkerBrief();
  }
}

function stripLegacyPrivateLines(kind: WorkOrderKind, raw: string): string {
  const legacyLines = LEGACY_PRIVATE_LINES[kind];
  const parts = raw.split(/(\r?\n)/);
  let projected = '';
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? '';
    const separator = parts[index + 1] ?? '';
    if (!legacyLines.has(line)) {
      projected += line + separator;
    }
  }
  return projected;
}

interface MarkdownFence {
  marker: '`' | '~';
  length: number;
}

function openingMarkdownFence(line: string): MarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match?.[1]) return null;
  return {
    marker: match[1][0] as '`' | '~',
    length: match[1].length,
  };
}

function closesMarkdownFence(line: string, fence: MarkdownFence): boolean {
  const marker = fence.marker === '`' ? '\\`' : '~';
  return new RegExp(`^ {0,3}${marker}{${fence.length},}[ \\t]*$`).test(line);
}

function findManagedBoardContracts(raw: string): Array<{ start: number; end: number }> {
  let fence: MarkdownFence | null = null;
  let pending: { start: number; version: string } | null = null;
  const contracts: Array<{ start: number; end: number }> = [];
  let lineStart = 0;

  while (lineStart < raw.length) {
    const newline = raw.indexOf('\n', lineStart);
    const nextLineStart = newline === -1 ? raw.length : newline + 1;
    let contentEnd = newline === -1 ? raw.length : newline;
    if (contentEnd > lineStart && raw[contentEnd - 1] === '\r') {
      contentEnd -= 1;
    }
    const line = raw.slice(lineStart, contentEnd);

    if (fence) {
      if (closesMarkdownFence(line, fence)) {
        fence = null;
      }
    } else {
      const openingFence = openingMarkdownFence(line);
      if (openingFence) {
        fence = openingFence;
      } else {
        const start = /^<!-- MAMA managed board work-order contract v(\d+):start -->$/.exec(line);
        if (start?.[1]) {
          pending = { start: lineStart, version: start[1] };
        } else if (pending) {
          const end = /^<!-- MAMA managed board work-order contract v(\d+):end -->$/.exec(line);
          if (end?.[1] === pending.version) {
            contracts.push({ start: pending.start, end: contentEnd });
            pending = null;
          }
        }
      }
    }

    lineStart = nextLineStart;
  }

  return contracts;
}

function projectCurrentBoardContract(raw: string): string {
  const managed = findManagedBoardContracts(raw);
  if (managed.length === 0) {
    const separator =
      raw.length === 0 ? '' : raw.endsWith('\n\n') ? '' : raw.endsWith('\n') ? '\n' : '\n\n';
    return `${raw}${separator}${MANAGED_BOARD_WORKORDER_CONTRACT}\n`;
  }

  let projected = '';
  let cursor = 0;
  for (const [index, contract] of managed.entries()) {
    projected += raw.slice(cursor, contract.start);
    if (index === 0) {
      projected += MANAGED_BOARD_WORKORDER_CONTRACT;
    }
    cursor = contract.end;
  }
  return projected + raw.slice(cursor);
}

/** Project a user-owned work-order brief for one run without changing its file. */
export function projectWorkOrderBriefForPrompt(
  kind: WorkOrderKind,
  raw: string,
  policy: PrivateConnectorPolicy
): string {
  const overlay = buildPrivatePromptOverlay(resolveWorkOrderPrivateSurface(kind), policy);
  const withoutMarkedOverlay = stripMarkedPrivatePromptOverlays(raw);
  const contracted =
    kind === 'board' ? projectCurrentBoardContract(withoutMarkedOverlay) : withoutMarkedOverlay;
  const projected = stripDisabledPrivatePromptRecipes(
    stripLegacyPrivateLines(kind, contracted),
    overlay.length > 0
  );
  if (!overlay) {
    return projected;
  }
  const separator = projected.endsWith('\n\n') ? '' : projected.endsWith('\n') ? '\n' : '\n\n';
  return `${projected}${separator}${overlay}\n`;
}

const SEED_MANIFEST_VERSION = 1;

interface BriefSeedManifest {
  version: number;
  seeds: Record<string, string>;
}

function seedHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** A manifest we cannot read is treated as absent: every brief is untracked
 *  (warn, never overwrite), which is the same safe state a pre-upgrade install
 *  is already in. Failing the boot here would strand the whole daemon over a
 *  bookkeeping file. */
function loadSeedManifest(homeDir: string): BriefSeedManifest & { corrupt: boolean } {
  const path = briefSeedManifestPath(homeDir);
  if (!existsSync(path)) return { version: SEED_MANIFEST_VERSION, seeds: {}, corrupt: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('seed manifest is not an object');
    }
    const seeds = (parsed as { seeds?: unknown }).seeds;
    if (typeof seeds !== 'object' || seeds === null || Array.isArray(seeds)) {
      throw new Error('seed manifest has no seeds map');
    }
    const projected: Record<string, string> = {};
    for (const [kind, hash] of Object.entries(seeds as Record<string, unknown>)) {
      if (typeof hash === 'string') projected[kind] = hash;
    }
    return { version: SEED_MANIFEST_VERSION, seeds: projected, corrupt: false };
  } catch (err) {
    console.warn(
      `[stage2] unreadable brief seed manifest (${path}); treating every brief as untracked: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    // corrupt: the caller REPLACES the file even when it records nothing new,
    // or tracking stays off forever and this warning repeats on every boot.
    return { version: SEED_MANIFEST_VERSION, seeds: {}, corrupt: true };
  }
}

function writeAtomically(path: string, content: string): void {
  // tmp+rename (PR bot round): a partial direct write would read as a
  // user-owned brief on the next boot and never be repaired.
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);
}

/**
 * Boot seeding (plan B2/C6/E9): write packaged defaults for MISSING briefs, and
 * re-seed briefs the owner never touched.
 *
 * The seed manifest records the hash of the seed each brief was written FROM,
 * which is what separates the two cases the old existsSync guard could not:
 * a file still byte-identical to its recorded seed is ours to upgrade, while
 * any other content is owner-owned and is never overwritten (Stage-3
 * self-improvement substrate). An owner-edited brief whose packaged seed has
 * since moved on gets ONE loud warning per boot so the owner can merge; the
 * recorded hash deliberately stays on the seed they forked from, otherwise the
 * warning would silence itself before the merge happened.
 *
 * A file byte-identical to the CURRENT packaged seed is recorded as such
 * whatever the manifest said, because that record is a statement about the
 * bytes, not a claim about who wrote them. This is what recovers the crash
 * window between the brief write and the manifest write, and it lets a
 * genuinely untouched pre-upgrade brief rejoin tracking.
 *
 * Any OTHER brief with no manifest entry (pre-upgrade install) is never
 * overwritten and never recorded: we cannot tell an old seed from an edited
 * one, so both possible records would be a false claim. The warning names the
 * file and the opt-in (delete it to re-seed).
 *
 * Returns the kinds whose files this call wrote.
 */
export function ensureBriefs(homeDir: string = homedir()): WorkOrderKind[] {
  mkdirSync(briefsDir(homeDir), { recursive: true });
  const manifest = loadSeedManifest(homeDir);
  const written: WorkOrderKind[] = [];
  let manifestChanged = manifest.corrupt;

  for (const kind of WORKORDER_KINDS) {
    const path = briefPath(kind, homeDir);
    const seed = buildDefaultBrief(kind);
    const packagedHash = seedHash(seed);

    if (!existsSync(path)) {
      writeAtomically(path, seed);
      manifest.seeds[kind] = packagedHash;
      manifestChanged = true;
      written.push(kind);
      console.log(`[stage2] seeded default brief: ${path}`);
      continue;
    }

    const recordedHash = manifest.seeds[kind];
    if (recordedHash === packagedHash) continue;

    const currentHash = seedHash(readFileSync(path, 'utf-8'));
    if (currentHash === packagedHash) {
      // Already the current seed byte-for-byte: nothing to write, and the
      // record is true regardless of what the manifest claimed before.
      manifest.seeds[kind] = packagedHash;
      manifestChanged = true;
      continue;
    }

    if (recordedHash === undefined) {
      console.warn(
        `[stage2] brief ${path} predates seed tracking: it will never be upgraded ` +
          `automatically. Delete the file to re-seed it from the packaged default.`
      );
      continue;
    }

    if (currentHash === recordedHash) {
      writeAtomically(path, seed);
      manifest.seeds[kind] = packagedHash;
      manifestChanged = true;
      written.push(kind);
      console.log(`[stage2] re-seeded untouched brief: ${path}`);
      continue;
    }

    console.warn(
      `[stage2] brief ${path} is owner-edited and the packaged default has changed. ` +
        `Your edits win - nothing was overwritten - but merge the new packaged brief ` +
        `manually, or delete the file to re-seed it.`
    );
  }

  if (manifestChanged) {
    writeAtomically(
      briefSeedManifestPath(homeDir),
      `${JSON.stringify({ version: SEED_MANIFEST_VERSION, seeds: manifest.seeds }, null, 2)}\n`
    );
  }
  return written;
}
