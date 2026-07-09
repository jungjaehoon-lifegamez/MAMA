/**
 * Operator report-run wiring + tool-use audit (M3 "Operator Hands").
 *
 * PURE half (this file, Task 1): classify the gateway tools the persona agent actually EXECUTED
 * during a report. Gateway calls are prompt-based ```tool_call blocks, parsed by AgentLoop into
 * tool_use blocks (agent-loop.ts:1218-1226,1330-1333); each execution's tool_result is pushed
 * into the NEXT user message (agent-loop.ts:1408-1411). We pair tool_use.id with its tool_result
 * and count executions only - errored results and envelope denials ("success":false /
 * envelope_missing, gateway-tool-executor.ts:1090-1142) do NOT count. History is read
 * structurally (no agent-internal imports) so the audit is trivially unit-testable.
 *
 * The audit powers two M3 guarantees:
 *   - no-fallback (GAP 1): a FULL report that EXECUTED no gateway gather tool (none emitted, or
 *     every call denied/errored) is WARNED loudly, never silently accepted as if it had
 *     task-board substance.
 *   - observability (GAP 2): every write (mama_save) is logged loudly.
 *
 * ASCII-only. No personal strings.
 */
import type { AskAgent } from './trigger-author.js';

/** Dedicated persona session lane for operator reports; isolates the multi-turn gather loop from
 *  chat. runWithContent honors options.sessionKey (agent-loop.ts:879). */
export const OPERATOR_REPORT_SESSION_KEY = 'operator:report';

/** Gateway READ tools the full report is instructed to gather with (gateway-tools.md:12,14,22-25). */
const GATHER_TOOLS = new Set<string>([
  'kagemusha_overview',
  'kagemusha_entities',
  'kagemusha_tasks',
  'kagemusha_messages',
  'mama_recall',
  'mama_search',
  'context_compile',
]);

/** Gateway WRITE tools. mama_save is the M3 hand; the rest are classified only for honest
 *  observability if they ever appear (report_publish/wiki_publish are NOT instructed in M3 -
 *  see plan finding F6). (gateway-tools.md:11,17,18,65,66) */
const WRITE_TOOLS = new Set<string>([
  'mama_save',
  'mama_add',
  'mama_ingest',
  'report_publish',
  'wiki_publish',
]);

/** Minimal structural view of AgentLoopResult.history (types.ts:1105). Structural on purpose:
 *  keeps this module free of agent-internal imports so tests use plain synthetic objects. */
export interface ReportHistoryMessage {
  role: string;
  content: unknown;
}

export interface ReportToolAudit {
  gatherTools: string[];
  writeTools: string[];
  all: string[];
}

/** True when a tool_result proves the call did NOT execute: errored, or denied by the envelope
 *  layer with {"success":false,...,"code":"envelope_missing"} (gateway-tool-executor.ts:1090-1142). */
function isErroredOrDenied(block: { is_error?: boolean; content?: unknown }): boolean {
  if (block.is_error === true) return true;
  const body =
    typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
  return /"success"\s*:\s*false/.test(body) || body.includes('envelope_missing');
}

/** Pair assistant tool_use blocks with their tool_result and classify EXECUTIONS as gather vs
 *  write. `all` inventories every emission (executed or not) for honest logging. */
export function summarizeReportToolUse(
  history: ReadonlyArray<ReportHistoryMessage>
): ReportToolAudit {
  // Pass 1: index result health by tool_use_id (results live in the user messages the agent loop
  // pushes after each tool batch - agent-loop.ts:1408-1411).
  const resultOkById = new Map<string, boolean>();
  for (const msg of history) {
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{
      type?: string;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }>) {
      if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      resultOkById.set(block.tool_use_id, !isErroredOrDenied(block));
    }
  }
  // Pass 2: classify assistant tool_use blocks; only a paired healthy result counts as executed.
  const gatherTools: string[] = [];
  const writeTools: string[] = [];
  const all: string[] = [];
  for (const msg of history) {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type?: string; id?: string; name?: string }>) {
      if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
      all.push(block.name);
      const executed = typeof block.id === 'string' && resultOkById.get(block.id) === true;
      if (!executed) continue;
      if (GATHER_TOOLS.has(block.name)) gatherTools.push(block.name);
      else if (WRITE_TOOLS.has(block.name)) writeTools.push(block.name);
    }
  }
  return { gatherTools, writeTools, all };
}

function uniq(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * Build the operator-log lines for one report.
 * isFullReport gates the no-fallback gather WARNING (only the FULL report is instructed to gather;
 * the digest is intentionally tool-free, so absence of gather tools there is normal).
 */
export function formatReportToolAudit(audit: ReportToolAudit, isFullReport: boolean): string[] {
  const lines: string[] = [];
  if (audit.writeTools.length > 0) {
    lines.push(`[trigger-loop] full report: agent wrote via ${uniq(audit.writeTools).join(', ')}`);
  }
  if (isFullReport) {
    if (audit.gatherTools.length === 0) {
      lines.push(
        '[trigger-loop] full report WARNING: agent executed NO gateway gather tools ' +
          '(none called, or every call errored/denied) - task-board substance NOT verified; ' +
          'the report may reflect native-tool, denied, or window-only gathering'
      );
    } else {
      lines.push(
        `[trigger-loop] full report: agent gathered via ${uniq(audit.gatherTools).join(', ')}`
      );
    }
  }
  return lines;
}

export interface PersonaReportRunResult {
  response: string;
  history: ReadonlyArray<ReportHistoryMessage>;
}
/** E = the envelope type; generic keeps this module free of agent/envelope imports while start.ts
 *  gets full inference (no casts): E is inferred from the injected issuer's return type. */
export interface PersonaReportRunner<E = unknown> {
  (prompt: string, envelope?: E): Promise<PersonaReportRunResult>;
}
export interface PersonaReportAskDeps<E = unknown> {
  run: PersonaReportRunner<E>;
  log: (line: string) => void;
  /** Marker that identifies a FULL report prompt (situation-report.OPERATOR_FULL_REPORT_TAG). */
  fullReportTag: string;
  /**
   * Issue a per-report scoped worker envelope. Gateway 'model_tool' executions are envelope-gated
   * (gateway-tool-executor.ts:252-256): without an envelope every call is denied with code
   * 'envelope_missing' (:1090-1142). Injected from start.ts (envelopeAuthority.buildAndPersist);
   * omit ONLY when issuance mode is 'off'. Failures propagate (no-fallback).
   */
  issueEnvelope?: () => Promise<E>;
}

/**
 * Build the report-composition AskAgent (M3). Envelope-first: gateway 'model_tool' executions are
 * envelope-gated (gateway-tool-executor.ts:252-256), so issue the per-report scoped envelope
 * BEFORE running - without one every call is denied with code 'envelope_missing' (:1090-1142),
 * the enforcement that killed the ancestor scheduled-report path. Issuance failure propagates
 * loudly (no-fallback; the buffer is kept and the next cadence retries). Then run the persona
 * agent (injected runner isolates the report into its own session lane and carries the envelope),
 * audit + log the gateway tools it actually EXECUTED (no-fallback WARNING when a full report
 * executed none; observability line for every write), and enforce the empty-report guard
 * (M2 semantics).
 */
export function createPersonaReportAsk<E = unknown>(deps: PersonaReportAskDeps<E>): AskAgent {
  return async (prompt: string): Promise<string> => {
    const envelope = deps.issueEnvelope ? await deps.issueEnvelope() : undefined;
    const { response, history } = await deps.run(prompt, envelope);
    const isFull = prompt.includes(deps.fullReportTag);
    for (const line of formatReportToolAudit(summarizeReportToolUse(history), isFull)) {
      deps.log(line);
    }
    if (!response || response.trim() === '') {
      throw new Error('persona agent returned an empty report response');
    }
    return response;
  };
}
