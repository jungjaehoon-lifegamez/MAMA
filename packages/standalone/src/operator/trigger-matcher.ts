/**
 * matchTriggers - registry-driven trigger matching (system-assist).
 *
 * Ports Kagemusha `workflowMatchesMessage`
 * (~/project/mama-suite/apps/kagemusha/src/agent/contracts/workflow-situation-detector.ts:42):
 * keyword any/every + scope filter. Deliberately DROPS two things:
 *   - the `approvedAt`/`approvedBy` human-approval gate (`:43`) -> triggers self-activate (G4).
 *   - the per-kind special-case (`:46` feedback_artifact_followup + hasConcreteFeedbackArtifactSignal)
 *     -> that is a hardcoded marker (G1) and carries chatwork:/slack: PII. This matcher has
 *     ZERO per-kind branches; a trigger matches purely on its agent-authored keywords + scope.
 *
 * The keywords were authored by the agent (trigger-author.ts); mechanically checking them
 * is a legitimate system assist, not judgment.
 */

import type { OperatorChannelEvent } from './operator-interfaces.js';
import type { TriggerRecord, TriggerSignal } from './trigger-types.js';
import type { TriggerRegistry } from './trigger-registry.js';

export function matchTriggers(event: OperatorChannelEvent, registry: TriggerRegistry): TriggerSignal[] {
  // The operator reacts to incoming messages, not its own output (ports detector role check,
  // workflow-situation-detector.ts:13).
  if (event.role !== 'user') return [];

  const text = event.content.trim();
  if (!text) return [];

  const signals: TriggerSignal[] = [];
  for (const trigger of registry.listActive()) {
    if (triggerMatchesEvent(trigger, event, text)) {
      signals.push(buildSignal(trigger, event, text));
    }
  }
  return signals;
}

function triggerMatchesEvent(trigger: TriggerRecord, event: OperatorChannelEvent, text: string): boolean {
  const { keywords, keywordMode, scopeChannelIds } = trigger.match;

  if (scopeChannelIds && scopeChannelIds.length > 0 && !scopeChannelIds.includes(event.channelId)) {
    return false;
  }

  const cleaned = keywords.map((keyword) => keyword.trim()).filter(Boolean);
  if (cleaned.length === 0) return false;

  const normalized = text.toLocaleLowerCase();
  const hit = (keyword: string) => normalized.includes(keyword.toLocaleLowerCase());
  return keywordMode === 'any' ? cleaned.some(hit) : cleaned.every(hit);
}

function buildSignal(trigger: TriggerRecord, event: OperatorChannelEvent, text: string): TriggerSignal {
  return {
    kind: trigger.kind,
    memoryQuery: trigger.memoryQuery,
    requiredEvidence: [...trigger.requiredEvidence],
    confidence: trigger.match.minConfidence,
    detector: `agent-authored:${trigger.id}`,
    channelId: event.channelId,
    occurredAt: event.createdAt,
    reason: `Agent-authored trigger ${trigger.id} matched.`,
    text,
    sourceRefs: [{ sourceConnector: event.channel, sourceId: event.eventIndexId ?? String(event.id) }],
    triggerId: trigger.id,
  };
}
