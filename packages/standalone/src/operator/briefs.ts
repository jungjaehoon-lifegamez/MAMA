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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WORKORDER_KINDS, type WorkOrderKind } from './task-ledger.js';
// Persona constants are generic procedure text (no personal content); they
// relocate INTO this file when the persona modules are deleted at cutover.
import { DASHBOARD_AGENT_PERSONA } from '../multi-agent/dashboard-agent-persona.js';
import { WIKI_AGENT_PERSONA } from '../multi-agent/wiki-agent-persona.js';
import { buildTemporalWorkerBrief } from './temporal-worker.js';
import type {
  ConnectorCapabilitySurface,
  PrivateConnectorPolicy,
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
Your work order input is a JSON object:
- mode: "full" | "reconcile"
- force: true when the owner explicitly requested a fresh board - do NOT reply
  NO_UPDATE; rebuild and publish even if nothing changed.
- channelKey + deltaLines: present in reconcile mode only.
- attempts: retry counter (informational).

mode "full" = the scheduled board rewrite. Before writing, check whether an
update is needed: agent_notices({limit: 100}) for the last board publish
boundary, then a recency check (mama_search({limit: 30}) with NO query,
compare created_at). If nothing substantive is newer and force is not set,
respond NO_UPDATE and stop. Otherwise follow "How to Write" and publish ALL
FOUR slots in ONE report_publish call.

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
      return `${stripManagedMarker(DASHBOARD_AGENT_PERSONA)}\n${BOARD_WORKORDER_CONTRACT}`;
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

function workOrderSurface(kind: WorkOrderKind): ConnectorCapabilitySurface {
  switch (kind) {
    case 'board':
      return 'workorder-board';
    case 'memory-curation':
      return 'workorder-memory-curation';
    case 'temporal':
      return 'workorder-temporal';
    case 'wiki':
      return 'multi-agent-generic';
  }
}

/** Project a user-owned work-order brief for one run without changing its file. */
export function projectWorkOrderBriefForPrompt(
  kind: WorkOrderKind,
  raw: string,
  policy: PrivateConnectorPolicy
): string {
  const overlay = buildPrivatePromptOverlay(workOrderSurface(kind), policy);
  const projected = stripDisabledPrivatePromptRecipes(
    stripLegacyPrivateLines(kind, stripMarkedPrivatePromptOverlays(raw)),
    overlay.length > 0
  );
  if (!overlay) {
    return projected;
  }
  const separator = projected.endsWith('\n\n') ? '' : projected.endsWith('\n') ? '\n' : '\n\n';
  return `${projected}${separator}${overlay}\n`;
}

/**
 * Boot seeding (plan B2/C6/E9): write packaged defaults for MISSING briefs
 * only - user/agent edits always win (existsSync guard). DELIBERATE deviation
 * from the persona managed-marker pattern: briefs have NO auto-upgrade; after
 * seeding they are agent/user-owned (Stage-3 self-improvement substrate), so
 * packaged default changes do not propagate to existing installs.
 */
export function ensureBriefs(homeDir: string = homedir()): WorkOrderKind[] {
  mkdirSync(briefsDir(homeDir), { recursive: true });
  const seeded: WorkOrderKind[] = [];
  for (const kind of WORKORDER_KINDS) {
    const path = briefPath(kind, homeDir);
    if (!existsSync(path)) {
      // tmp+rename (PR bot round): a partial direct write would read as a
      // user-owned brief on the next boot and never be repaired.
      const tmpPath = `${path}.tmp`;
      writeFileSync(tmpPath, buildDefaultBrief(kind), 'utf-8');
      renameSync(tmpPath, path);
      seeded.push(kind);
      console.log(`[stage2] seeded default brief: ${path}`);
    }
  }
  return seeded;
}
