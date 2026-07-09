/**
 * trigger-review - periodic AGENT review of triggers (M1-T2).
 *
 * The read-only surface loop produces no succeeded/failed outcome, so the outcome-driven
 * evolveTrigger path is unusable without fabricating outcomes (review r1). Instead the agent
 * periodically REVIEWS a trigger - its spec, fire activity, and recent context - and decides
 * keep / refine / retire. No numeric threshold anywhere: the decision is the agent's (G2).
 *
 * evolveTrigger stays intact for the future outcome-linked path; this module never calls
 * recordOutcome.
 */

import { createHash } from 'node:crypto';
import type { TriggerRegistry } from './trigger-registry.js';
import type { CreateTriggerInput, TriggerRecord } from './trigger-types.js';
import type { EvolutionAction, EvolutionDecision } from './trigger-evolve.js';
import { validateTriggerSpec, askAgentCLI, type AskAgent } from './trigger-author.js';

export type ReviewDecision = EvolutionDecision;

export function parseReviewDecision(text: string): ReviewDecision {
  const raw = extractJsonObject(stripCodeFences(text));
  if (raw === null) throw new Error('agent review output contained no JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`agent review JSON did not parse: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('agent review decision must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.action === 'kept') return { action: 'kept' };
  if (obj.action === 'retired') {
    if (typeof obj.reason !== 'string' || obj.reason.trim() === '') {
      throw new Error('retired decision requires a non-empty reason');
    }
    return { action: 'retired', reason: obj.reason };
  }
  if (obj.action === 'refined') {
    if (typeof obj.reason !== 'string' || obj.reason.trim() === '') {
      throw new Error('refined decision requires a non-empty reason');
    }
    // Structural validation only - kind/action stay open strings (G3 guard).
    const newSpec = validateTriggerSpec(obj.newSpec);
    return { action: 'refined', reason: obj.reason, newSpec };
  }
  throw new Error(`unknown review action: ${String(obj.action)}`);
}

/** Mechanically apply the agent's decision to the registry (mirror of evolveTrigger's apply, minus outcome recording). */
export function applyReview(decision: ReviewDecision, triggerId: string, registry: TriggerRegistry): EvolutionAction {
  if (decision.action === 'retired') {
    registry.disable(triggerId, decision.reason);
    return 'retired';
  }
  if (decision.action === 'refined') {
    registry.disable(triggerId, `refined: ${decision.reason}`);
    const spec = decision.newSpec;
    const id = spec.id ?? `${triggerId}.r.${reviewHash(spec.kind, spec.match.keywords)}`;
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

export function buildReviewPrompt(trigger: TriggerRecord, recentContext: string[]): string {
  return [
    'You maintain a personal operator\'s library of TRIGGERS (keyword rules that recall a memory',
    'when future messages match). Review ONE trigger and decide whether to keep, refine, or',
    'retire it, based on its spec, its fire activity, and recent messages.',
    '',
    `Trigger id: ${trigger.id}`,
    `kind: ${trigger.kind}`,
    `keywords (${trigger.match.keywordMode}): ${trigger.match.keywords.join(', ')}`,
    `memoryQuery: ${trigger.memoryQuery}`,
    `stats: fired=${trigger.stats.fired} succeeded=${trigger.stats.succeeded} failed=${trigger.stats.failed}`,
    '',
    'Recent messages (context):',
    ...recentContext.map((line) => `- ${line}`),
    '',
    'Judge for yourself - there is no fixed rule. Firing a lot on irrelevant messages suggests',
    'refine (narrower keywords) or retire; firing usefully suggests keep; never firing may mean',
    'keep (rare-but-valuable) or retire (obsolete) - your call from the context.',
    '',
    'Return ONLY one JSON object (no prose):',
    '{ "action": "kept" }',
    'or { "action": "retired", "reason": string }',
    'or { "action": "refined", "reason": string, "newSpec": { "kind": string, "memoryQuery": string,',
    '     "match": { "keywords": string[], "keywordMode": "any"|"every", "minConfidence": number },',
    '     "procedure": [{ "action": string, "description": string }], "requiredEvidence": string[] } }',
  ].join('\n');
}

/** Real agent review via the local claude CLI. Exercised in the M1-T4 live smoke. */
export async function reviewTriggerCLI(
  trigger: TriggerRecord,
  recentContext: string[],
  askAgent: AskAgent = askAgentCLI
): Promise<ReviewDecision> {
  const answer = await askAgent(buildReviewPrompt(trigger, recentContext));
  return parseReviewDecision(answer);
}

// ---- helpers ----

function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?/gi, '');
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function reviewHash(kind: string, keywords: string[]): string {
  return createHash('sha256')
    .update(`${kind}\n${keywords.join('|')}`)
    .digest('hex')
    .slice(0, 8);
}
