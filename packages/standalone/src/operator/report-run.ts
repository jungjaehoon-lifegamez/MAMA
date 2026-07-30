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

/** Dedicated persona session lane for operator reports; isolates the multi-turn gather loop from
 *  chat. runWithContent honors options.sessionKey (agent-loop.ts:879). */
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

/** Under a Code-Act role the report gathers INSIDE the sandbox: history carries one code_act
 *  tool_use, and the host tools it actually executed ride in the result message's
 *  hostToolsInvoked field (executeCodeAct collects them from the HostBridge onToolUse hook).
 *  Defensive on purpose: unparseable content, a missing field, or a wrong shape yield [] -
 *  the audit then falls back to warning, never to a throw or a false positive. */
/**
 * Recover the nested-tool evidence from a code_act tool_result, whatever layer it is in.
 *
 * There are three shapes in play and the audit only ever handled one:
 *
 *   1. `{value, logs, metrics, hostToolsInvoked}`            - the shape this was written for
 *   2. `{success, message: "<shape 1 as a JSON string>"}`    - what the history actually
 *      carries, because executeTools stores the whole GatewayToolResult as tool_result content
 *   3. shape 2 whose `message` is additionally wrapped in untrusted-content markers when the
 *      run touched external evidence, so `message` is prose with shape 1 embedded in it *
 * Measured live 2026-07-29: the report lane executed kagemusha_tasks and task_list, its own
 * trace channel recorded them, and three consecutive fixes still logged "agent executed NO
 * gateway gather tools" - because each fix addressed one layer and the payload was under
 * another. This descends instead of guessing which one.
 */
function parseHostToolsInvoked(content: unknown): string[] {
  let body = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  // Bounded: content -> {success,message} -> message JSON. A deeper nesting is not a shape
  // this system produces, and an unbounded loop on adversarial input is not worth the reach.
  for (let depth = 0; depth < 3; depth += 1) {
    const parsed = parseFirstJsonObject(body);
    if (!parsed) break;
    const invoked = parsed.hostToolsInvoked;
    if (Array.isArray(invoked)) {
      return invoked.filter((name): name is string => typeof name === 'string');
    }
    if (typeof parsed.message !== 'string') break;
    body = parsed.message;
  }
  // Deliberately no prose fallback. An earlier version also read the Code-Act MCP server's
  // `[tools] a, b, c` summary line, and that line shares one text blob with `[logs]` (the
  // sandbox's console output) and the model's own return value - so a single
  // `console.log('[tools] mama_save')` forged the audit, precisely in the zero-tools case
  // the audit exists to catch. Found in review. Losing that route can only produce a FALSE
  // WARNING on a run that did gather, which is the safe direction; the forgery silenced the
  // only "substance NOT verified" signal the owner gets. The executor-side shape above is
  // what the live report lane actually carries.
  return [];
}

/**
 * The first balanced JSON object in a string, or null.
 *
 * Not a bare JSON.parse, because an untrusted-content wrapper puts explanatory prose around
 * the payload - the object is in there, it just is not the whole string.
 */
function parseFirstJsonObject(body: string): Record<string, unknown> | null {
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    // The escape only means anything INSIDE a string. Checking it first made a stray
    // backslash in surrounding prose swallow the next character, and a `\}` could then eat
    // the closing brace and run the scan to EOF - a false "gathered nothing" against a run
    // that gathered. Found in review.
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(body.slice(start, i + 1));
          return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
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
      const executed = typeof block.id === 'string' && resultOkById.get(block.id) === true;
      if (!executed) continue;
      const name = stripMcpPrefix(block.name);
      if (name === CODE_ACT_TOOL_NAME) {
        // Nested gather/write: classify what the sandbox actually executed, not code_act itself.
        for (const nested of parseHostToolsInvoked(resultContentById.get(block.id as string))) {
          if (GATHER_TOOLS.has(nested)) gatherTools.push(nested);
          else if (WRITE_TOOLS.has(nested)) writeTools.push(nested);
        }
        continue;
      }
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
  /** The run that produced this text. Absent when the backend records no run. */
  modelRunId?: string | null;
  /** Set by the agent loop when a run existed but its handle could not be committed. */
  modelRunProvenance?: string;
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
export function createPersonaReportAsk<E = unknown>(deps: PersonaReportAskDeps<E>): AskAgent {
  return async (prompt: string): Promise<string> => {
    const envelope = deps.issueEnvelope ? await deps.issueEnvelope() : undefined;
    const result = await deps.run(prompt, envelope);
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
    const isFull = prompt.includes(deps.fullReportTag);
    for (const line of formatReportToolAudit(summarizeReportToolUse(history), isFull)) {
      deps.log(line);
    }
    let reportText = (response ?? '').trim();
    if (reportText === '') {
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
