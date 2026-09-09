/**
 * Extracted, testable pieces of the Stage-2 per-kind completion hooks
 * (plan S2-T3; extraction demanded by implementation review round 1 - the
 * hook bodies lived in registerApiRoutes closures where nothing could prove
 * them, which is the green-test-trap class the plan bans).
 *
 * - buildWorkerTraceQueries: the G1 re-keyed verifier trace queries. Worker
 *   runs log gateway_tool_call rows with the worker's identity, NOT
 *   agent_id='dashboard-agent'; the ONLY schema-supported key is the details
 *   JSON (agent_activity has no channel_id column) - hence json_extract.
 * - buildPromotionAfterHook: the PROMOTED <n> parse + event re-emission that
 *   keeps the memory:promoted -> wiki ingress chain alive (plan E4/R7).
 * - buildWikiAfterHook: outcome reading only.
 *
 * Delegation note: a delegated attempt is re-verified through these same queries, bound to
 * the attempt id. That path only opens when the runner SURFACES a native subagent start, and
 * today only the Codex app-server does (`collabAgentToolCall`, workorder-consumer.ts
 * NATIVE_SUBAGENT_ITEM_NAMES) - on any other backend a handed-off run is judged on the
 * evidence it has at return time.
 */

import type { SQLiteDatabase } from '../sqlite.js';
import { OBLIGATED_TOOLS } from './action-verifier.js';
import type { BoardCandidateAttemptState, WorkOrderRecord } from './task-ledger.js';
import {
  captureTemporalEffectSnapshot,
  verifyTemporalEffect,
  type TemporalEffectSnapshot,
  type TemporalVerifierDeps,
} from './action-verifier.js';
import type { WorkOrderEffectVerdict, WorkOrderHook } from './workorder-consumer.js';

export interface BoardCandidateReceiptInspector {
  inspectBoardCandidateAttempt(attemptId: number): BoardCandidateAttemptState;
}

export interface BoardRefreshGatePort {
  completeVerifiedReconcile(channelKey: string, capturedGeneration: number): void;
  completeVerifiedFull(capturedGeneration: number): void;
}

/**
 * The verdict reason for an attempt that produced no durable result at all.
 *
 * Live case (board#4760, 2026-09-09): a full board run answered in 23 characters of prose,
 * made ZERO gateway calls, and the consumer marked it `completed` - because an unverified
 * action only left the repair gate dirty while the receipt verdict stayed 'complete'. A
 * board attempt that neither published nor recorded the exact no-update scope has nothing
 * to show, so it is a FAILURE on the normal per-kind policy (loud through the alarm sink),
 * not a completion.
 */
export const NO_DURABLE_RESULT_REASON = 'no-durable-result';

/**
 * Clear repair dirt only when both independent authorities agree: the
 * run-bound action verifier observed an effect and candidate receipts (when
 * present) are complete. A receipt failure keeps its own, more specific reason;
 * an action the verifier could not observe is `no-durable-result`.
 */
export function applyBoardRefreshVerdict(
  workOrder: WorkOrderRecord,
  actionVerified: boolean,
  receiptVerdict: WorkOrderEffectVerdict,
  gate: BoardRefreshGatePort
): WorkOrderEffectVerdict {
  if (receiptVerdict.disposition !== 'complete') {
    return receiptVerdict;
  }
  if (!actionVerified) {
    return { disposition: 'fail', reason: NO_DURABLE_RESULT_REASON };
  }
  const generation = workOrder.payload.repairGeneration;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    return receiptVerdict;
  }
  if (workOrder.payload.mode === 'reconcile') {
    const channelKey = workOrder.payload.channelKey;
    if (typeof channelKey === 'string' && channelKey.length > 0) {
      gate.completeVerifiedReconcile(channelKey, generation as number);
    }
  } else if (workOrder.payload.mode === 'full' || workOrder.payload.mode === 'delta') {
    // A VERIFIED delta run clears the same dirt a full run does, and for the reason the dirt
    // exists: the generation records that something arrived which the published board did not
    // yet reflect, and a delta run publishes from the accumulated state - the very state those
    // arrivals were judged into by the owner-event turns - at or after the captured generation.
    // Treating it as weaker evidence would leave the gate permanently dirty and buy one full
    // rebuild per staleness window for changes the board already shows.
    gate.completeVerifiedFull(generation as number);
  }
  return receiptVerdict;
}

/** Candidate completion is established by receipts, never verifier telemetry. */
export function boardCandidateReceiptVerdict(
  workOrder: WorkOrderRecord,
  inspector: BoardCandidateReceiptInspector | null | undefined
): WorkOrderEffectVerdict {
  const candidates = workOrder.payload.candidates as
    | { bindingCandidates: readonly unknown[]; lifecycleCandidates: readonly unknown[] }
    | undefined;
  const hasCandidates =
    workOrder.payload.mode === 'reconcile' &&
    candidates !== undefined &&
    candidates.bindingCandidates.length + candidates.lifecycleCandidates.length > 0;
  if (!hasCandidates) return { disposition: 'complete' };
  if (!inspector) return { disposition: 'fail', reason: 'candidate receipt inspector unavailable' };
  const state = inspector.inspectBoardCandidateAttempt(workOrder.id);
  if (state.disposition === 'complete') return { disposition: 'complete' };
  if (state.disposition === 'partial') {
    return {
      disposition: 'fail',
      reason: `candidate receipt set partial; missing ${state.missingCandidateIds.length} decision(s)`,
    };
  }
  return { disposition: 'fail', reason: 'candidate receipt set is empty' };
}

/**
 * The tools whose execution proves a lane did its job, per lane.
 *
 * The board lane already verified this way: a run counts as verified when a NEW
 * gateway_tool_call trace row appears past the snapshot, naming an obligated tool. That is
 * a measurement - the trace row is written by the executor when the call runs, so an agent
 * cannot produce one by describing a call it never made.
 *
 * The wiki and promotion lanes were reading the agent's PROSE instead, and the gap that
 * opened is measurable: 59 wiki work orders reached 'done' while wiki_page_index last moved
 * on 2026-07-04. The tools themselves are honest - wiki_publish writes the page and index
 * synchronously and throws on failure - but nothing downstream required the call to have
 * happened.
 *
 * `contract_no_update` is obligated everywhere: a run that legitimately found nothing must
 * still say so through a tool, or "nothing to do" and "did nothing" stay indistinguishable.
 */
export const LANE_OBLIGATED_TOOLS = {
  board: OBLIGATED_TOOLS,
  // A wiki run either publishes through the configured-root publisher or records the exact
  // no-update scope. Reads never satisfy completion.
  wiki: ['wiki_publish', 'contract_no_update'],
  'memory-curation': ['mama_save', 'contract_no_update'],
} as const satisfies Record<string, readonly string[]>;

/**
 * The subset that proves the lane WROTE, as opposed to merely acting.
 *
 * `contract_no_update` is obligated so an empty run has a way to say so - but counting it as
 * a write is how the first version of this hook reported "promotion run: 1 saved" for a run
 * that honestly saved nothing, and woke the wiki compiler on it. Found in review. Two
 * questions, two counts: did the lane act, and did it write.
 */
export const LANE_WRITE_TOOLS = {
  wiki: ['wiki_publish'],
  'memory-curation': ['mama_save'],
} as const satisfies Record<string, readonly string[]>;

function traceToolList(tools: readonly string[]): string {
  for (const tool of tools) {
    // These are interpolated into SQL. Nothing outside this module supplies them today, and
    // this keeps that true if something ever does.
    if (!/^[a-z][a-z0-9_]*$/.test(tool)) {
      throw new Error(`[workorder-hooks] invalid obligated tool name: ${JSON.stringify(tool)}`);
    }
  }
  return tools.map((t) => `'${t}'`).join(',');
}

export interface WorkerTraceQueries {
  getTraceMaxId: () => number;
  countObligatedTraceRowsSince: (maxId: number) => number;
}

export const REQUIRED_BOARD_JUDGMENT_SLOTS = ['briefing', 'action_required', 'decisions'] as const;

// Board freshness includes the host-managed pipeline. Model publish receipts do not:
// the board turn writes only judgment, while the report store projects the task ledger.
export const REQUIRED_FULL_BOARD_SLOTS = [...REQUIRED_BOARD_JUDGMENT_SLOTS, 'pipeline'] as const;

/** Completed, attempt-bound report_publish evidence for the Board's authored judgment. */
export function buildFullBoardTraceQueries(
  sessionsDb: SQLiteDatabase | undefined,
  workerChannelId: string,
  workorderAttemptId: number
): WorkerTraceQueries {
  if (!Number.isSafeInteger(workorderAttemptId) || workorderAttemptId < 1) {
    throw new Error('[workorder-hooks] full Board attempt id must be a positive integer');
  }
  const requiredSlotPredicates = REQUIRED_BOARD_JUDGMENT_SLOTS.map(
    () =>
      `EXISTS (SELECT 1 FROM json_each(json_extract(details, '$.report_slot_ids')) WHERE value = ?)`
  ).join(' AND ');
  return {
    getTraceMaxId: () => {
      if (!sessionsDb) return 0;
      const row = sessionsDb
        .prepare(
          `SELECT MAX(id) AS max_id FROM agent_activity
           WHERE type = 'gateway_tool_call'
             AND json_extract(details, '$.channel_id') = ?`
        )
        .get(workerChannelId) as { max_id: number | null };
      return row.max_id ?? 0;
    },
    countObligatedTraceRowsSince: (maxId: number) => {
      if (!sessionsDb) return 0;
      const row = sessionsDb
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_activity
           WHERE type = 'gateway_tool_call'
             AND json_extract(details, '$.channel_id') = ?
             AND json_extract(details, '$.workorder_attempt_id') = ?
             AND execution_status = 'completed'
             AND id > ?
             AND normalized_tool_name = 'report_publish'
             AND json_type(details, '$.report_slot_ids') = 'array'
             AND ${requiredSlotPredicates}`
        )
        .get(workerChannelId, workorderAttemptId, maxId, ...REQUIRED_BOARD_JUDGMENT_SLOTS) as {
        n: number;
      };
      return row.n;
    },
  };
}

/**
 * Per-attempt trace queries for a lane.
 *
 * The attempt id is not optional hygiene. The channel key alone is shared by every work
 * order of the same kind, and a delegated attempt stays open for up to
 * DELEGATED_ATTEMPT_TIMEOUT_MS - so a SIBLING order's traces used to discharge the attempt
 * that was still waiting on its child. Binding the count to
 * `details.$.workorder_attempt_id` (written by the executor from the run's execution
 * context, which a native child inherits) makes the measurement name ITS OWN attempt.
 */
export type WorkerTraceQueryFactory = (workorderAttemptId: number) => WorkerTraceQueries;

export function buildWorkerTraceQueries(
  sessionsDb: SQLiteDatabase | undefined,
  workerChannelId: string,
  obligatedTools: readonly string[] = OBLIGATED_TOOLS,
  workorderAttemptId?: number
): WorkerTraceQueries {
  const TRACE_TOOL_LIST = traceToolList(obligatedTools);
  if (workorderAttemptId !== undefined) {
    if (!Number.isSafeInteger(workorderAttemptId) || workorderAttemptId < 1) {
      throw new Error('[workorder-hooks] workorder attempt id must be a positive integer');
    }
  }
  // The anchor stays channel-wide on purpose: it is a rowid boundary, and the attempt
  // predicate below is what excludes a sibling's rows from the count.
  const attemptClause =
    workorderAttemptId === undefined
      ? ''
      : `AND json_extract(details, '$.workorder_attempt_id') = ${String(workorderAttemptId)}`;
  return {
    getTraceMaxId: () => {
      if (!sessionsDb) return 0;
      const row = sessionsDb
        .prepare(
          `SELECT MAX(id) AS max_id FROM agent_activity
           WHERE type = 'gateway_tool_call'
             AND json_extract(details, '$.channel_id') = ?`
        )
        .get(workerChannelId) as { max_id: number | null };
      return row.max_id ?? 0;
    },
    countObligatedTraceRowsSince: (maxId: number) => {
      if (!sessionsDb) return 0;
      const row = sessionsDb
        .prepare(
          // execution_status = 'completed' is load-bearing, not hygiene. The executor writes
          // a trace row on its FAILURE paths too (gateway-tool-executor sets 'failed' when the
          // call errored or returned success:false), so without this predicate a `mama_save`
          // refused by the secret filter counted as proof the lane saved something - and the
          // promotion hook would then emit memory:promoted on it and wake the wiki compiler.
          // "Ran but changed nothing" is exactly the case this measurement exists to catch.
          `SELECT COUNT(*) AS n FROM agent_activity
           WHERE type = 'gateway_tool_call'
             AND json_extract(details, '$.channel_id') = ?
             AND execution_status = 'completed'
             ${attemptClause}
             AND id > ? AND (normalized_tool_name IN (${TRACE_TOOL_LIST}) OR input_summary IN (${TRACE_TOOL_LIST}))`
        )
        .get(workerChannelId, maxId) as { n: number };
      return row.n;
    },
  };
}

export interface PromotionHookEvents {
  emitAgentAction: (action: 'promoted' | 'no_update', target: string) => void;
  emitMemoryPromoted: (saved: number) => void;
  log?: (line: string) => void;
}

/**
 * What the run SAID, kept apart from what it DID.
 *
 * The claim is still parsed, because the promotion count feeds the memory:promoted ->
 * wiki ingress chain and nothing else carries it. It is no longer trusted on its own: the
 * trace count is the measurement, and when the two disagree the disagreement is the finding.
 */
export interface LaneClaim {
  /** What the response asserts it wrote (0 when it asserts nothing). */
  claimed: number;
  /** Whether the response asserts there was nothing to do. */
  noUpdate: boolean;
}

export function readLaneClaim(response: string): LaneClaim {
  const match = response.match(/PROMOTED\s+(\d+)/);
  return {
    claimed: match ? Number(match[1]) : 0,
    noUpdate: response.includes('NO_UPDATE'),
  };
}

/**
 * Compare a lane's claim against its obligated-tool traces.
 *
 * Observe, never block - the same rule the board verifier states, and for the same reason:
 * a run that overstates has still done whatever it did, and failing it here would retry work
 * that may have partly landed. The falsehood becomes visible instead of authoritative.
 */
export function reconcileClaimAgainstTraces(
  claim: LaneClaim,
  traceCount: number
): { verified: boolean; note: string } {
  if (traceCount > 0) {
    const overstated = claim.claimed > traceCount;
    return {
      verified: true,
      note: overstated
        ? `claimed ${claim.claimed}, ${traceCount} obligated tool trace(s) - CLAIM EXCEEDS TRACES`
        : `${traceCount} obligated tool trace(s)`,
    };
  }
  // No trace at all. A claim of work is then unsupported; a claim of no work is merely
  // unrecorded, because the run was supposed to say so through contract_no_update.
  return {
    verified: false,
    note:
      claim.claimed > 0
        ? `claimed ${claim.claimed} but NO obligated tool ran - claim unsupported`
        : claim.noUpdate
          ? 'said NO_UPDATE without recording it through contract_no_update'
          : 'no obligated tool ran and nothing was claimed',
  };
}

export interface LaneAfterHookDeps {
  /**
   * Counts the lane's obligated tools for ONE attempt: proves that attempt ACTED. A factory,
   * not a fixed query, because a sibling order of the same kind must never discharge the
   * attempt that is waiting on its own child.
   */
  tracesFor: WorkerTraceQueryFactory;
  /**
   * Counts only the lane's write tools: proves the run WROTE. Separate from `tracesFor`
   * because `contract_no_update` is honest evidence of acting and no evidence at all of
   * writing.
   */
  writeTracesFor?: WorkerTraceQueryFactory;
  log: (line: string) => void;
  /** Raised when the run cannot be shown to have done what it reported. */
  onUnverified?: (note: string) => void;
}

/**
 * The wiki ingress chain's second link: losing the parse severs memory:promoted, so the
 * claim is still read - but `emitMemoryPromoted` now carries the measured count, not the
 * asserted one, so a lane that writes nothing can no longer wake the wiki compiler.
 */
export function buildPromotionAfterHook(
  events: PromotionHookEvents,
  deps?: LaneAfterHookDeps
): (wo: WorkOrderRecord, response: string, before?: unknown) => void {
  return (wo, response, before) => {
    const claim = readLaneClaim(response);
    if (!deps) {
      // No trace source wired (tests, or a daemon without the sessions DB): fall back to
      // the claim and say so, rather than silently reporting it as measured.
      events.emitAgentAction(
        claim.noUpdate || claim.claimed === 0 ? 'no_update' : 'promoted',
        `promotion run: ${claim.claimed} claimed (unverified)`
      );
      if (claim.claimed > 0) events.emitMemoryPromoted(claim.claimed);
      return;
    }
    const anchor = typeof before === 'number' ? before : 0;
    const traceCount = deps.tracesFor(wo.id).countObligatedTraceRowsSince(anchor);
    // The promoted count comes from the WRITE tools only. Using the obligated count here
    // reported "1 saved" for a run whose only obligated call was contract_no_update, and
    // that number is what wakes the wiki compiler.
    const savedCount = deps.writeTracesFor
      ? deps.writeTracesFor(wo.id).countObligatedTraceRowsSince(anchor)
      : traceCount;
    const verdict = reconcileClaimAgainstTraces(claim, traceCount);
    events.emitAgentAction(
      savedCount > 0 ? 'promoted' : 'no_update',
      `promotion run: ${savedCount} saved, ${traceCount} obligated trace(s) (${verdict.note})`
    );
    deps.log(
      `[stage2] promotion worker: ${verdict.verified ? 'verified' : 'UNVERIFIED'} - ${verdict.note}`
    );
    if (!verdict.verified) deps.onUnverified?.(verdict.note);
    // Only a measured WRITE wakes the wiki compiler.
    if (savedCount > 0) events.emitMemoryPromoted(savedCount);
  };
}

export function buildWikiAfterHook(
  log: (line: string) => void,
  deps?: Omit<LaneAfterHookDeps, 'log'>
): (wo: WorkOrderRecord, response: string, before?: unknown) => WorkOrderEffectVerdict {
  return (wo, response, before) => {
    const claim = readLaneClaim(response);
    if (!deps) {
      const reason = 'wiki effect trace source unavailable';
      log(`[stage2] wiki worker: UNVERIFIED - ${reason}`);
      return { disposition: 'fail', reason };
    }
    const traceCount = deps
      .tracesFor(wo.id)
      .countObligatedTraceRowsSince(typeof before === 'number' ? before : 0);
    const verdict = reconcileClaimAgainstTraces(claim, traceCount);
    log(`[stage2] wiki worker: ${verdict.verified ? 'verified' : 'UNVERIFIED'} - ${verdict.note}`);
    if (!verdict.verified) {
      deps.onUnverified?.(verdict.note);
      return { disposition: 'fail', reason: verdict.note };
    }
    return { disposition: 'complete' };
  };
}

export function buildTemporalWorkOrderHook(deps: TemporalVerifierDeps): WorkOrderHook {
  return {
    verdictRequired: true,
    before: (workOrder) => captureTemporalEffectSnapshot(deps, workOrder.id),
    after: (workOrder, _response, beforeState) => {
      if (
        typeof beforeState !== 'object' ||
        beforeState === null ||
        !('attemptId' in beforeState)
      ) {
        return { disposition: 'fail', reason: 'temporal effect snapshot missing' };
      }
      const snapshot = beforeState as TemporalEffectSnapshot;
      if (snapshot.attemptId !== workOrder.id) {
        return { disposition: 'fail', reason: 'temporal effect snapshot attempt mismatch' };
      }
      const result = verifyTemporalEffect(deps, snapshot);
      return result.verified
        ? { disposition: 'complete' }
        : { disposition: 'fail', reason: result.reason };
    },
  };
}
