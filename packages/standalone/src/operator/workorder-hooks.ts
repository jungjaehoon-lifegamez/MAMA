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

const TRACE_TOOL_LIST = OBLIGATED_TOOLS.map((t) => `'${t}'`).join(',');

export interface WorkerTraceQueries {
  getTraceMaxId: () => number;
  countObligatedTraceRowsSince: (maxId: number) => number;
}

export function buildWorkerTraceQueries(
  sessionsDb: SQLiteDatabase | undefined,
  workerChannelId: string
): WorkerTraceQueries {
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

/** The wiki ingress chain's second link: losing this parse severs memory:promoted. */
export function buildPromotionAfterHook(
  events: PromotionHookEvents
): (wo: WorkOrderRecord, response: string) => void {
  return (_wo, response) => {
    const promotedMatch = response.match(/PROMOTED\s+(\d+)/);
    const saved = promotedMatch ? Number(promotedMatch[1]) : 0;
    const noUpdate = response.includes('NO_UPDATE');
    events.emitAgentAction(
      noUpdate || saved === 0 ? 'no_update' : 'promoted',
      `promotion run: ${saved} saved`
    );
    if (saved > 0) {
      events.emitMemoryPromoted(saved);
      events.log?.(`[stage2] promotion worker: promoted ${saved} durable judgments`);
    }
  };
}

export function buildWikiAfterHook(
  log: (line: string) => void
): (wo: WorkOrderRecord, response: string) => void {
  return (_wo, response) => {
    if (response.includes('NO_UPDATE')) {
      log('[stage2] wiki worker: no changes detected');
    } else {
      log('[stage2] wiki worker: compilation complete');
    }
  };
}
