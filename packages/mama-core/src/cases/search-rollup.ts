import type { AdapterLike } from './wiki-page-index.js';
import { resolveCanonicalCaseChain } from './store.js';
import type { SearchHitDiagnostics } from '../search/search-quality.js';

export type { AdapterLike };

export interface SearchRollupLeafHit {
  source_type: 'decision' | 'checkpoint' | 'wiki_page' | 'connector_event';
  source_id: string;
  fused_rank_score: number;
  page_type?: 'case';
  case_id?: string | null;
  record: unknown;
  retrieval_diagnostics?: SearchHitDiagnostics;
}

export interface SearchRollupResult {
  source_type: 'decision' | 'checkpoint' | 'wiki_page' | 'case' | 'standalone_connector_hit';
  source_id: string;
  case_id: string | null;
  score: number;
  contributing_leaves?: string[];
  contributing_leaf_diagnostics?: Record<string, SearchHitDiagnostics>;
  retrieval_diagnostics?: SearchHitDiagnostics;
  record: unknown;
}

interface CaseGroup {
  case_id: string;
  score: number;
  max_leaf_score: number;
  contributing_leaves: Set<string>;
  contributing_leaf_diagnostics: Map<string, SearchHitDiagnostics>;
  retrieval_diagnostics?: SearchHitDiagnostics;
  dedupe_keys: Set<string>;
  record: unknown;
}

function sourceKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function searchHitDiagnostics(value: unknown): SearchHitDiagnostics | undefined {
  const object = objectRecord(value);
  if (!object) {
    return undefined;
  }
  if (
    typeof object.retrieval_source !== 'string' ||
    typeof object.is_vector_only !== 'boolean' ||
    typeof object.lexical_support !== 'boolean' ||
    typeof object.entity_support !== 'boolean'
  ) {
    return undefined;
  }
  return value as SearchHitDiagnostics;
}

function leafDiagnostics(leaf: SearchRollupLeafHit): SearchHitDiagnostics | undefined {
  const record = objectRecord(leaf.record);
  return leaf.retrieval_diagnostics ?? searchHitDiagnostics(record?.retrieval_diagnostics);
}

function diagnosticsRank(diagnostics: SearchHitDiagnostics): number {
  let rank = 0;
  rank += diagnostics.confirmation_signals.length * 100;
  if (diagnostics.lexical_support) {
    rank += 20;
  }
  if (diagnostics.entity_support) {
    rank += 20;
  }
  if (diagnostics.graph_source === 'primary') {
    rank += 10;
  }
  if (!diagnostics.is_vector_only) {
    rank += 1;
  }
  return rank;
}

function betterDiagnostics(
  candidate: SearchHitDiagnostics,
  current: SearchHitDiagnostics | undefined
): boolean {
  if (!current) {
    return true;
  }
  return diagnosticsRank(candidate) > diagnosticsRank(current);
}

function diagnosticsRecord(
  diagnosticsByLeaf: Map<string, SearchHitDiagnostics>
): Record<string, SearchHitDiagnostics> | undefined {
  if (diagnosticsByLeaf.size === 0) {
    return undefined;
  }
  return Object.fromEntries(
    Array.from(diagnosticsByLeaf.entries()).sort(([left], [right]) => left.localeCompare(right))
  );
}

function attachLeafDiagnostics(group: CaseGroup, leaf: SearchRollupLeafHit): void {
  const diagnostics = leafDiagnostics(leaf);
  if (!diagnostics) {
    return;
  }
  group.contributing_leaf_diagnostics.set(leaf.source_id, diagnostics);
  if (betterDiagnostics(diagnostics, group.retrieval_diagnostics)) {
    group.retrieval_diagnostics = diagnostics;
  }
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error('Cannot build SQL IN clause for an empty value list.');
  }
  return values.map(() => '?').join(', ');
}

function withCaseId(record: unknown, caseId: string): unknown {
  const object = objectRecord(record);
  if (!object) {
    return { case_id: caseId };
  }
  return { ...object, case_id: caseId };
}

function loadCaseRecord(adapter: AdapterLike, caseId: string): unknown {
  const row = adapter.prepare('SELECT * FROM case_truth WHERE case_id = ?').get(caseId) as
    | Record<string, unknown>
    | undefined;

  return row ?? { case_id: caseId };
}

function canonicalCaseId(adapter: AdapterLike, caseId: string): string {
  return resolveCanonicalCaseChain(adapter, caseId).terminal_case_id;
}

function listActiveMembershipCaseIds(
  adapter: AdapterLike,
  sourceType: string,
  sourceId: string
): string[] {
  const rows = adapter
    .prepare(
      `
        SELECT case_id
        FROM case_memberships
        WHERE source_type = ?
          AND source_id = ?
          AND status = 'active'
      `
    )
    .all(sourceType, sourceId) as Array<{ case_id: string }>;

  return rows.map((row) => row.case_id);
}

function uniqueStrings(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function listConnectorEventMembershipCaseIds(
  adapter: AdapterLike,
  leaf: SearchRollupLeafHit
): string[] {
  const record = objectRecord(leaf.record) ?? {};
  const sourceConnector = stringOrNull(record.source_connector);
  const sourceLocator = stringOrNull(record.source_locator);
  const artifactLocator = stringOrNull(record.artifact_locator);
  const candidates = uniqueStrings([sourceLocator, artifactLocator]);

  const caseIds = new Set<string>();

  if (sourceConnector && sourceLocator) {
    const observationRows = adapter
      .prepare(
        `
          SELECT cm.case_id
          FROM entity_observations eo
          JOIN case_memberships cm
            ON cm.source_type = 'observation'
           AND cm.source_id = eo.id
           AND cm.status = 'active'
          WHERE eo.source_connector = ?
            AND eo.source_locator = ?
        `
      )
      .all(sourceConnector, sourceLocator) as Array<{ case_id: string }>;

    for (const row of observationRows) {
      caseIds.add(row.case_id);
    }
  }

  if (candidates.length > 0) {
    const artifactRows = adapter
      .prepare(
        `
          SELECT case_id
          FROM case_memberships
          WHERE source_type = 'artifact'
            AND status = 'active'
            AND source_id IN (${placeholders(candidates)})
        `
      )
      .all(...candidates) as Array<{ case_id: string }>;

    for (const row of artifactRows) {
      caseIds.add(row.case_id);
    }
  }

  return Array.from(caseIds).sort((left, right) => left.localeCompare(right));
}

function membershipCaseIdsForLeaf(adapter: AdapterLike, leaf: SearchRollupLeafHit): string[] {
  if (leaf.source_type === 'connector_event') {
    return listConnectorEventMembershipCaseIds(adapter, leaf);
  }
  return listActiveMembershipCaseIds(adapter, leaf.source_type, leaf.source_id);
}

function upsertOrphan(orphans: Map<string, SearchRollupResult>, leaf: SearchRollupLeafHit): void {
  const key = sourceKey(leaf.source_type, leaf.source_id);
  const existing = orphans.get(key);
  if (existing && existing.score >= leaf.fused_rank_score) {
    return;
  }

  const diagnostics = leafDiagnostics(leaf);
  const contributingLeafDiagnostics = diagnostics ? { [leaf.source_id]: diagnostics } : undefined;

  orphans.set(key, {
    source_type:
      leaf.source_type === 'connector_event' ? 'standalone_connector_hit' : leaf.source_type,
    source_id: leaf.source_id,
    case_id: null,
    score: leaf.fused_rank_score,
    ...(diagnostics ? { retrieval_diagnostics: diagnostics } : {}),
    ...(contributingLeafDiagnostics
      ? { contributing_leaf_diagnostics: contributingLeafDiagnostics }
      : {}),
    record: leaf.record,
  });
}

function upsertDirectCase(
  directCases: Map<string, CaseGroup>,
  adapter: AdapterLike,
  leaf: SearchRollupLeafHit,
  caseId: string
): string {
  const survivorCaseId = canonicalCaseId(adapter, caseId);
  const existing = directCases.get(survivorCaseId);
  if (!existing || leaf.fused_rank_score > existing.score) {
    directCases.set(survivorCaseId, {
      case_id: survivorCaseId,
      score: leaf.fused_rank_score,
      max_leaf_score: leaf.fused_rank_score,
      contributing_leaves: new Set([leaf.source_id]),
      contributing_leaf_diagnostics: new Map(),
      dedupe_keys: new Set([leaf.source_id]),
      record: withCaseId(leaf.record, survivorCaseId),
    });
  }
  const group = directCases.get(survivorCaseId);
  if (group) {
    attachLeafDiagnostics(group, leaf);
  }
  return survivorCaseId;
}

function upsertCaseGroup(
  groups: Map<string, CaseGroup>,
  adapter: AdapterLike,
  leaf: SearchRollupLeafHit,
  survivorCaseId: string
): void {
  const dedupeKey = `${survivorCaseId}\0${leaf.source_type}\0${leaf.source_id}`;
  let group = groups.get(survivorCaseId);
  if (!group) {
    group = {
      case_id: survivorCaseId,
      score: 0,
      max_leaf_score: 0,
      contributing_leaves: new Set(),
      contributing_leaf_diagnostics: new Map(),
      dedupe_keys: new Set(),
      record: loadCaseRecord(adapter, survivorCaseId),
    };
    groups.set(survivorCaseId, group);
  }

  if (group.dedupe_keys.has(dedupeKey)) {
    return;
  }

  group.dedupe_keys.add(dedupeKey);
  group.contributing_leaves.add(leaf.source_id);
  attachLeafDiagnostics(group, leaf);
  group.score += leaf.fused_rank_score;
  group.max_leaf_score = Math.max(group.max_leaf_score, leaf.fused_rank_score);
}

function groupToResult(group: CaseGroup): SearchRollupResult {
  const baseRecord = objectRecord(withCaseId(group.record, group.case_id)) ?? {
    case_id: group.case_id,
  };
  const record = { ...baseRecord, max_leaf_score: group.max_leaf_score };
  const contributingLeafDiagnostics = diagnosticsRecord(group.contributing_leaf_diagnostics);
  return {
    source_type: 'case',
    source_id: group.case_id,
    case_id: group.case_id,
    score: group.score,
    contributing_leaves: Array.from(group.contributing_leaves).sort((left, right) =>
      left.localeCompare(right)
    ),
    ...(contributingLeafDiagnostics
      ? { contributing_leaf_diagnostics: contributingLeafDiagnostics }
      : {}),
    ...(group.retrieval_diagnostics ? { retrieval_diagnostics: group.retrieval_diagnostics } : {}),
    record,
  };
}

function maxLeafScore(result: SearchRollupResult): number {
  const object = objectRecord(result.record);
  const value = object?.max_leaf_score;
  return typeof value === 'number' && Number.isFinite(value) ? value : result.score;
}

function compareResults(left: SearchRollupResult, right: SearchRollupResult): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  const leafDelta = maxLeafScore(right) - maxLeafScore(left);
  if (leafDelta !== 0) {
    return leafDelta;
  }

  if (left.source_type === 'case' && right.source_type !== 'case') {
    return -1;
  }
  if (left.source_type !== 'case' && right.source_type === 'case') {
    return 1;
  }

  return left.source_id.localeCompare(right.source_id);
}

export function rollUpSearchHits(input: {
  fusedHits: SearchRollupLeafHit[];
  adapter: AdapterLike;
}): SearchRollupResult[] {
  const directCases = new Map<string, CaseGroup>();
  const directCaseIds = new Set<string>();
  const groupedCases = new Map<string, CaseGroup>();
  const orphans = new Map<string, SearchRollupResult>();

  for (const leaf of input.fusedHits) {
    if (leaf.source_type === 'wiki_page' && leaf.page_type === 'case') {
      if (leaf.case_id) {
        const survivorCaseId = upsertDirectCase(directCases, input.adapter, leaf, leaf.case_id);
        directCaseIds.add(survivorCaseId);
        groupedCases.delete(survivorCaseId);
      } else {
        upsertOrphan(orphans, leaf);
      }
      continue;
    }

    const membershipCaseIds = membershipCaseIdsForLeaf(input.adapter, leaf);

    if (membershipCaseIds.length === 0) {
      upsertOrphan(orphans, leaf);
      continue;
    }

    for (const membershipCaseId of membershipCaseIds) {
      const survivorCaseId = canonicalCaseId(input.adapter, membershipCaseId);
      if (directCaseIds.has(survivorCaseId)) {
        continue;
      }
      upsertCaseGroup(groupedCases, input.adapter, leaf, survivorCaseId);
    }
  }

  return [
    ...Array.from(directCases.values()).map(groupToResult),
    ...Array.from(groupedCases.values())
      .filter((group) => !directCaseIds.has(group.case_id))
      .map(groupToResult),
    ...Array.from(orphans.values()),
  ].sort(compareResults);
}
