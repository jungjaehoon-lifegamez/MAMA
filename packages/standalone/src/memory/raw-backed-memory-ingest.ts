import { getAdapter, saveMemory } from '@jungjaehoon/mama-core';
import type { MemoryKind, MemoryScopeRef, PublicSaveMemoryInput } from '@jungjaehoon/mama-core';

import type { ChannelConfig, NormalizedItem } from '../connectors/framework/types.js';

export type RawBackedMemorySaveInput = PublicSaveMemoryInput;

export interface RawBackedMemoryCandidate extends PublicSaveMemoryInput {
  rawSourceId: string;
}

export interface RawBackedMemoryBuildOptions {
  channelConfig?: ChannelConfig & Record<string, unknown>;
  entityObservationIdsBySourceId?: Map<string, string[]>;
}

export interface RawBackedMemoryIngestOptions extends RawBackedMemoryBuildOptions {
  memoryExists?: (topic: string) => boolean;
  saveMemory?: (input: RawBackedMemorySaveInput) => Promise<{ success?: boolean; id?: string }>;
}

export interface RawBackedMemoryIngestResult {
  candidatesBuilt: number;
  saved: number;
  skippedExisting: number;
}

const WORK_TOKEN_PATTERNS = [
  /\b(?:ex|bc|tf|tk)-?\d+\b/iu,
  /\b(?:task|card|issue|bug|ticket|feedback|review|handoff|deliverable|milestone)\b/iu,
  /\b(?:blocked|waiting|submitted|delivered|done|fixed|approved|proceed)\b/iu,
  /(?:작업|업무|태스크|이슈|버그|피드백|검토|수정|제출|전달|완료|진행|승인|확정|마감|납기)/u, // Korean: work-token patterns
  /(?:確認|修正|提出|納品|完了|進行|承認|確定|締切|レビュー)/u,
];

const DECISION_PATTERNS = [
  /\b(?:decided|confirmed|approved|adopt|go ahead|proceed)\b/iu,
  /(?:결정|확정|승인|채택|진행해|컨펌)/u, // Korean: decision patterns
  /(?:決定|確定|承認|採用|進めて)/u,
];

const SCHEDULE_PATTERNS = [
  /\b(?:deadline|due|today|tomorrow|this week|next week|friday|monday|tuesday|wednesday|thursday)\b/iu,
  /(?:납기|마감|오늘|내일|이번 주|다음 주|금요일|월요일|화요일|수요일|목요일)/u, // Korean: schedule patterns
  /(?:締切|本日|明日|今週|来週|金曜|月曜|火曜|水曜|木曜)/u,
  /\b\d{4}-\d{2}-\d{2}\b/u,
];

const STATUS_PATTERNS = [
  /\b(?:submitted|delivered|done|blocked|waiting|feedback|review|handoff|fixed)\b/iu,
  /(?:제출|전달|완료|피드백|검토|수정|대기|막힘|블로커)/u, // Korean: status patterns
  /(?:提出|納品|完了|修正|待ち|ブロック|レビュー)/u,
];

const CHATTER_ONLY_PATTERNS = [
  /^(?:ok|okay|thanks|thank you|got it|noted)[.! ]*$/iu,
  /^(?:감사합니다|고맙습니다|확인했습니다|넵|네|예|알겠습니다)[.! ]*$/u, // Korean: chatter patterns
  /^(?:ありがとうございます|了解です|承知しました|はい)[。.! ]*$/u,
];

const JAPANESE_CONFIRMATION_BOILERPLATE_PATTERNS = [
  /(?:こちら)?確認(?:します|しました|しております|いたします|いたしました)/u,
  /ご確認(?:ください|願います|お願いします|お願いいたします)/u,
  /ご確認(?:のほど|を)?(?:よろしく|お願いいたします)/u,
  /ご確認ください/u,
];

const MAX_SUMMARY_CONTENT_LENGTH = 360;
const MAX_TOPIC_PART_LENGTH = 80;

function hasPattern(input: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function normalizeTopicPart(input: string): string {
  const normalized = input
    .normalize('NFKC')
    .trim()
    .replace(/[^a-z0-9]+/giu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
  return (normalized || 'unknown').slice(0, MAX_TOPIC_PART_LENGTH);
}

function stringField(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rawConnector(item: NormalizedItem): string {
  return stringField(item.metadata?.rawConnector) ?? item.source;
}

function resolveScope(
  item: NormalizedItem,
  channelConfig?: ChannelConfig & Record<string, unknown>
): MemoryScopeRef | null {
  if (
    item.memoryScopeKind !== undefined &&
    item.memoryScopeId !== undefined &&
    isMemoryScopeKind(item.memoryScopeKind) &&
    item.memoryScopeId.trim().length > 0
  ) {
    return { kind: item.memoryScopeKind, id: item.memoryScopeId.trim() };
  }

  const projectEntityId =
    stringField(channelConfig?.project_entity_id) ??
    stringField(item.metadata?.project_entity_id) ??
    stringField(item.projectId);
  if (projectEntityId) {
    return { kind: 'project', id: projectEntityId };
  }

  return null;
}

function isMemoryScopeKind(input: string): input is MemoryScopeRef['kind'] {
  return input === 'global' || input === 'user' || input === 'channel' || input === 'project';
}

function classifyMemory(item: NormalizedItem): {
  kind: MemoryKind;
  confidence: number;
  hasSubstantiveSignal: boolean;
} {
  const content = item.content.trim();
  if (content.length === 0 || hasPattern(content, CHATTER_ONLY_PATTERNS)) {
    return { kind: 'fact', confidence: 0.5, hasSubstantiveSignal: false };
  }

  const hasWorkSignal = hasPattern(content, WORK_TOKEN_PATTERNS);
  const hasDecisionSignal = hasPattern(content, DECISION_PATTERNS);
  const hasScheduleSignal = hasPattern(content, SCHEDULE_PATTERNS);
  const hasStatusSignal = hasPattern(content, STATUS_PATTERNS);
  const isJapaneseConfirmationBoilerplate = hasPattern(
    content,
    JAPANESE_CONFIRMATION_BOILERPLATE_PATTERNS
  );

  if (!hasWorkSignal && !hasDecisionSignal && !hasScheduleSignal && !hasStatusSignal) {
    return { kind: 'fact', confidence: 0.5, hasSubstantiveSignal: false };
  }
  if (isJapaneseConfirmationBoilerplate && !hasDecisionSignal && !hasScheduleSignal) {
    return { kind: 'fact', confidence: 0.5, hasSubstantiveSignal: false };
  }

  if (hasDecisionSignal) {
    return { kind: 'decision', confidence: 0.72, hasSubstantiveSignal: true };
  }
  if (hasScheduleSignal) {
    return { kind: 'schedule', confidence: 0.68, hasSubstantiveSignal: true };
  }
  if (/\b(?:task|ticket|issue|card)\b/iu.test(content) || /(?:작업|태스크|이슈)/u.test(content)) {
    // Korean: task patterns
    return { kind: 'task', confidence: 0.62, hasSubstantiveSignal: true };
  }
  return { kind: 'fact', confidence: 0.58, hasSubstantiveSignal: true };
}

function eventDate(input: Date): string {
  return input.toISOString().slice(0, 10);
}

function buildTopic(item: NormalizedItem, scope: MemoryScopeRef): string {
  const scopeKey =
    scope.kind === 'project' && scope.id.startsWith('project_')
      ? scope.id
      : `${scope.kind}_${scope.id}`;
  return [
    'raw',
    normalizeTopicPart(scopeKey),
    normalizeTopicPart(item.channel),
    normalizeTopicPart(item.sourceId),
  ].join('/');
}

function buildSummary(item: NormalizedItem): string {
  const content =
    item.content.length > MAX_SUMMARY_CONTENT_LENGTH
      ? `${item.content.slice(0, MAX_SUMMARY_CONTENT_LENGTH - 1)}...`
      : item.content;
  return `${item.author} @ ${item.channel}: ${content}`;
}

function buildDetails(item: NormalizedItem, sourceConnector: string): string {
  return [
    'Deterministic raw-backed memory candidate.',
    'Stored before LLM curation so later agents can link, merge, or discard it with full source evidence.',
    `raw_connector=${sourceConnector}`,
    `raw_source_id=${item.sourceId}`,
  ].join(' ');
}

function defaultMemoryExists(topic: string): boolean {
  const adapter = getAdapter();
  const row = adapter
    .prepare(
      `
        SELECT 1 AS present
        FROM decisions
        WHERE topic = ?
          AND (status = 'active' OR status IS NULL)
          AND superseded_by IS NULL
        LIMIT 1
      `
    )
    .get(topic) as { present: number } | undefined;
  return row !== undefined;
}

export function buildRawBackedMemoryCandidates(
  items: NormalizedItem[],
  options: RawBackedMemoryBuildOptions = {}
): RawBackedMemoryCandidate[] {
  const candidates: RawBackedMemoryCandidate[] = [];

  for (const item of items) {
    const classification = classifyMemory(item);
    if (!classification.hasSubstantiveSignal) {
      continue;
    }

    const scope = resolveScope(item, options.channelConfig);
    if (!scope) {
      continue;
    }
    const sourceConnector = rawConnector(item);
    const observationIds = options.entityObservationIdsBySourceId?.get(item.sourceId) ?? [];
    const topic = buildTopic(item, scope);

    candidates.push({
      rawSourceId: item.sourceId,
      topic,
      kind: classification.kind,
      summary: buildSummary(item),
      details: buildDetails(item, sourceConnector),
      confidence: classification.confidence,
      scopes: [scope],
      source: {
        package: 'standalone',
        source_type: 'connector-raw-evidence',
        channel_id: item.channel,
        project_id: scope.kind === 'project' ? scope.id : undefined,
      },
      eventDate: eventDate(item.timestamp),
      eventDateTime: item.timestamp.getTime(),
      entityObservationIds: observationIds.length > 0 ? observationIds : undefined,
    });
  }

  return candidates;
}

export async function ingestRawBackedMemoryCandidates(
  items: NormalizedItem[],
  options: RawBackedMemoryIngestOptions = {}
): Promise<RawBackedMemoryIngestResult> {
  const candidates = buildRawBackedMemoryCandidates(items, options);
  const memoryExists = options.memoryExists ?? defaultMemoryExists;
  const save = options.saveMemory ?? saveMemory;
  let saved = 0;
  let skippedExisting = 0;

  for (const candidate of candidates) {
    if (memoryExists(candidate.topic)) {
      skippedExisting += 1;
      continue;
    }

    const { rawSourceId: _rawSourceId, ...input } = candidate;
    const result = await save(input);
    if (result.success === false) {
      throw new Error(`[raw-backed-memory] save failed for ${candidate.topic}`);
    }
    saved += 1;
  }

  return {
    candidatesBuilt: candidates.length,
    saved,
    skippedExisting,
  };
}
