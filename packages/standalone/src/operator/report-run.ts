/** Owner-runtime report composition and provenance binding. */
import type { ArtifactProvenance } from './report-carry.js';

/** Minimal structural view of AgentLoopResult.history (types.ts:1105). Structural on purpose:
 *  keeps this module free of agent-internal imports so tests use plain synthetic objects. */
export interface ReportHistoryMessage {
  role: string;
  content: unknown;
}

export interface PersonaReportRunResult {
  response: string;
  history: ReadonlyArray<ReportHistoryMessage>;
  /** Model iterations consumed by this run, including progressive tool rounds. */
  turns?: number;
  /** The run that produced this text. Absent when the backend records no run. */
  modelRunId?: string | null;
  /** Set by the agent loop when a run existed but its handle could not be committed. */
  modelRunProvenance?: string;
  ownerJournalProvenance?: 'commit_failed';
}
export interface PersonaReportRunOptions {
  lanePriority: number;
}
export interface PersonaReportRunner {
  (
    prompt: string,
    sourceMessageRef: string,
    options: PersonaReportRunOptions
  ): Promise<PersonaReportRunResult>;
}
export interface ReportRunInput {
  requestKind: 'digest' | 'scheduled_full' | 'on_demand_full';
  prompt: string;
  sourceMessageRef: string;
}
export interface PersonaReportAsk {
  compose(input: ReportRunInput): Promise<string>;
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
  /** Surfaces bounded recovery failure without discarding an already generated report. */
  onRecoveryFailure?: () => void;
}

/**
 * Build the report-composition adapter. Both full and digest stimuli run through the standing
 * owner subject, retain model-run provenance, and fail on an empty final body.
 */
export function createPersonaReportAsk(deps: PersonaReportAskDeps): PersonaReportAsk {
  const execute = async (input: ReportRunInput): Promise<string> => {
    const { prompt } = input;
    const result = await deps.run(prompt, input.sourceMessageRef, {
      lanePriority: input.requestKind === 'on_demand_full' ? 100 : 0,
    });
    const { response } = result;
    deps.onRunProvenance?.(
      result.modelRunId
        ? { status: 'available', modelRunId: result.modelRunId }
        : {
            status: 'unavailable',
            reason:
              result.modelRunProvenance === 'commit_failed' ? 'commit_failed' : 'no_run_handle',
          }
    );
    if (result.ownerJournalProvenance === 'commit_failed') {
      deps.onRecoveryFailure?.();
    }
    const reportText = (response ?? '').trim();
    if (reportText === '') {
      throw new Error('persona agent returned an empty report response');
    }
    return reportText;
  };
  return { compose: execute };
}
