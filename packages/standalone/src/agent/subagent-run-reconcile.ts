/**
 * Boot reconciliation for native subagent model runs.
 *
 * A child's model run is opened by the host and closed only when the child reports a
 * terminal status. Hard process death (SIGKILL, a crash, a machine restart) happens
 * between those two moments, and the row then stays `running` forever - a run that
 * nothing will ever close reads as work still in flight and poisons every coverage
 * count derived from the ledger.
 *
 * At boot nothing can confirm what such a child did, so the run is failed with the
 * reason named. Only runs whose `sourceMessageRef` marks them as a subagent are touched:
 * an owner turn's own run is reconciled by the path that owns it.
 */

import { failModelRunInAdapter } from '@jungjaehoon/mama-core';

/** The prefix `createSubagentBridge` writes into a child run's input refs. */
const SUBAGENT_REF_PREFIX = 'subagent:';

export const SUBAGENT_BOOT_FAILURE_REASON = 'daemon restarted before subagent completion';

interface ModelRunRow {
  model_run_id: string;
  input_refs_json: string | null;
}

/** The narrow slice of the core adapter this reconcile needs. */
export type ReconcileAdapter = Parameters<typeof failModelRunInAdapter>[0];

function isSubagentRun(inputRefsJson: string | null): boolean {
  if (!inputRefsJson) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(inputRefsJson);
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    const ref = (parsed as { sourceMessageRef?: unknown }).sourceMessageRef;
    return typeof ref === 'string' && ref.startsWith(SUBAGENT_REF_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Fail every still-`running` subagent model run left behind by a previous process.
 * Returns how many rows were failed so the caller can log a count.
 */
export function failOrphanedSubagentModelRuns(adapter: ReconcileAdapter): number {
  const rows = adapter
    .prepare(`SELECT model_run_id, input_refs_json FROM model_runs WHERE status = 'running'`)
    .all() as ModelRunRow[];
  let failed = 0;
  for (const row of rows) {
    if (!isSubagentRun(row.input_refs_json)) {
      continue;
    }
    failModelRunInAdapter(adapter, row.model_run_id, SUBAGENT_BOOT_FAILURE_REASON);
    failed += 1;
  }
  return failed;
}
