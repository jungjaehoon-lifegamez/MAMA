/**
 * evolveTrigger - Task 4, G2 (the learning Kagemusha deferred forever).
 *
 * An intervention outcome (succeeded / failed / corrected) is fed to the trigger's stats,
 * then the AGENT decides whether to keep, refine, or retire the trigger. The decision is
 * INJECTED (`decide`) - the real one is an LLM call. There is deliberately NO numeric
 * threshold in this module: a fixed `if (failed >= N) disable()` would be exactly the
 * automation trap that re-freezes G2. The same stats can be kept or retired by judgment.
 */

import { createHash } from 'node:crypto';
import type { TriggerRegistry } from './trigger-registry.js';
import type { CreateTriggerInput, TriggerRecord } from './trigger-types.js';
import type { TriggerSpec } from './trigger-author.js';

export type EvolutionOutcome = 'succeeded' | 'failed' | 'corrected';
export type EvolutionAction = 'kept' | 'refined' | 'retired';

export type EvolutionDecision =
  | { action: 'kept' }
  | { action: 'retired'; reason: string }
  | { action: 'refined'; reason: string; newSpec: TriggerSpec };

export type DecideEvolution = (ctx: {
  trigger: TriggerRecord;
  outcome: EvolutionOutcome;
  detail: string;
}) => Promise<EvolutionDecision>;

export async function evolveTrigger(
  triggerId: string,
  outcome: EvolutionOutcome,
  detail: string,
  registry: TriggerRegistry,
  decide: DecideEvolution
): Promise<EvolutionAction> {
  // Feed the outcome into the stats (the G2 signal). 'corrected' counts as the current form failing.
  registry.recordOutcome(triggerId, outcome === 'succeeded' ? 'succeeded' : 'failed');

  const trigger = registry.getById(triggerId);
  if (!trigger) throw new Error(`evolveTrigger: no trigger with id ${triggerId}`);

  // Keep / refine / retire is the AGENT's judgment (injected). No threshold constant here (G2 guard).
  const decision = await decide({ trigger, outcome, detail });

  if (decision.action === 'retired') {
    registry.disable(triggerId, decision.reason);
    return 'retired';
  }

  if (decision.action === 'refined') {
    registry.disable(triggerId, `refined: ${decision.reason}`);
    const spec = decision.newSpec;
    const id = spec.id ?? `${triggerId}.r.${refineHash(spec)}`;
    const input: CreateTriggerInput = {
      id,
      kind: spec.kind,
      memoryQuery: spec.memoryQuery,
      match: spec.match,
      procedure: spec.procedure,
      requiredEvidence: spec.requiredEvidence,
      authoredBy: 'agent',
      provenance: { createdFrom: `refined-from:${triggerId}`, note: decision.reason },
    };
    registry.create(input);
    return 'refined';
  }

  return 'kept';
}

function refineHash(spec: TriggerSpec): string {
  return createHash('sha256')
    .update(`${spec.kind}\n${spec.match.keywords.join('|')}`)
    .digest('hex')
    .slice(0, 8);
}
