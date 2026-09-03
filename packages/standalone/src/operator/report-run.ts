/** Packet-only owner report composition and provenance binding. */
import type { AskAgent } from './trigger-author.js';
import type { ArtifactProvenance } from './report-carry.js';
import type { OwnerReportContextV1 } from './report-context.js';

/** Dedicated persona session lane for fresh packet-only report composition. */
export const OPERATOR_REPORT_SESSION_KEY = 'operator:report';

/** Minimal structural view of AgentLoopResult.history (types.ts:1105). Structural on purpose:
 *  keeps this module free of agent-internal imports so tests use plain synthetic objects. */
export interface ReportHistoryMessage {
  role: string;
  content: unknown;
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
export interface PersonaReportRunner {
  (prompt: string, sourceMessageRef?: string): Promise<PersonaReportRunResult>;
}
export interface FullReportRunInput {
  prompt: string;
  context: OwnerReportContextV1;
  contextSha256: string;
}
export interface PersonaReportAsk extends AskAgent {
  full(input: FullReportRunInput): Promise<string>;
}
export interface PersonaReportAskDeps {
  run: PersonaReportRunner;
  log: (line: string) => void;
  /**
   * Receives the provenance of each composed report, so the delivered artifact can record
   * what produced it. The runner already knows this and the boundary used to drop it on
   * the floor - the report went out and nothing downstream could say which run stood
   * behind it, which is the same defect the gateway turn seam had.
   */
  onRunProvenance?: (provenance: ArtifactProvenance) => void;
}

/**
 * Build the report-composition AskAgent. Full reports receive one persisted packet and no report
 * tool envelope; digest composition keeps its legacy response semantics. Both paths retain model
 * run provenance and fail on an empty final body.
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

export function createPersonaReportAsk(deps: PersonaReportAskDeps): PersonaReportAsk {
  const execute = async (prompt: string, fullInput?: FullReportRunInput): Promise<string> => {
    const result = await deps.run(
      prompt,
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
