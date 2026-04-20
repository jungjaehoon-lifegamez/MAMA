import { getAdapter, initDB } from '../db-manager.js';
import type { MemoryRecord } from '../memory/types.js';

export interface CanonicalReadEntity {
  id: string;
  label: string;
  kind: string;
}

export type ReadIdentity =
  | {
      kind: 'canonical';
      entities: CanonicalReadEntity[];
      primaryEntity: CanonicalReadEntity;
      legacyTopic: string | null;
      shadowConflict: boolean;
      displaySubject?: string | null;
      displayTopic?: string | null;
      displaySuffix?: string | null;
    }
  | {
      kind: 'topic';
      topic: string;
      displaySubject?: string | null;
      displayTopic?: string | null;
      displaySuffix?: string | null;
    }
  | {
      kind: 'raw';
      label: string;
      displaySubject?: string | null;
      displayTopic?: string | null;
      displaySuffix?: string | null;
    };

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function normalizeLooseText(value: string | null | undefined): string {
  return normalizeText(value ?? '')
    .replace(/[_-]+/gu, ' ')
    .replace(/[^\p{Letter}\p{Number}\s/]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function humanizeTopicSegment(segment: string): string {
  return segment.normalize('NFKC').replace(/[_]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function humanizeTopicLabel(topic: string | null | undefined): string | null {
  if (typeof topic !== 'string') {
    return null;
  }

  const segments = topic
    .split('/')
    .map((segment) => humanizeTopicSegment(segment))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    const fallback = humanizeTopicSegment(topic);
    return fallback.length > 0 ? fallback : null;
  }

  return segments.join(' / ');
}

function hasProjectishSignal(label: string | null | undefined): boolean {
  return /(?:案件|相談|窓|民泊|project|room|board|launch|client|feedback|delivery)/iu.test(
    label ?? ''
  );
}

function looksLikeMachineGeneratedLabel(label: string | null | undefined): boolean {
  return /^(slack|chatwork|telegram|line|kakao)(:|$)/iu.test(label ?? '');
}

function looksLikeParticipantLabel(label: string | null | undefined): boolean {
  if (!label) {
    return false;
  }
  const trimmed = label.trim();

  if (/^(kagemusha|system)$/iu.test(trimmed)) {
    return true;
  }
  if (hasProjectishSignal(trimmed)) {
    return false;
  }
  if (/[·,]/u.test(trimmed)) {
    return true;
  }
  if (trimmed.length === 0 || trimmed.length > 20) {
    return false;
  }
  if (/[A-Za-z0-9]/u.test(trimmed)) {
    return false;
  }

  return /^[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\s()]+$/u.test(
    trimmed
  );
}

function hasNonEmptyTopic(record: Pick<MemoryRecord, 'topic'>): boolean {
  return typeof record.topic === 'string' && record.topic.trim().length > 0;
}

function sortCanonicalReadEntities(entities: CanonicalReadEntity[]): CanonicalReadEntity[] {
  return [...entities].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind);
    }
    if (left.label !== right.label) {
      return left.label.localeCompare(right.label);
    }
    return left.id.localeCompare(right.id);
  });
}

function hasShadowConflict(
  record: Pick<MemoryRecord, 'topic' | 'summary'>,
  primaryEntity: CanonicalReadEntity
): boolean {
  if (!hasNonEmptyTopic(record)) {
    return false;
  }

  const summary = normalizeText(record.summary ?? '');
  const label = normalizeText(primaryEntity.label);
  if (!summary || !label) {
    return false;
  }
  if (summary === label) {
    return false;
  }
  if (summary.includes(label) || label.includes(summary)) {
    return false;
  }
  return true;
}

function getLegacyTopic(record: Pick<MemoryRecord, 'topic'>): string | null {
  return hasNonEmptyTopic(record) ? record.topic.trim() : null;
}

function getLegacyNamespace(record: Pick<MemoryRecord, 'topic'>): string | null {
  const legacyTopic = getLegacyTopic(record);
  if (!legacyTopic) {
    return null;
  }
  const humanized = humanizeTopicSegment(legacyTopic.split('/')[0] ?? '');
  if (normalizeLooseText(humanized) === 'entity') {
    return null;
  }
  return humanized || null;
}

function selectDisplayEntity(
  entities: CanonicalReadEntity[],
  primaryEntity: CanonicalReadEntity
): CanonicalReadEntity {
  return (
    entities.find((entity) => ['project', 'work_item', 'organization'].includes(entity.kind)) ??
    primaryEntity
  );
}

function buildDisplaySubject(
  record: Pick<MemoryRecord, 'topic' | 'summary'>,
  entities: CanonicalReadEntity[],
  primaryEntity: CanonicalReadEntity
): string | null {
  const preferredEntity = selectDisplayEntity(entities, primaryEntity);
  const preferredLabel = preferredEntity.label?.trim();
  const legacyNamespace = getLegacyNamespace(record);
  const summary = record.summary?.trim();

  if (summary && typeof record.topic === 'string' && record.topic.startsWith('entity/')) {
    return summary;
  }
  if (
    legacyNamespace &&
    preferredLabel &&
    normalizeLooseText(preferredLabel) !== normalizeLooseText(legacyNamespace) &&
    (looksLikeMachineGeneratedLabel(preferredLabel) || looksLikeParticipantLabel(preferredLabel))
  ) {
    return legacyNamespace;
  }
  if (preferredLabel && !looksLikeMachineGeneratedLabel(preferredLabel)) {
    return preferredLabel;
  }
  if (legacyNamespace) {
    return legacyNamespace;
  }
  return summary || humanizeTopicLabel(getLegacyTopic(record)) || preferredLabel || null;
}

function buildDisplayTopic(
  record: Pick<MemoryRecord, 'topic' | 'summary'>,
  entities: CanonicalReadEntity[],
  primaryEntity: CanonicalReadEntity
): string | null {
  const summary = record.summary?.trim();
  if (summary && typeof record.topic === 'string' && record.topic.startsWith('entity/')) {
    return summary;
  }

  const preferredEntity = selectDisplayEntity(entities, primaryEntity);
  const subjectLabel =
    preferredEntity.kind !== 'person' && preferredEntity.label.trim().length > 0
      ? preferredEntity.label.trim()
      : '';
  const humanizedTopic = humanizeTopicLabel(getLegacyTopic(record));

  if (!subjectLabel) {
    return humanizedTopic || summary || null;
  }
  if (!humanizedTopic) {
    return subjectLabel;
  }

  const normalizedSubject = normalizeLooseText(subjectLabel);
  const normalizedTopic = normalizeLooseText(humanizedTopic);
  const tokens = normalizedTopic.split(' ').filter((token) => token.length > 0);
  const genericTokens = new Set(['spine', 'fb', 'fix', 'pdf', 'sd', 'ex', 'ar', 'r18', 'sp']);
  const informativeTokens = tokens.filter(
    (token) => !genericTokens.has(token) && !/^\d+$/u.test(token) && token.length > 1
  );
  const lowSignalTopic = normalizedTopic.length === 0 || informativeTokens.length === 0;

  if (lowSignalTopic || normalizedTopic === normalizedSubject) {
    return subjectLabel;
  }
  return humanizedTopic;
}

function buildDisplaySuffix(
  record: Pick<MemoryRecord, 'topic' | 'summary'>,
  entities: CanonicalReadEntity[],
  primaryEntity: CanonicalReadEntity
): string | null {
  const displaySubject = buildDisplaySubject(record, entities, primaryEntity);
  const displayTopic = buildDisplayTopic(record, entities, primaryEntity);

  if (!displaySubject || !displayTopic) {
    return null;
  }

  const normalizedSubject = normalizeLooseText(displaySubject);
  const normalizedTopic = normalizeLooseText(displayTopic);
  if (!normalizedTopic || normalizedTopic === normalizedSubject) {
    return null;
  }

  const subjectParts = displaySubject
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  const topicParts = displayTopic
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (topicParts.length > 1 && subjectParts.length > 0) {
    const firstTopicPart = topicParts[0] ?? '';
    const firstSubjectPart = subjectParts[subjectParts.length - 1] ?? '';
    if (normalizeLooseText(firstTopicPart) === normalizeLooseText(firstSubjectPart)) {
      const suffix = topicParts.slice(1).join(' / ').trim();
      return suffix.length > 0 ? suffix : null;
    }
  }

  return displayTopic;
}

export function resolveReadIdentity(
  record: Pick<MemoryRecord, 'topic' | 'summary'>,
  entities: CanonicalReadEntity[]
): ReadIdentity {
  if (entities.length > 0) {
    const sortedEntities = sortCanonicalReadEntities(entities);
    const primaryEntity = sortedEntities[0]!;
    return {
      kind: 'canonical',
      entities: sortedEntities,
      primaryEntity,
      legacyTopic: getLegacyTopic(record),
      shadowConflict: hasShadowConflict(record, primaryEntity),
      displaySubject: buildDisplaySubject(record, sortedEntities, primaryEntity),
      displayTopic: buildDisplayTopic(record, sortedEntities, primaryEntity),
      displaySuffix: buildDisplaySuffix(record, sortedEntities, primaryEntity),
    };
  }

  if (hasNonEmptyTopic(record)) {
    return {
      kind: 'topic',
      topic: record.topic.trim(),
      displaySubject: null,
      displayTopic: humanizeTopicLabel(record.topic),
      displaySuffix: null,
    };
  }

  return {
    kind: 'raw',
    label: record.summary.trim() || '<unknown>',
    displaySubject: null,
    displayTopic: record.summary.trim() || '<unknown>',
    displaySuffix: null,
  };
}

export async function loadDecisionReadIdentityIndex(
  decisionIds: string[]
): Promise<Map<string, CanonicalReadEntity[]>> {
  await initDB();

  const uniqueDecisionIds = Array.from(
    new Set(
      decisionIds
        .filter((decisionId): decisionId is string => typeof decisionId === 'string')
        .map((decisionId) => decisionId.trim())
        .filter((decisionId) => decisionId.length > 0)
    )
  );
  const index = new Map<string, CanonicalReadEntity[]>();
  if (uniqueDecisionIds.length === 0) {
    return index;
  }

  const placeholders = uniqueDecisionIds.map(() => '?').join(', ');
  const rows = getAdapter()
    .prepare(
      `
        SELECT
          des.decision_id,
          n.id AS entity_id,
          n.preferred_label AS entity_label,
          n.kind AS entity_kind
        FROM decision_entity_sources des
        JOIN entity_lineage_links l
          ON l.entity_observation_id = des.entity_observation_id
         AND l.status = 'active'
        JOIN entity_nodes n
          ON n.id = l.canonical_entity_id
        WHERE des.decision_id IN (${placeholders})
          AND n.status = 'active'
          AND n.merged_into IS NULL
        GROUP BY des.decision_id, n.id, n.preferred_label, n.kind
      `
    )
    .all(...uniqueDecisionIds) as Array<{
    decision_id: string;
    entity_id: string;
    entity_label: string;
    entity_kind: string;
  }>;

  for (const row of rows) {
    const existing = index.get(row.decision_id) ?? [];
    existing.push({
      id: row.entity_id,
      label: row.entity_label,
      kind: row.entity_kind,
    });
    index.set(row.decision_id, existing);
  }

  for (const [decisionId, entities] of index.entries()) {
    index.set(decisionId, sortCanonicalReadEntities(entities));
  }

  return index;
}
