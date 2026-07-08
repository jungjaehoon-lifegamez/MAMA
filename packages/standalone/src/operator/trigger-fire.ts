/**
 * fireTrigger - the proactive intervention: a fired TriggerSignal recalls its
 * agent-authored memoryQuery (mama-core) and gathers requiredEvidence, then surfaces
 * both to the agent. Read-only and self-activating (G4): no human gate, no outward send.
 *
 * This is "memory triggered like a skill" - the agent's memoryQuery decides what is
 * recalled; the recall itself is a mechanical system assist.
 */

import type { OperatorMemoryPort } from './operator-interfaces.js';
import type { TriggerSignal } from './trigger-types.js';

/** Resolver for a requiredEvidence key the operator can supply (channel_history, task_state, ...). */
export type EvidenceProvider = () => Promise<unknown>;

export interface FireResult {
  recalled: { topic: string; content: string }[];
  evidence: Record<string, unknown>;
}

export interface FireOptions {
  limit?: number;
  /** Observability hook - every fire is surfaced here (log + alarm at integration). */
  onFire?: (info: { signal: TriggerSignal; result: FireResult }) => void;
}

export async function fireTrigger(
  signal: TriggerSignal,
  memory: OperatorMemoryPort,
  evidenceProviders: Record<string, EvidenceProvider> = {},
  opts: FireOptions = {}
): Promise<FireResult> {
  const bundle = await memory.recall(signal.memoryQuery, { limit: opts.limit ?? 5 });
  const recalled = bundle.map((record) => ({ topic: record.topic, content: record.content }));

  const evidence: Record<string, unknown> = {};
  for (const key of signal.requiredEvidence) {
    if (key === 'current_message') {
      evidence[key] = signal.text;
    } else if (evidenceProviders[key]) {
      evidence[key] = await evidenceProviders[key]();
    } else {
      // Not available. Surface honestly as null rather than guessing (no-fallback).
      evidence[key] = null;
    }
  }

  const result: FireResult = { recalled, evidence };
  opts.onFire?.({ signal, result });
  return result;
}
