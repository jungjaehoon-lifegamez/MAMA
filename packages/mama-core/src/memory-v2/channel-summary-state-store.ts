import crypto from 'node:crypto';

import { getAdapter, initDB } from '../db-manager.js';
import { getChannelSummary, upsertChannelSummary } from './channel-summary-store.js';
import { appendMemoryEvent } from './event-store.js';
import { createAuditFinding } from './finding-store.js';
import type { ChannelSummaryStateRecord, MemoryAuditAck, MemoryScopeRef } from './types.js';

const MAX_ACTIVE_DECISIONS = 6;
const MAX_RECENT_MILESTONES = 8;
const MAX_RECENT_AUDIT_OUTCOMES = 6;

type ChannelSummaryStatePayload = Pick<
  ChannelSummaryStateRecord,
  'active_topic' | 'active_decisions' | 'recent_milestones' | 'recent_audit_outcomes'
>;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function createStateHash(state: ChannelSummaryStatePayload): string {
  return crypto.createHash('sha1').update(JSON.stringify(state)).digest('hex');
}

function deserializeState(row: Record<string, unknown>): ChannelSummaryStateRecord {
  const parsed = JSON.parse(String(row.state_json)) as Omit<
    ChannelSummaryStateRecord,
    'channel_key' | 'state_hash' | 'updated_at'
  >;

  return {
    channel_key: String(row.channel_key),
    active_topic: parsed.active_topic,
    active_decisions: parsed.active_decisions ?? [],
    recent_milestones: parsed.recent_milestones ?? [],
    recent_audit_outcomes: parsed.recent_audit_outcomes ?? [],
    state_hash: String(row.state_hash),
    updated_at: Number(row.updated_at),
  };
}

function createEmptyState(channelKey: string): ChannelSummaryStateRecord {
  const now = Date.now();
  const base: ChannelSummaryStatePayload = {
    active_topic: undefined,
    active_decisions: [],
    recent_milestones: [],
    recent_audit_outcomes: [],
  };

  return {
    channel_key: channelKey,
    ...base,
    state_hash: createStateHash(base),
    updated_at: now,
  };
}

function createLegacySeedState(
  channelKey: string,
  legacySummary: { summary_markdown: string; updated_at: number }
): ChannelSummaryStateRecord {
  const base: ChannelSummaryStatePayload = {
    active_topic: undefined,
    active_decisions: [],
    recent_milestones: [
      {
        topic: 'legacy_summary',
        action: 'no_op' as const,
        summary: legacySummary.summary_markdown.replace(/\s+/g, ' ').trim(),
        timestamp: legacySummary.updated_at,
      },
    ],
    recent_audit_outcomes: [],
  };

  return {
    channel_key: channelKey,
    ...base,
    state_hash: createStateHash(base),
    updated_at: legacySummary.updated_at,
  };
}

function renderChannelSummaryMarkdown(state: ChannelSummaryStateRecord): string {
  const lines: string[] = ['## Channel Summary'];

  if (state.active_topic) {
    lines.push(`- Current topic: ${state.active_topic}`);
  }

  if (state.active_decisions.length > 0) {
    lines.push('', '## Active Decisions');
    for (const decision of state.active_decisions) {
      lines.push(`- ${decision.topic}: ${truncate(decision.summary, 160)}`);
    }
  }

  if (state.recent_milestones.length > 0) {
    lines.push('', '## Recent Milestones');
    for (const milestone of state.recent_milestones) {
      lines.push(`- ${milestone.topic} (${milestone.action}): ${truncate(milestone.summary, 140)}`);
    }
  }

  if (state.recent_audit_outcomes.length > 0) {
    lines.push('', '## Audit Signals');
    for (const outcome of state.recent_audit_outcomes) {
      const note = outcome.reason ? ` — ${truncate(outcome.reason, 120)}` : '';
      lines.push(`- ${outcome.topic}: ${outcome.status}${note}`);
    }
  }

  return lines.join('\n');
}

function reduceState(
  previous: ChannelSummaryStateRecord,
  input: {
    topic: string;
    ack: MemoryAuditAck;
    savedMemories?: Array<{ id: string; topic: string; summary: string }>;
    timestamp: number;
  }
): ChannelSummaryStateRecord {
  const next: ChannelSummaryStateRecord = {
    ...previous,
    active_decisions: previous.active_decisions.slice(),
    recent_milestones: previous.recent_milestones.slice(),
    recent_audit_outcomes: previous.recent_audit_outcomes.slice(),
    updated_at: input.timestamp,
  };

  next.recent_audit_outcomes.unshift({
    topic: input.topic,
    status: input.ack.status,
    reason: input.ack.reason,
    timestamp: input.timestamp,
  });
  next.recent_audit_outcomes = next.recent_audit_outcomes.slice(0, MAX_RECENT_AUDIT_OUTCOMES);

  if (input.ack.status === 'applied' && input.savedMemories && input.savedMemories.length > 0) {
    next.active_topic = input.savedMemories[0]?.topic ?? input.topic;

    for (const memory of input.savedMemories) {
      next.active_decisions = next.active_decisions.filter(
        (entry) => entry.memory_id !== memory.id && entry.topic !== memory.topic
      );
      next.active_decisions.unshift({
        memory_id: memory.id,
        topic: memory.topic,
        summary: memory.summary,
        updated_at: input.timestamp,
      });

      next.recent_milestones.unshift({
        topic: memory.topic,
        action: input.ack.action,
        summary: memory.summary,
        timestamp: input.timestamp,
        memory_id: memory.id,
      });
    }

    next.active_decisions = next.active_decisions.slice(0, MAX_ACTIVE_DECISIONS);
    next.recent_milestones = next.recent_milestones.slice(0, MAX_RECENT_MILESTONES);
  }

  const stateHash = createStateHash({
    active_topic: next.active_topic,
    active_decisions: next.active_decisions,
    recent_milestones: next.recent_milestones,
    recent_audit_outcomes: next.recent_audit_outcomes,
  });

  return {
    ...next,
    state_hash: stateHash,
  };
}

export async function getChannelSummaryState(
  channelKey: string
): Promise<ChannelSummaryStateRecord | null> {
  await initDB();
  const adapter = getAdapter();
  const row = adapter
    .prepare(
      `
        SELECT channel_key, state_json, state_hash, updated_at
        FROM channel_summary_state
        WHERE channel_key = ?
      `
    )
    .get(channelKey) as Record<string, unknown> | undefined;

  return row ? deserializeState(row) : null;
}

export async function recordChannelAudit(input: {
  channelKey: string;
  turnId: string;
  topic: string;
  scopeRefs: MemoryScopeRef[];
  ack: MemoryAuditAck;
  savedMemories?: Array<{ id: string; topic: string; summary: string }>;
}): Promise<{ eventIds: string[]; findingIds: string[]; state: ChannelSummaryStateRecord }> {
  await initDB();
  const adapter = getAdapter();
  const timestamp = Date.now();
  const legacySummary = await getChannelSummary(input.channelKey);
  const previous =
    (await getChannelSummaryState(input.channelKey)) ??
    (legacySummary
      ? createLegacySeedState(input.channelKey, legacySummary)
      : createEmptyState(input.channelKey));
  const eventIds: string[] = [];
  const findingIds: string[] = [];

  const eventType =
    input.ack.status === 'failed'
      ? 'audit_failed'
      : input.ack.action === 'no_op'
        ? 'no_op'
        : input.ack.action;

  eventIds.push(
    await appendMemoryEvent({
      event_type: eventType,
      actor: 'memory_agent',
      source_turn_id: input.turnId,
      memory_id: input.savedMemories?.[0]?.id,
      topic: input.topic,
      scope_refs: input.scopeRefs,
      reason: input.ack.reason,
      created_at: timestamp,
    })
  );

  if (input.ack.status === 'failed') {
    findingIds.push(
      await createAuditFinding({
        kind: 'unsupported_claim',
        severity: 'high',
        summary: input.ack.reason ?? `memory audit failed for ${input.topic}`,
        evidence_refs: eventIds,
        affected_memory_ids: input.savedMemories?.map((memory) => memory.id) ?? [],
        recommended_action: 'consult_memory',
      })
    );
  }

  const state = reduceState(previous, {
    topic: input.topic,
    ack: input.ack,
    savedMemories: input.savedMemories,
    timestamp,
  });

  adapter
    .prepare(
      `
        INSERT OR REPLACE INTO channel_summary_state (
          channel_key,
          state_json,
          state_hash,
          updated_at
        )
        VALUES (?, ?, ?, ?)
      `
    )
    .run(
      input.channelKey,
      JSON.stringify({
        active_topic: state.active_topic,
        active_decisions: state.active_decisions,
        recent_milestones: state.recent_milestones,
        recent_audit_outcomes: state.recent_audit_outcomes,
      } satisfies ChannelSummaryStatePayload),
      state.state_hash,
      timestamp
    );

  await upsertChannelSummary({
    channelKey: input.channelKey,
    summaryMarkdown: renderChannelSummaryMarkdown(state),
    deltaHash: state.state_hash,
  });

  return { eventIds, findingIds, state };
}
