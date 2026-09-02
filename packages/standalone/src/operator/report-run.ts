/**
 * Operator report-run wiring + tool-use audit (M3 "Operator Hands").
 *
 * PURE half (this file, Task 1): classify the gateway tools the persona agent actually EXECUTED
 * during a report. Claude text-gateway calls and Codex native host calls are both recorded by
 * AgentLoop as assistant tool_use followed by user tool_result history entries. We pair
 * tool_use.id with its tool_result and count executions only - errored results and envelope
 * denials ("success":false /
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
import type { ArtifactProvenance } from './report-carry.js';
import type { OwnerReportContextV1 } from './report-context.js';

/** Dedicated persona session lane for fresh packet-only report composition. */
export const OPERATOR_REPORT_SESSION_KEY = 'operator:report';

/**
 * Gateway READ tools classified as gathers for the run audit. This is the
 * classification SUPERSET, not the instruction list: since the 2026-07-30
 * native-board flip the gather instructs `task_list` and the four
 * `kagemusha_*` tools are granted-but-silent (owner's personal deployment
 * only - the lane-wiring test pins that split).
 */
export const GATHER_TOOLS = new Set<string>([
  'kagemusha_overview',
  'kagemusha_entities',
  'kagemusha_tasks',
  'kagemusha_messages',
  'mama_recall',
  'mama_provenance',
  'mama_search',
  'context_compile',
  // What the system itself changed since the last report. Granted to this lane and then
  // never instructed, which is the same as not having it: a tool the report is never told
  // to call is a tool the report does not call, and the audit counted the run as having
  // gathered nothing from it because it never appeared.
  'changes_read',
  // Granted reads that were missing here, so a run that gathered through them was audited
  // as having gathered through nothing. The consequence is not a silent undercount: an
  // empty `gatherTools` fires the full-report WARNING claiming task-board substance was
  // NOT verified - a report that read the board via `trello_kanban` and `task_list` would
  // be accused of not having read it.
  'schedule_upcoming',
  'task_external_correlation',
  'task_list',
  'trello_kanban',
]);

/** Gateway WRITE tools. mama_save is the M3 hand; the rest are classified only for honest
 *  observability if they ever appear (report_publish/wiki_publish are NOT instructed in M3 -
 *  see plan finding F6). */
export const WRITE_TOOLS = new Set<string>(['mama_save', 'report_publish', 'wiki_publish']);

/** Local literal, deliberately NOT an import of code-act CODE_ACT_MARKER: this module keeps
 *  zero agent-internal imports so the audit stays unit-testable with plain synthetic objects.
 *  Must match code-act/constants.ts CODE_ACT_MARKER ('code_act'). */
const CODE_ACT_TOOL_NAME = 'code_act';

/**
 * Strip the `mcp__<server>__` prefix an MCP transport puts on tool names.
 *
 * Measured on the live install, 2026-07-29: every full report logged
 * "agent executed NO gateway gather tools - task-board substance NOT verified" while the
 * SAME run's trace rows showed task_list, trello_search, context_compile and
 * kagemusha_messages executing. The audit compared `block.name === 'code_act'` and the
 * history carried `mcp__code-act__code_act`, so the branch never ran, hostToolsInvoked was
 * never parsed, and the gather set stayed empty. The warning was not observing a silent
 * report - it was the audit failing to recognise the transport, and saying so in the report's
 * own voice every single time.
 */
export function stripMcpPrefix(name: string): string {
  const match = /^mcp__[A-Za-z0-9_-]+__(.+)$/.exec(name);
  return match ? match[1] : name;
}

/** Read only the host-authored top-level execution ledger. The versioned MCP wrapper and the
 * direct Gateway result both carry this field at their root. Sandbox value/log/message data is
 * deliberately never searched: all three are agent-controlled and can contain forged JSON. */
function parseHostToolsInvoked(content: unknown): string[] {
  const body = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    const root = parsed as Record<string, unknown>;
    const isVersionedMcpResult =
      root.protocol === 'mama.code_act.result' &&
      root.version === 1 &&
      typeof root.success === 'boolean';
    const isDirectGatewayResult =
      root.protocol === undefined &&
      typeof root.success === 'boolean' &&
      Array.isArray(root.hostToolExecutions);
    if (!isVersionedMcpResult && !isDirectGatewayResult) {
      return [];
    }
    if (!Array.isArray(root.hostToolExecutions)) {
      return [];
    }
    return root.hostToolExecutions.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return [];
      }
      const execution = entry as Record<string, unknown>;
      return execution.success === true && typeof execution.name === 'string'
        ? [execution.name]
        : [];
    });
  } catch {
    return [];
  }
}

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
 *  layer with {"success":false,...,"code":"envelope_missing"} (gateway-tool-executor.ts:1090-1142).
 *  The gateway loop serializes the tool-result OBJECT as the content (JSON.stringify in
 *  executeTools), so parse and inspect the ROOT properties first - a substring regex alone
 *  false-positives on a SUCCESSFUL result whose nested payload merely mentions
 *  '"success":false' (PR #119 review). The substring heuristic remains only as the
 *  conservative fallback for unparseable content. */
function isErroredOrDenied(block: { is_error?: boolean; content?: unknown }): boolean {
  if (block.is_error === true) {
    return true;
  }
  const body =
    typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const root = parsed as { success?: unknown; code?: unknown };
      return root.success === false || root.code === 'envelope_missing';
    }
  } catch {
    // Not JSON - fall through to the conservative substring heuristic.
  }
  return /"success"\s*:\s*false/.test(body) || body.includes('envelope_missing');
}

/** Pair assistant tool_use blocks with their tool_result and classify EXECUTIONS as gather vs
 *  write. `all` inventories every emission (executed or not) for honest logging. */
export function summarizeReportToolUse(
  history: ReadonlyArray<ReportHistoryMessage>
): ReportToolAudit {
  // Pass 1: index result health AND content by tool_use_id (results live in the user messages
  // the agent loop pushes after each tool batch - agent-loop.ts:1408-1411). Content is kept so
  // an executed code_act can surface the nested host tools recorded in its result message.
  const resultOkById = new Map<string, boolean>();
  const resultContentById = new Map<string, unknown>();
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
      resultContentById.set(block.tool_use_id, block.content);
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
      const name = stripMcpPrefix(block.name);
      if (
        (block.name === CODE_ACT_TOOL_NAME || block.name === 'mcp__code-act__code_act') &&
        typeof block.id === 'string' &&
        resultContentById.has(block.id)
      ) {
        // A later Code-Act failure does not erase earlier successful host calls.
        // The trusted root ledger records each nested execution independently.
        for (const nested of parseHostToolsInvoked(resultContentById.get(block.id as string))) {
          if (GATHER_TOOLS.has(nested)) gatherTools.push(nested);
          else if (WRITE_TOOLS.has(nested)) writeTools.push(nested);
        }
        continue;
      }
      const executed = typeof block.id === 'string' && resultOkById.get(block.id) === true;
      if (!executed) continue;
      if (GATHER_TOOLS.has(name)) gatherTools.push(name);
      else if (WRITE_TOOLS.has(name)) writeTools.push(name);
    }
  }
  return { gatherTools, writeTools, all };
}

function uniq(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * Legacy structural tool-history summary retained for non-report diagnostics. Packet-only report
 * quality is audited by formatReportContextAudit and never inferred from tool use.
 */
export function formatReportToolAudit(audit: ReportToolAudit, isFullReport: boolean): string[] {
  const lines: string[] = [];
  if (audit.writeTools.length > 0) {
    lines.push(`[trigger-loop] full report: agent wrote via ${uniq(audit.writeTools).join(', ')}`);
  }
  if (isFullReport && audit.gatherTools.length > 0) {
    lines.push(
      `[trigger-loop] full report: agent gathered via ${uniq(audit.gatherTools).join(', ')}`
    );
  }
  return lines;
}

export interface PersonaReportRunResult {
  response: string;
  history: ReadonlyArray<ReportHistoryMessage>;
  /** Model iterations consumed by this run. Full reports require exactly one. */
  turns?: number;
  /** The run that produced this text. Absent when the backend records no run. */
  modelRunId?: string | null;
  /** Set by the agent loop when a run existed but its handle could not be committed. */
  modelRunProvenance?: string;
}
/** E = the envelope type; generic keeps this module free of agent/envelope imports while start.ts
 *  gets full inference (no casts): E is inferred from the injected issuer's return type. */
export interface PersonaReportRunner<E = unknown> {
  (prompt: string, envelope?: E, sourceMessageRef?: string): Promise<PersonaReportRunResult>;
}
export interface FullReportRunInput {
  prompt: string;
  context: OwnerReportContextV1;
  contextSha256: string;
}
export interface PersonaReportAsk extends AskAgent {
  full(input: FullReportRunInput): Promise<string>;
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
  /**
   * Receives the provenance of each composed report, so the delivered artifact can record
   * what produced it. The runner already knows this and the boundary used to drop it on
   * the floor - the report went out and nothing downstream could say which run stood
   * behind it, which is the same defect the gateway turn seam had.
   */
  onRunProvenance?: (provenance: ArtifactProvenance) => void;
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
export function formatReportContextAudit(
  context: OwnerReportContextV1,
  contextSha256: string
): string {
  const sourceStates = Object.entries(context.sources)
    .map(([name, source]) => `${name}=${source.state}`)
    .join(',');
  return (
    `[trigger-loop] full report context schema=${context.schemaVersion} sha256=${contextSha256} ` +
    `sources=${sourceStates} messages=${context.windowEvidence.messageCount} ` +
    `tasks=${context.taskCoverage.returned}/${context.taskCoverage.total} ` +
    `correlations=${context.correlations.coverage.total} ` +
    `changes=${context.changes.returned}/${context.changes.total} ` +
    `trello_complete=${context.trello.complete} trello_truncated=${context.trello.truncated} ` +
    `packet_bytes=${context.packet.bytes} packet_truncated=${context.packet.truncated} ` +
    `caveats=${context.caveats.length}`
  );
}

export function createPersonaReportAsk<E = unknown>(
  deps: PersonaReportAskDeps<E>
): PersonaReportAsk {
  const execute = async (prompt: string, fullInput?: FullReportRunInput): Promise<string> => {
    const envelope = deps.issueEnvelope ? await deps.issueEnvelope() : undefined;
    const result = await deps.run(
      prompt,
      envelope,
      fullInput ? `owner-report-context:${fullInput.contextSha256}` : undefined
    );
    const { response, history } = result;
    deps.onRunProvenance?.(
      result.modelRunId
        ? { status: 'available', modelRunId: result.modelRunId }
        : {
            status: 'unavailable',
            reason:
              result.modelRunProvenance === 'commit_failed' ? 'commit_failed' : 'no_run_handle',
          }
    );
    if (fullInput) {
      if (result.turns !== 1) {
        throw new Error('Full owner report must complete in exactly one model turn');
      }
      deps.log(formatReportContextAudit(fullInput.context, fullInput.contextSha256));
    }
    let reportText = (response ?? '').trim();
    if (reportText === '' && !fullInput) {
      // Text-gateway multi-turn runs return only the LAST assistant segment
      // (agent-loop extractTextResponse), and after a closing tool round that
      // segment is often empty - the composed report body lives in an EARLIER
      // assistant turn (live incident 2026-07-27: gather+save succeeded, the
      // cadence then died on 'empty report response'). Recover the last
      // non-empty assistant text from history (its text blocks are already
      // stripped of tool_call JSON by the gateway parser) and stay loud.
      reportText = lastAssistantText(history);
      if (reportText !== '') {
        deps.log('[trigger-loop] report body recovered from an earlier assistant turn');
      }
    }
    if (reportText === '') {
      throw new Error('persona agent returned an empty report response');
    }
    return reportText;
  };
  const ask = (async (prompt: string): Promise<string> => execute(prompt)) as PersonaReportAsk;
  ask.full = async (input: FullReportRunInput): Promise<string> => execute(input.prompt, input);
  return ask;
}

/** Last non-empty assistant TEXT across the run history (structural walk; text
 *  blocks on the gateway path carry prose only - tool_call JSON is parsed out
 *  before history assembly, agent-loop.ts removeToolCallBlocks). */
export function lastAssistantText(history: ReadonlyArray<ReportHistoryMessage>): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (!message || message.role !== 'assistant') continue;
    const { content } = message;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((block) => {
          const b = block as { type?: unknown; text?: unknown };
          return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
        })
        .filter((part) => part !== '')
        .join('\n');
    }
    if (text.trim() !== '') return text.trim();
  }
  return '';
}
