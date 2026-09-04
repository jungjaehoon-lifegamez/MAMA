/**
 * Turn observer: the ONLY writer of `policy:` and `lesson:` memory rows.
 *
 * After an owner chat reply is committed, the owner's message is classified with the marker
 * vocabulary; a durable rule becomes a `policy:` row (kind decision), a correction becomes a
 * `lesson:` row (kind lesson). The row carries the SAME scope list the turn used, so the read
 * in learning-context.ts and this write cannot drift apart, and a host source ref.
 *
 * Two stores, split on purpose: the console brief holds cross-channel OPERATING STYLE and is
 * edited by the owner conversation; `lesson:` rows hold channel-scoped SITUATIONAL lessons.
 * The observer never touches the brief. The gateway refuses agent-written `policy:`/`lesson:`
 * topics (gateway-tool-executor.ts, learning_topic_refused), so standing policy can only come
 * from the owner through this path.
 */
import { createHash } from 'node:crypto';
import type {
  MemoryScopeRef,
  MemorySourceRef,
  PublicSaveMemoryInput,
} from '@jungjaehoon/mama-core/memory/types';
import {
  DEFAULT_LEARNING_MARKERS,
  detectDurableInstruction,
  type LearningMarkerConfig,
} from './learning-markers.js';
import { LESSON_TOPIC_PREFIX, POLICY_TOPIC_PREFIX } from './learning-context.js';

export interface ObserveOwnerTurnInput {
  userMessage: string;
  /** Same list the turn used; the channel scope id comes from here, never from a raw key. */
  scopes: MemoryScopeRef[];
  source: MemorySourceRef;
  markers?: LearningMarkerConfig;
  /** false when no reply was committed or the turn threw: nothing is written. */
  turnCommitted: boolean;
  save: (input: PublicSaveMemoryInput) => Promise<{ memoryId: string }>;
  /** Existing active row with the same derived topic, for supersede-not-duplicate. */
  findExisting: (topic: string) => Promise<{ memory_id: string } | null>;
  update?: (memoryId: string, input: { summary: string; details: string }) => Promise<void>;
}

export interface ObserveOwnerTurnResult {
  kind: 'policy' | 'lesson' | 'none';
  topic?: string;
  memoryId?: string;
  deduped?: boolean;
  reason: string;
}

export const HOST_LEARNING_SOURCE_TYPE = 'owner_turn_observer';

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Stable per (channel, text): the same correction twice is one row. */
export function learningTopic(
  kind: 'policy' | 'lesson',
  noun: string,
  channelScopeId: string | null,
  text: string
): string {
  const digest = createHash('sha1')
    .update(`${channelScopeId ?? ''}\0${normalizeText(text)}`)
    .digest('hex')
    .slice(0, 12);
  const prefix = kind === 'policy' ? POLICY_TOPIC_PREFIX : LESSON_TOPIC_PREFIX;
  return `${prefix}${noun}-${digest}`;
}

export async function observeOwnerTurn(
  input: ObserveOwnerTurnInput
): Promise<ObserveOwnerTurnResult> {
  if (!input.turnCommitted) {
    return { kind: 'none', reason: 'turn not committed' };
  }
  const detected = detectDurableInstruction(
    input.userMessage,
    input.markers ?? DEFAULT_LEARNING_MARKERS
  );
  if (detected.kind === 'none' || !detected.topicNoun) {
    return { kind: 'none', reason: detected.reason };
  }
  const channelScopeId = input.scopes.find((scope) => scope.kind === 'channel')?.id ?? null;
  // A policy hash is project-wide too: the same rule from any owner channel is one row.
  const topic = learningTopic(
    detected.kind,
    detected.topicNoun,
    detected.kind === 'policy' ? null : channelScopeId,
    input.userMessage
  );
  const summary = input.userMessage.replace(/\s+/g, ' ').trim().slice(0, 400);
  const details = `Owner ${detected.kind === 'policy' ? 'rule' : 'correction'} recorded from chat; markers: ${detected.matchedMarkers.join(', ')}.`;

  const existing = await input.findExisting(topic);
  if (existing) {
    if (input.update) {
      await input.update(existing.memory_id, { summary, details });
    }
    return {
      kind: detected.kind,
      topic,
      memoryId: existing.memory_id,
      deduped: true,
      reason: detected.reason,
    };
  }
  // A RULE is project-wide: it must reach event and scheduled turns, whose channel scopes
  // are never the owner's chat channel. A CORRECTION stays bound to the channel it was
  // given in. Writing the chat channel onto a policy row was the defect that made every
  // later turn read policyIds=[].
  const scopes =
    detected.kind === 'policy'
      ? input.scopes.filter((scope) => scope.kind !== 'channel')
      : input.scopes;
  const saved = await input.save({
    topic,
    kind: detected.kind === 'policy' ? 'decision' : 'lesson',
    summary,
    details,
    scopes,
    source: { ...input.source, source_type: HOST_LEARNING_SOURCE_TYPE },
  });
  return { kind: detected.kind, topic, memoryId: saved.memoryId, reason: detected.reason };
}
