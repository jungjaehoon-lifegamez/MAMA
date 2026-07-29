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
 */

import type { SQLiteDatabase } from '../sqlite.js';
import { OBLIGATED_TOOLS } from './action-verifier.js';
import type { WorkOrderRecord } from './task-ledger.js';
import {
  captureTemporalEffectSnapshot,
  verifyTemporalEffect,
  type TemporalEffectSnapshot,
  type TemporalVerifierDeps,
} from './action-verifier.js';
import type { WorkOrderHook } from './workorder-consumer.js';

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
  // `obsidian` first, because it is what the lane actually calls: measured on the live
  // install, worker:wiki has 928 obsidian traces and ZERO wiki_publish ones. The vault it
  // writes to is the one the owner has open, NOT the configured wiki dir - which is why
  // `wiki_page_index` looks frozen since 2026-07-04 while the vault took writes minutes ago.
  // 07-04 is when the LEGACY system:wiki-agent path stopped; the Stage-2 worker replaced it
  // and moved to a different write path. `wiki_publish` stays obligated so the index route
  // counts if anything revives it.
  wiki: ['obsidian', 'wiki_publish', 'contract_no_update'],
  'memory-curation': ['mama_save', 'contract_no_update'],
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

export function buildWorkerTraceQueries(
  sessionsDb: SQLiteDatabase | undefined,
  workerChannelId: string,
  obligatedTools: readonly string[] = OBLIGATED_TOOLS
): WorkerTraceQueries {
  const TRACE_TOOL_LIST = traceToolList(obligatedTools);
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
  traces: WorkerTraceQueries;
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
  return (_wo, response, before) => {
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
    const traceCount = deps.traces.countObligatedTraceRowsSince(
      typeof before === 'number' ? before : 0
    );
    const verdict = reconcileClaimAgainstTraces(claim, traceCount);
    events.emitAgentAction(
      traceCount > 0 ? 'promoted' : 'no_update',
      `promotion run: ${traceCount} saved (${verdict.note})`
    );
    deps.log(
      `[stage2] promotion worker: ${verdict.verified ? 'verified' : 'UNVERIFIED'} - ${verdict.note}`
    );
    if (!verdict.verified) deps.onUnverified?.(verdict.note);
    if (traceCount > 0) events.emitMemoryPromoted(traceCount);
  };
}

export function buildWikiAfterHook(
  log: (line: string) => void,
  deps?: Omit<LaneAfterHookDeps, 'log'>
): (wo: WorkOrderRecord, response: string, before?: unknown) => void {
  return (_wo, response, before) => {
    const claim = readLaneClaim(response);
    if (!deps) {
      log(`[stage2] wiki worker: ${claim.noUpdate ? 'no changes claimed' : 'completion claimed'}`);
      return;
    }
    const traceCount = deps.traces.countObligatedTraceRowsSince(
      typeof before === 'number' ? before : 0
    );
    const verdict = reconcileClaimAgainstTraces(claim, traceCount);
    log(`[stage2] wiki worker: ${verdict.verified ? 'verified' : 'UNVERIFIED'} - ${verdict.note}`);
    if (!verdict.verified) deps.onUnverified?.(verdict.note);
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
