import crypto from 'node:crypto';
import { canonicalizeJSON } from '../canonicalize.js';
import { ensureMemoryScope } from '../db-manager.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { appendOutcomeAmendment } from './write-adapters.js';
import { formatList, formatContext } from '../decision-formatter.js';
import { warn as logWarn } from '../debug-logger.js';
import type { TextCompletion } from '../runtime/text-completion.js';
import {
  queryDecisionGraph,
  querySemanticEdges,
  STATED_DECISION_EDGES,
} from '../knowledge/graph-query.js';
import { correctionsOf, type DecisionCorrection } from './decision-links.js';
import {
  rollUpSearchHits,
  type SearchRollupLeafHit,
  type SearchRollupResult,
} from '../knowledge/case-search-rollup.js';
import type { SearchQualityOptions } from '../knowledge/search-quality.js';
import type { SemanticEdgeItem } from '../db-manager.js';
import type { DecisionRecord } from '../db-manager.js';
import type { DatabaseInstance } from '../db-manager.js';
import {
  vectorSearch,
  fts5Search,
  cjkQueryWords,
  ftsMatchTerms,
  ftsWords,
  RECALL_EXCLUDED_STATUSES,
  wordSearch,
  type QueryWord,
} from '../knowledge/search.js';
import type { DecisionInput } from '../db-manager.js';
import { generateEmbedding } from '../embedding/embedder.js';
import { appendJudgment, judgmentRecordId, ingestSource } from '../knowledge/index.js';
import type { JudgmentCommand, JudgmentReceipt, JsonValue } from './judgment-types.js';
import { boundScopesOf, commandEmbedder, writeAccessForProvenance } from './write-adapters.js';
import { classifyProfileEntries } from './profile-builder.js';
import { warn } from '../debug-logger.js';
import { scanMemoryWriteInput, SecretMaterialRefusedError } from './secret-filter.js';
import { createEmptyRecallBundle } from './types.js';
import {
  normalizeSearchQualityOptions,
  type SearchHitDiagnostics,
} from '../knowledge/search-quality.js';
import type {
  MemoryKind,
  MemoryKindFilter,
  MemoryReachedThrough,
  MemoryEdge,
  MemoryRecord,
  MemoryScopeKind,
  MemoryScopeRef,
  MemoryStatus,
  ProfileSnapshot,
  PublicIngestMemoryInput,
  PublicSaveMemoryInput,
  RecallBundle,
  IngestConversationInput,
  IngestConversationResult,
  RecallMemoryOptions,
  RecallSearchDiagnostics,
} from './types.js';
import {
  normalizeMemoryWriteProvenance,
  sanitizePublicIngestConversationInput,
  sanitizePublicIngestMemoryInput,
  sanitizePublicSaveMemoryInput,
  type NormalizedMemoryProvenance,
} from './provenance.js';
import { JudgmentError, type JudgmentAccess } from '../knowledge/judgments.js';
import type { ActionSessionFacts } from '../action-contracts.js';
import { validateRecordIdentityReferences } from '../registry/record-identity.js';

type SaveMemoryInput = PublicSaveMemoryInput;
type IngestMemoryInput = PublicIngestMemoryInput;

export interface LegacyMemoryPersistence {
  userInvolvement?: string | null;
  outcome?: string | null;
  failureReason?: string | null;
  limitation?: string | null;
  isStatic?: number;
}

export interface FusedHit {
  source_type: 'decision';
  source_id: string;
  record: MemoryRecord;
  fused_rank_score: number;
  case_id?: string | null;
  retrieval_diagnostics?: SearchHitDiagnostics;
}

export function buildDecisionId(topic: string): string {
  // Non-ASCII topics (Korean etc.) used to collapse into bare underscore runs
  // ("decision_______<ts>") - unreadable and near-colliding. Collapse the runs
  // and fall back to a stable topic hash when nothing ASCII survives; the
  // human-readable topic itself is stored verbatim in the topic column.
  const safeTopic = topic
    .replace(/[^a-z0-9_]+/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  // sha256 (not sha1) purely to keep SAST scanners quiet - this is an id slug, not crypto.
  const slug =
    safeTopic || `t${crypto.createHash('sha256').update(topic).digest('hex').slice(0, 8)}`;
  return `decision_${slug}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function buildSaveEventReason(toolName: string | null, gatewayCallId: string | null): string {
  const parts = ['saved'];
  if (toolName) {
    parts.push(`via ${toolName}`);
  }
  if (gatewayCallId) {
    parts.push(`gateway_call_id=${gatewayCallId}`);
  }
  return parts.join(' ');
}

function toMemoryRecord(
  row: Record<string, unknown>,
  scopes: MemoryScopeRef[],
  fallbackSource: SaveMemoryInput['source']
): MemoryRecord {
  let trustContext = null;
  if (typeof row.trust_context === 'string') {
    try {
      trustContext = JSON.parse(row.trust_context);
    } catch {
      /* malformed */
    }
  }
  const savedSource = trustContext?.source;
  let guidance: Record<string, unknown> = {};
  if (typeof row.payload_json === 'string') {
    try {
      const payload = JSON.parse(row.payload_json) as { guidance?: unknown };
      if (
        payload.guidance &&
        typeof payload.guidance === 'object' &&
        !Array.isArray(payload.guidance)
      ) {
        guidance = payload.guidance as Record<string, unknown>;
      }
    } catch {
      /* malformed payloads do not become guidance */
    }
  }
  const steps = Array.isArray(guidance.steps)
    ? guidance.steps.filter((step): step is string => typeof step === 'string')
    : undefined;
  const evidenceChecks = Array.isArray(guidance.evidence_checks)
    ? guidance.evidence_checks.filter((check): check is string => typeof check === 'string')
    : undefined;

  return {
    id: String(row.id),
    topic: String(row.topic),
    kind: (row.kind as MemoryKind) ?? 'decision',
    summary: String(row.summary ?? row.decision ?? ''),
    details: String(row.reasoning ?? row.decision ?? ''),
    ...(typeof guidance.applies_when === 'string' ? { applies_when: guidance.applies_when } : {}),
    ...(steps === undefined ? {} : { steps }),
    ...(evidenceChecks === undefined ? {} : { evidence_checks: evidenceChecks }),
    confidence: Number(row.confidence ?? 0.5),
    status: (row.status as MemoryStatus) ?? 'active',
    scopes,
    source: savedSource ?? fallbackSource,
    created_at: row.created_at as number | string,
    updated_at: (row.updated_at as number | string) ?? (row.created_at as number | string),
    event_date: (row.event_date as string) ?? null,
    event_datetime:
      typeof row.event_datetime === 'number' && Number.isFinite(row.event_datetime)
        ? row.event_datetime
        : null,
    outcome: (row.outcome as string | null) ?? null,
  };
}

function scopeBoundRowsClause(scopes: readonly MemoryScopeRef[], alias = 'd') {
  if (scopes.length === 0) return { sql: '0', params: [] as string[] };
  const alternatives = scopes.map(() => '(s.kind = ? AND s.external_id = ?)').join(' OR ');
  return {
    sql: `EXISTS (
      SELECT 1 FROM memory_scope_bindings b
      JOIN memory_scopes s ON s.id = b.scope_id
      WHERE b.memory_id = ${alias}.id AND (${alternatives})
    )`,
    params: scopes.flatMap((scope) => [scope.kind, scope.id]),
  };
}

export interface ReadMemoryRecordsOptions {
  kind?: MemoryKindFilter;
  status?: MemoryStatus | readonly MemoryStatus[];
  /** Leave out records that only amend another (a retirement or an outcome change), as recall does. */
  excludeAmendments?: boolean;
}

/** Read complete memory records whose stored scopes intersect the admitted scopes. */
export async function readMemoryRecordsInScopes(
  adapter: DatabaseInstance,
  scopes: readonly MemoryScopeRef[],
  options: ReadMemoryRecordsOptions = {}
): Promise<MemoryRecord[]> {
  const scopeClause = scopeBoundRowsClause(scopes);
  const conditions = [scopeClause.sql];
  const params: Array<string | number> = [...scopeClause.params];
  const kinds =
    options.kind === undefined ? [] : Array.isArray(options.kind) ? options.kind : [options.kind];
  if (kinds.length > 0) {
    conditions.push(`d.kind IN (${kinds.map(() => '?').join(', ')})`);
    params.push(...kinds);
  }
  const statuses =
    options.status === undefined
      ? []
      : Array.isArray(options.status)
        ? options.status
        : [options.status];
  if (statuses.length > 0) {
    conditions.push(`COALESCE(d.status, 'active') IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (options.excludeAmendments === true) {
    conditions.push(`json_extract(d.payload_json, '$.amended') IS NULL`);
  }
  const rows = adapter
    .prepare(
      `SELECT d.id, d.topic, d.decision, d.reasoning, d.confidence, d.created_at, d.updated_at,
              d.trust_context, d.kind, d.status, d.summary, d.event_date, d.event_datetime,
              d.outcome, d.payload_json
       FROM decisions d
       WHERE ${conditions.join(' AND ')}
       ORDER BY d.created_at ASC, d.id ASC`
    )
    .all(...params) as Record<string, unknown>[];
  const scopesById = batchLoadScopes(
    adapter,
    rows.map((row) => String(row.id))
  );
  const fallbackSource: SaveMemoryInput['source'] = { package: 'mama-core', source_type: 'db' };
  return rows.map((row) =>
    toMemoryRecord(row, scopesById.get(String(row.id)) ?? [], fallbackSource)
  );
}

/** Read one complete record only when at least one stored scope is admitted. */
export async function readMemoryRecordById(
  adapter: DatabaseInstance,
  memoryId: string,
  scopes: readonly MemoryScopeRef[]
): Promise<MemoryRecord | null> {
  const id = memoryId.trim();
  const scopeClause = scopeBoundRowsClause(scopes);
  if (!id || scopes.length === 0) return null;
  const row = adapter
    .prepare(
      `SELECT d.id, d.topic, d.decision, d.reasoning, d.confidence, d.created_at, d.updated_at,
              d.trust_context, d.kind, d.status, d.summary, d.event_date, d.event_datetime,
              d.outcome, d.payload_json
       FROM decisions d
       WHERE d.id = ? AND ${scopeClause.sql}
       LIMIT 1`
    )
    .get(id, ...scopeClause.params) as Record<string, unknown> | undefined;
  if (!row) return null;
  const recordScopes = batchLoadScopes(adapter, [id]).get(id) ?? [];
  return toMemoryRecord(row, recordScopes, { package: 'mama-core', source_type: 'db' });
}

/** The records that state these corrections, down their chains. */
function correctionAuthors(corrections: readonly DecisionCorrection[]): string[] {
  return corrections.flatMap((correction) => [
    correction.from,
    ...correctionAuthors(correction.correctedBy ?? []),
  ]);
}

/** The corrections a reader may see; a hidden correction takes the corrections of it along. */
function readableCorrections(
  corrections: readonly DecisionCorrection[],
  readable: (correction: DecisionCorrection) => boolean
): DecisionCorrection[] | undefined {
  const kept = corrections.filter(readable).map((correction) => {
    const further = correction.correctedBy
      ? readableCorrections(correction.correctedBy, readable)
      : undefined;
    const { correctedBy: _drop, ...rest } = correction;
    return further ? { ...rest, correctedBy: further } : rest;
  });
  return kept.length > 0 ? kept : undefined;
}

function batchLoadScopes(
  adapter: DatabaseInstance,
  memoryIds: string[]
): Map<string, MemoryScopeRef[]> {
  const scopeMap = new Map<string, MemoryScopeRef[]>();
  if (memoryIds.length === 0) return scopeMap;

  const placeholders = memoryIds.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `
        SELECT msb.memory_id, ms.kind, ms.external_id
        FROM memory_scope_bindings msb
        JOIN memory_scopes ms ON ms.id = msb.scope_id
        WHERE msb.memory_id IN (${placeholders})
        ORDER BY msb.is_primary DESC
      `
    )
    .all(...memoryIds) as Array<{ memory_id: string; kind: string; external_id: string }>;

  for (const row of rows) {
    const existing = scopeMap.get(row.memory_id) ?? [];
    existing.push({ kind: row.kind as MemoryScopeKind, id: row.external_id });
    scopeMap.set(row.memory_id, existing);
  }
  return scopeMap;
}

async function loadScopedMemories(
  adapter: DatabaseInstance,
  scopes: MemoryScopeRef[]
): Promise<MemoryRecord[]> {
  const fallbackSource: SaveMemoryInput['source'] = { package: 'mama-core', source_type: 'db' };

  let rows: Record<string, unknown>[];

  if (scopes.length === 0) {
    rows = adapter
      .prepare(
        `
          SELECT id, topic, decision, reasoning, confidence, created_at, updated_at, trust_context,
                 kind, status, summary, event_date, event_datetime, outcome, payload_json
          FROM decisions
          ORDER BY COALESCE(event_datetime, created_at) DESC, created_at DESC
        `
      )
      .all() as Record<string, unknown>[];
  } else {
    const scopeIds = await Promise.all(
      scopes.map((scope) => ensureMemoryScope(adapter, scope.kind, scope.id))
    );
    const placeholders = scopeIds.map(() => '?').join(', ');
    rows = adapter
      .prepare(
        `
          SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.confidence, d.created_at,
                 d.updated_at, d.trust_context, d.kind, d.status, d.summary, d.event_date, d.event_datetime,
                 d.outcome, d.payload_json
          FROM decisions d
          JOIN memory_scope_bindings msb ON msb.memory_id = d.id
          WHERE msb.scope_id IN (${placeholders})
          ORDER BY COALESCE(d.event_datetime, d.created_at) DESC, d.created_at DESC
        `
      )
      .all(...scopeIds) as Record<string, unknown>[];
  }

  const memoryIds = rows.map((row) => String(row.id));
  const scopeMap = batchLoadScopes(adapter, memoryIds);

  return rows.map((row) => toMemoryRecord(row, scopeMap.get(String(row.id)) ?? [], fallbackSource));
}

export const LEXICAL_STOPWORDS: Set<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'my',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

/**
 * Intentionally minimal English suffix stemmer for fuzzy lexical matching.
 * Not a full Porter/Snowball implementation — imperfect stems (e.g., "running" → "runn")
 * are acceptable for scoring/recall. Avoids pulling in a heavier stemming dependency.
 */
function stemToken(token: string): string {
  if (token.length <= 4) return token;
  // Order matters: try longest suffix first
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

const CJK_TEXT = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Two characters carry a whole word in Korean, Japanese and Chinese, a count of rounds (a digit and
 * a Korean counter) and an acronym such as "FB"; two Latin letters are mostly English function
 * words. Dropping every short token lost the one word that told four feedback rounds from one
 * (owner ledger, 2026-10-03).
 */
function isMeaningfulShortToken(raw: string): boolean {
  return (
    characterCount(raw) === 2 &&
    // Letters and digits only: a token such as "#x" would reach FTS5 MATCH unquoted.
    /^[\p{L}\p{N}]+$/u.test(raw) &&
    (CJK_TEXT.test(raw) || (/\p{N}/u.test(raw) && /\p{L}/u.test(raw)) || /^[A-Z]{2}$/.test(raw))
  );
}

function characterCount(text: string): number {
  return Array.from(text).length;
}

export function getLexicalQueryTokens(query: string): string[] {
  return query
    .split(/[\s,.!?;:()[\]{}"']+/)
    .filter((raw) => characterCount(raw) > 2 || isMeaningfulShortToken(raw))
    .map((raw) => raw.toLowerCase())
    .filter((token) => !LEXICAL_STOPWORDS.has(token));
}

const SHORT_LATIN_TOKEN = /^[a-z0-9]{1,2}$/;

/**
 * A short Latin token (an acronym or a version such as "v2") matches only where no Latin letter
 * or digit touches it: as a substring "ai" is inside "email", while a Korean particle may follow an
 * acronym directly. Other tokens keep substring matching, which is what lets a Korean word match
 * the same word with a particle attached.
 */
function textHasToken(text: string, token: string): boolean {
  if (!SHORT_LATIN_TOKEN.test(token)) {
    return text.includes(token);
  }
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    if (!isAsciiAlnum(text[at - 1]) && !isAsciiAlnum(text[at + token.length])) {
      return true;
    }
  }
  return false;
}

function isAsciiAlnum(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9]/.test(char);
}

/** FTS5 bm25 is more negative for a better match; this maps the best row of a result set to 1. */
function bm25Relevance(rank: number, maxAbsRank: number): number {
  return maxAbsRank > 0 ? Math.abs(rank) / maxAbsRank : 0.5;
}

function queryTokenCount(query: string): number {
  // The cutoff that forces lexical confirmation was set before short tokens were kept, so it counts
  // the tokens it counted then; otherwise an acronym or a version in a query would skip lexical search.
  const lexicalTokens = getLexicalQueryTokens(query).filter((token) => characterCount(token) > 2);
  if (lexicalTokens.length > 0) {
    return lexicalTokens.length;
  }
  return query.trim().split(/\s+/).filter(Boolean).length;
}

function looksEntityLike(query: string): boolean {
  return /\b[A-Z][A-Za-z0-9_-]{2,}\b/.test(query) || /[#/][A-Za-z0-9_-]{2,}/.test(query);
}

/**
 * Boost for how strongly a query matches a record's TOPIC (identity field).
 * Scaled to dominate normalized BM25 scores (0-1 range): a query whose every
 * token hits the topic is topic-anchored and must outrank body-text matches
 * (delta-bench: before this, a topic string failed to surface its own rows in
 * top-5 for 42.5% of chains - present in the candidate pool, buried by rank).
 */
export function topicAffinityBoost(
  topic: string,
  tokens: string[],
  normalizedQuery: string
): number {
  if (tokens.length === 0) {
    return 0;
  }
  const topicText = topic.toLowerCase().replace(/_/g, ' ');
  // Word-boundary matching (exact word or stem-prefix), not raw substring:
  // "sent" must not match inside "consent" - a spurious all-tokens match would
  // vault an unrelated topic over the whole BM25 range.
  const topicWords = topicText.split(' ');
  let topicMatches = 0;
  for (const token of tokens) {
    const stem = stemToken(token);
    if (
      topicWords.some(
        (word) => word === token || (!SHORT_LATIN_TOKEN.test(token) && word.startsWith(stem))
      )
    ) {
      topicMatches += 1;
    }
  }
  const allTokensInTopic = topicMatches === tokens.length;
  const exact = topicText === normalizedQuery;
  return (exact ? 1 : 0) + (allTokensInTopic ? 2 : 0) + (topicMatches / tokens.length) * 0.5;
}

function buildLexicalCandidates(
  records: MemoryRecord[],
  query: string
): Array<{ memory: MemoryRecord; score: number }> {
  const tokens = getLexicalQueryTokens(query);
  const normalizedQuery = query.toLowerCase();

  return records
    .map((record) => {
      const haystack = [record.topic, record.summary, record.details].join(' ').toLowerCase();
      const tokenMatches = tokens.reduce((count, token) => {
        const stem = stemToken(token);
        if (!textHasToken(haystack, token) && !textHasToken(haystack, stem)) {
          return count;
        }
        if (token.length >= 8) {
          return count + 3;
        }
        if (token.length >= 5) {
          return count + 2;
        }
        return count + 1;
      }, 0);
      const phraseBoost = haystack.includes(normalizedQuery) ? 2 : 0;
      // Topic is the identity field: a hit there must outweigh a hit buried in
      // a long decision text. Scale the shared 0-1 affinity boost up to this
      // scorer's integer range so a full topic match dominates.
      const topicBoost = topicAffinityBoost(record.topic, tokens, normalizedQuery) * 5;
      const score = tokenMatches + phraseBoost + topicBoost;
      return { memory: record, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(compareLexicalCandidates);
}

function lexicalEventTime(record: MemoryRecord): number {
  if (typeof record.event_datetime === 'number' && Number.isFinite(record.event_datetime)) {
    return record.event_datetime;
  }
  const numericCreated = Number(record.created_at);
  if (Number.isFinite(numericCreated)) {
    return numericCreated;
  }
  const parsedCreated = Date.parse(String(record.created_at));
  return Number.isFinite(parsedCreated) ? parsedCreated : 0;
}

function compareLexicalCandidates(
  left: { memory: MemoryRecord; score: number },
  right: { memory: MemoryRecord; score: number }
): number {
  // Relevance wins; equally relevant history follows event time, not import or
  // commit order. FTS rowid order is not an event-time judgment.
  return (
    right.score - left.score ||
    lexicalEventTime(right.memory) - lexicalEventTime(left.memory) ||
    left.memory.id.localeCompare(right.memory.id)
  );
}

function lexicalScoreToConfidence(score: number): number {
  return Math.min(0.95, 0.45 + score * 0.05);
}

// Retained for potential future use in non-RRF recall paths
function _mergeRecallCandidates(
  primary: MemoryRecord[],
  lexical: Array<{ memory: MemoryRecord; score: number }>
): MemoryRecord[] {
  const merged = new Map<
    string,
    { memory: MemoryRecord; sortScore: number; lexicalScore: number }
  >();

  for (const memory of primary) {
    merged.set(memory.id, {
      memory,
      sortScore: memory.confidence ?? 0.5,
      lexicalScore: 0,
    });
  }

  // Determine the lowest vector confidence to cap lexical-only candidates below it
  const minVectorConfidence =
    primary.length > 0 ? Math.min(...primary.map((m) => m.confidence ?? 0.5)) : 1.0;
  const LEXICAL_ONLY_CAP = Math.max(0, minVectorConfidence - 0.01);

  for (const candidate of lexical) {
    const lexicalConfidence = lexicalScoreToConfidence(candidate.score);
    const existing = merged.get(candidate.memory.id);
    if (existing) {
      // Already has a vector hit — safe to boost with lexical score
      existing.sortScore = Math.max(existing.sortScore, lexicalConfidence);
      existing.lexicalScore = Math.max(existing.lexicalScore, candidate.score);
      existing.memory = {
        ...existing.memory,
        confidence: Math.max(existing.memory.confidence ?? 0.5, lexicalConfidence),
      };
      merged.set(candidate.memory.id, existing);
      continue;
    }

    // Lexical-only candidate — cap below the lowest vector hit
    const cappedConfidence = Math.min(lexicalConfidence, LEXICAL_ONLY_CAP);
    merged.set(candidate.memory.id, {
      memory: {
        ...candidate.memory,
        confidence: Math.max(candidate.memory.confidence ?? 0.5, cappedConfidence),
      },
      sortScore: cappedConfidence,
      lexicalScore: candidate.score,
    });
  }

  return Array.from(merged.values())
    .sort((left, right) => {
      if (right.sortScore !== left.sortScore) {
        return right.sortScore - left.sortScore;
      }
      if (right.lexicalScore !== left.lexicalScore) {
        return right.lexicalScore - left.lexicalScore;
      }
      return Number(right.memory.created_at) - Number(left.memory.created_at);
    })
    .map((candidate) => candidate.memory);
}

export async function loadEdgesForIds(
  adapter: DatabaseInstance,
  ids: string[]
): Promise<MemoryEdge[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `SELECT from_id, to_id, relationship AS type, reason
       FROM ${STATED_DECISION_EDGES} e
       WHERE (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
         AND (approved_by_user != 0 OR approved_by_user IS NULL)`
    )
    .all(...ids, ...ids) as Array<{
    from_id: string;
    to_id: string;
    type: string;
    reason: string | null;
  }>;
  return rows.map((row) => ({
    from_id: row.from_id,
    to_id: row.to_id,
    type: row.type as MemoryEdge['type'],
    reason: row.reason ?? undefined,
  }));
}

type SaveMemoryResult = {
  success: boolean;
  id: string;
  saved_decision_id?: string;
};

const GUIDANCE_MEMORY_KINDS = new Set<MemoryKind>([
  'lesson',
  'preference',
  'constraint',
  'workflow',
]);

function oneLineGuidanceText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function guidancePayloadFor(input: SaveMemoryInput): Record<string, JsonValue> | undefined {
  if (!GUIDANCE_MEMORY_KINDS.has(input.kind)) return undefined;
  const appliesWhen =
    typeof input.appliesWhen === 'string' ? oneLineGuidanceText(input.appliesWhen) : '';
  if (!appliesWhen) {
    throw new JudgmentError(
      'INVALID_INPUT',
      `memory.save kind '${input.kind}' requires an appliesWhen line`
    );
  }

  const guidance: Record<string, JsonValue> = { applies_when: appliesWhen };
  if (input.kind === 'workflow') {
    const steps = Array.isArray(input.steps) ? input.steps.map(oneLineGuidanceText) : [];
    if (steps.length === 0 || steps.some((step) => step.length === 0)) {
      throw new JudgmentError(
        'INVALID_INPUT',
        'memory.save kind workflow requires one or more ordered steps'
      );
    }
    guidance.steps = steps;
    if (input.evidenceChecks !== undefined) {
      if (!Array.isArray(input.evidenceChecks)) {
        throw new JudgmentError('INVALID_INPUT', 'memory.save evidenceChecks must be a list');
      }
      const checks = input.evidenceChecks.map(oneLineGuidanceText);
      if (checks.some((check) => check.length === 0)) {
        throw new JudgmentError(
          'INVALID_INPUT',
          'memory.save evidenceChecks cannot contain an empty line'
        );
      }
      guidance.evidence_checks = checks;
    }
  }
  return { guidance };
}

async function saveMemoryInternal(
  adapter: DatabaseInstance,
  input: SaveMemoryInput,
  provenance: NormalizedMemoryProvenance,
  access: JudgmentAccess,
  legacy?: LegacyMemoryPersistence,
  commandIdOverride?: string
): Promise<SaveMemoryResult> {
  const targetStatus = input.status ?? 'active';
  const requestedScopes = input.scopes ?? [];
  const payload = guidancePayloadFor(input);

  const eventDateTime = typeof input.eventDateTime === 'number' ? input.eventDateTime : null;

  // Fail before any write: identity references and relationship targets are
  // checked against the same admitted scopes the command will carry.
  validateRecordIdentityReferences(adapter, {
    itemId: input.itemId,
    actors: input.actors,
    scopes: input.scopes,
  });

  const commandId = commandIdOverride ?? `save:${buildDecisionId(input.topic)}`;
  const recordId = judgmentRecordId(commandId);

  // A relation is written only when the caller names its target and reason (`links`,
  // `replaces`); matching topic text or vector similarity is evidence for retrieval, not a link.
  const authoredLinks = input.links ?? [];
  const authoredReplacements = input.replaces ?? [];

  const embeddingDecision: DecisionInput = {
    id: recordId,
    topic: input.topic,
    decision: input.summary,
    reasoning: input.details,
    confidence: input.confidence ?? 0.5,
    event_date: input.eventDate ?? null,
    event_datetime: eventDateTime,
  };

  const command: JudgmentCommand = {
    commandId,
    topic: input.topic,
    summary: input.summary,
    reasoning: input.details,
    recordKind: 'judgment',
    confidence: input.confidence ?? 0.5,
    eventDate: input.eventDate ?? null,
    eventDatetime: eventDateTime,
    outcome: legacy?.outcome ?? null,
    failureReason: legacy?.failureReason ?? null,
    limitation: legacy?.limitation ?? null,
    sourceRefs: provenance.source_refs,
    provenance: provenance.provenance as Record<string, JsonValue>,
    ...(payload === undefined ? {} : { payload }),
    agentId: provenance.agent_id,
    modelRunId: provenance.model_run_id,
    envelopeHash: provenance.envelope_hash,
    gatewayCallId: provenance.gateway_call_id,
    scopes: [...requestedScopes],
    links: authoredLinks,
    replaces: authoredReplacements,
    record: {
      kind: input.kind,
      status: targetStatus,
      summary: input.summary,
      isStatic:
        legacy?.isStatic ?? (input.kind === 'preference' || input.kind === 'constraint' ? 1 : 0),
      userInvolvement: legacy?.userInvolvement ?? null,
      trustContext: JSON.stringify({ source: input.source }),
    },
    event: {
      actor: provenance.actor,
      ...(provenance.source_turn_id ? { sourceTurnId: provenance.source_turn_id } : {}),
      evidenceRefs: provenance.source_refs,
      reason: buildSaveEventReason(provenance.tool_name, provenance.gateway_call_id),
    },
    projections: {
      ...(input.itemId !== undefined || input.actors !== undefined
        ? {
            recordIdentity: { itemId: input.itemId ?? null, actors: input.actors ?? [] },
          }
        : {}),
    },
  };

  let receipt: JudgmentReceipt;
  try {
    receipt = await appendJudgment(command, access, {
      adapter,
      embedder: commandEmbedder(embeddingDecision),
    });
  } catch (error) {
    const rollbackError = (error instanceof Error ? error : new Error(String(error))) as Error & {
      memoryId?: string;
    };
    rollbackError.memoryId = recordId;
    throw rollbackError;
  }

  return {
    success: true,
    id: receipt.recordId,
    saved_decision_id: receipt.recordId,
  };
}

export async function saveMemory(
  adapter: DatabaseInstance,
  input: SaveMemoryInput
): Promise<SaveMemoryResult> {
  const clean = sanitizePublicSaveMemoryInput(input);
  const provenance = normalizeMemoryWriteProvenance();
  const access = writeAccessForProvenance(
    provenance,
    uniqueScopes([...(clean.scopes ?? []), ...namedTargetScopes(adapter, clean)])
  );
  return saveMemoryInternal(adapter, clean, provenance, access);
}

/**
 * The scopes of the records a direct save names in `links` and `replaces`. A direct caller has no
 * grant of its own, so naming a record admits its partition for that link, as `mama.link` does;
 * the new record is still bound only to its own scopes.
 */
function namedTargetScopes(adapter: DatabaseInstance, input: SaveMemoryInput): MemoryScopeRef[] {
  const ids = [
    ...(input.links ?? [])
      .filter((link) => link.target.kind === 'memory')
      .map((link) => link.target.id),
    ...(input.replaces ?? []).map((replacement) => replacement.id),
  ];
  return ids.flatMap((id) => boundScopesOf(adapter, id));
}

/** Access scopes must be unique; the save's own scope and a target's are often the same. */
function uniqueScopes(scopes: readonly MemoryScopeRef[]): MemoryScopeRef[] {
  return [...new Map(scopes.map((scope) => [`${scope.kind}\0${scope.id}`, scope])).values()];
}

/**
 * The unified `memory.save` action path. Access IS the call authority — the
 * command's scopes are checked against it inside `appendJudgment`, and the
 * record's provenance is composed from it plus the session facts the host
 * attests (never from caller input). `commandId` is the caller's operationId,
 * so a retried call replays the original receipt.
 */
export async function saveJudgmentRecord(
  adapter: DatabaseInstance,
  input: SaveMemoryInput,
  access: JudgmentAccess,
  commandId: string,
  session?: ActionSessionFacts
): Promise<SaveMemoryResult> {
  // An omitted scope request writes under the full admitted scopes — the same
  // default the gateway's trusted path applied via the context packet.
  const clean = sanitizePublicSaveMemoryInput({
    ...input,
    scopes: input.scopes ?? access.scopes,
  });
  const provenance = normalizeMemoryWriteProvenance({
    actor: session?.actor ?? 'main_agent',
    agent_id: access.agentId,
    model_run_id: session?.modelRunId,
    envelope_hash: session?.envelopeHash,
    tool_name: session?.toolName,
    gateway_call_id: session?.gatewayCallId,
    context_packet_id: session?.contextPacketId,
    source_turn_id: session?.sourceTurnId,
    source_message_ref: session?.sourceMessageRef,
    source_refs: session?.sourceRefs ? [...session.sourceRefs] : undefined,
  });
  return saveMemoryInternal(adapter, clean, provenance, access, undefined, commandId);
}

/**
 * The read-side scope rule for memory actions — the same bound `appendJudgment`
 * applies to writes. An omitted request reads under the full admitted scopes;
 * an explicit request must be a subset of them. An empty admitted set admits an
 * empty corpus: a caller with no scopes can see no scoped record (reads never
 * fall back to an unbounded scan — the legacy `scopes: []` = read-all behavior
 * is exactly what this bound removes).
 */
export function boundReadScopesFor(
  access: JudgmentAccess,
  requested?: MemoryScopeRef[]
): MemoryScopeRef[] {
  const readable = [...access.scopes, ...(access.readScopes ?? [])];
  const scopeKey = (scope: MemoryScopeRef): string => JSON.stringify([scope.kind, scope.id]);
  const admitted = new Map(readable.map((scope) => [scopeKey(scope), scope]));
  const effective = requested ?? [...admitted.values()];
  const seen = new Set<string>();
  return effective.map((scope) => {
    if (
      typeof scope !== 'object' ||
      scope === null ||
      typeof scope.kind !== 'string' ||
      scope.kind.trim().length === 0 ||
      typeof scope.id !== 'string' ||
      scope.id.trim().length === 0
    ) {
      throw new JudgmentError('INVALID_SCOPE', 'scope kind is invalid');
    }
    const key = scopeKey(scope);
    if (seen.has(key)) {
      throw new JudgmentError('INVALID_SCOPE', 'Read scopes must be unique');
    }
    seen.add(key);
    if (!admitted.has(key)) {
      throw new JudgmentError('SCOPE_DENIED', 'Read scope is outside the admitted access');
    }
    return scope;
  });
}

export async function saveLegacyMemory(
  adapter: DatabaseInstance,
  input: SaveMemoryInput,
  legacy: LegacyMemoryPersistence,
  access?: JudgmentAccess
): Promise<SaveMemoryResult> {
  const clean = sanitizePublicSaveMemoryInput(input);
  const provenance = normalizeMemoryWriteProvenance();
  const effectiveAccess =
    access ??
    writeAccessForProvenance(
      provenance,
      uniqueScopes([...(clean.scopes ?? []), ...namedTargetScopes(adapter, clean)])
    );
  return saveMemoryInternal(adapter, clean, provenance, effectiveAccess, legacy);
}

export type MemoryRetirementStatus = Extract<MemoryStatus, 'stale' | 'superseded'>;

/** Append an access-checked status amendment for one stored memory record. */
export async function retireMemoryRecord(
  adapter: DatabaseInstance,
  input: {
    memoryId: string;
    status: MemoryRetirementStatus;
    reason: string;
  },
  access: JudgmentAccess,
  commandId: string,
  session?: ActionSessionFacts
): Promise<{
  success: true;
  id: string;
  status: MemoryRetirementStatus;
  reason: string;
  receiptId: string;
}> {
  const id = input.memoryId.trim();
  const reason = input.reason.trim();
  if (!id) throw new JudgmentError('INVALID_INPUT', 'memory.retire requires memory_id');
  if (!reason) throw new JudgmentError('INVALID_INPUT', 'memory.retire requires a reason');
  if (input.status !== 'stale' && input.status !== 'superseded') {
    throw new JudgmentError('INVALID_INPUT', 'memory.retire status must be stale or superseded');
  }
  const record = await readMemoryRecordById(adapter, id, access.scopes);
  if (!record) {
    throw new JudgmentError(
      'REFERENCE_NOT_FOUND',
      'Memory record is unavailable in the admitted scopes'
    );
  }
  const admittedScopes = record.scopes.filter((recordScope) =>
    access.scopes.some((scope) => scope.kind === recordScope.kind && scope.id === recordScope.id)
  );
  const summary = `Status '${input.status}' applied to ${id}: ${reason}`;
  // Who retired it, stated by the host as for a save, so a retirement can be traced to its turn.
  const provenance = normalizeMemoryWriteProvenance({
    actor: session?.actor ?? 'main_agent',
    agent_id: access.agentId,
    model_run_id: session?.modelRunId,
    envelope_hash: session?.envelopeHash,
    tool_name: session?.toolName,
    gateway_call_id: session?.gatewayCallId,
    context_packet_id: session?.contextPacketId,
    source_turn_id: session?.sourceTurnId,
    source_message_ref: session?.sourceMessageRef,
    source_refs: session?.sourceRefs ? [...session.sourceRefs] : undefined,
  });
  const receipt = await appendJudgment(
    {
      commandId,
      topic: `judgment/${id}`,
      summary,
      recordKind: 'judgment',
      sourceRefs: provenance.source_refs,
      provenance: provenance.provenance as Record<string, JsonValue>,
      agentId: provenance.agent_id,
      modelRunId: provenance.model_run_id,
      envelopeHash: provenance.envelope_hash,
      gatewayCallId: provenance.gateway_call_id,
      payload: { amended: id, status: input.status, reason },
      scopes: admittedScopes,
      links: [{ relation: 'amends', target: { kind: 'memory', id } }],
      amends: [{ target: { kind: 'memory', id }, status: input.status }],
      record: { kind: 'fact', status: 'active', summary },
      event: { reason: `Retired ${id} as ${input.status}: ${reason}` },
    },
    access,
    { adapter, embedder: null }
  );
  return { success: true, id, status: input.status, reason, receiptId: receipt.recordId };
}

export async function buildProfile(
  adapter: DatabaseInstance,
  scopes: MemoryScopeRef[]
): Promise<ProfileSnapshot> {
  const records = await loadScopedMemories(adapter, scopes);
  return classifyProfileEntries(records);
}

const EXCLUDED_STATUSES: Set<string> = new Set(RECALL_EXCLUDED_STATUSES);

/** The ids among these that only amend another record (a retirement or an outcome change). */
function amendmentIds(adapter: DatabaseInstance, ids: readonly string[]): Set<string> {
  const rows = adapter
    .prepare(
      `SELECT id FROM decisions WHERE id IN (${ids.map(() => '?').join(',')})
         AND json_extract(payload_json, '$.amended') IS NOT NULL`
    )
    .all(...ids) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

export async function recallMemory(
  adapter: DatabaseInstance,
  query: string,
  options: RecallMemoryOptions = {}
): Promise<RecallBundle> {
  const bundle = createEmptyRecallBundle(query);
  const searchOptions = normalizeSearchQualityOptions(options);
  const matchesKind = (kind: string | undefined): boolean =>
    options.kind === undefined ||
    (Array.isArray(options.kind)
      ? options.kind.some((value) => value === kind)
      : kind === options.kind);
  const diagnostics: RecallSearchDiagnostics = {
    candidate_counts: {
      vector: 0,
      lexical: 0,
      graph_expanded: 0,
      vector_only: 0,
      rejected_by_strictness: 0,
    },
    threshold: searchOptions.threshold,
    strictness: searchOptions.strictness,
  };

  let matched: MemoryRecord[] = [];
  let fusedHits: FusedHit[] = [];
  let retrievalSource = 'none';
  const vectorSimilarityById = new Map<string, number>();
  const lexicalScoreById = new Map<string, number>();
  let _lexicalRecords: MemoryRecord[] | null = null;
  const loadLexical = async () => {
    if (_lexicalRecords === null) {
      _lexicalRecords = await loadScopedMemories(adapter, options.scopes ?? []);
    }
    return _lexicalRecords;
  };

  // Query analysis: detect aggregation patterns and extract sub-queries
  const lowerQuery = query.toLowerCase();
  const isAggregation = /\b(how many|how much|total|all|every|each|count|number of)\b/.test(
    lowerQuery
  );
  const hasMultipleEntities = /\b(and|or|vs|versus|compared|between)\b/.test(lowerQuery);
  const vectorLimit = isAggregation ? 50 : 20;
  const requestedLimit = Math.max(1, Math.floor(options.limit ?? 10));

  // Multi-query decomposition: extract sub-queries for complex questions
  const subQueries: string[] = [query];
  if (hasMultipleEntities) {
    // Split on "or"/"and" to create focused sub-queries
    const parts = query
      .split(/\b(?:or|vs|versus|and|,)\b/i)
      .map((p) => p.trim())
      .filter((p) => p.length > 10);
    if (parts.length > 1) {
      subQueries.push(...parts);
    }
  }

  // Hybrid search: vector + BM25/lexical in parallel, fused with RRF
  // One adapter for the whole retrieval: generateEmbedding yields, and a reset
  // between two adapter lookups would fuse candidates from two databases.
  const searchAdapter = adapter;

  // Channel 1: Vector search (semantic similarity) — run all sub-queries
  const vectorMatched: MemoryRecord[] = [];
  // The consumer's embedder answered null: the search goes by text, which is no failure.
  let textOnly = false;
  try {
    for (const sq of subQueries) {
      const queryEmbedding = options.embedder
        ? await options.embedder.embed(sq, 'query')
        : await generateEmbedding(sq, 'query');
      if (queryEmbedding === null) {
        textOnly = true;
        break;
      }
      const vectorResults = await vectorSearch(
        searchAdapter,
        queryEmbedding,
        vectorLimit,
        searchOptions.threshold,
        searchOptions.topicPrefix,
        // Keep superseded history out of the candidate top-K at search time; the
        // post-filter below stays the authority (and includeHistory restores it).
        options.includeHistory ? undefined : Array.from(EXCLUDED_STATUSES),
        options.kind
      );

      let filtered = vectorResults;
      let vectorScopeMap = new Map<string, MemoryScopeRef[]>();
      if (options.scopes && options.scopes.length > 0) {
        const vectorIds = vectorResults.map((r) => String(r.id));
        vectorScopeMap = batchLoadScopes(adapter, vectorIds);
        const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
        filtered = vectorResults.filter((r) => {
          const scopes = vectorScopeMap.get(String(r.id)) ?? [];
          // When scopes are requested, zero-binding results must NOT pass through
          if (scopes.length === 0) return false;
          return scopes.some((s) => requestedScopes.has(`${s.kind}:${s.id}`));
        });
      }

      for (const result of filtered as Array<
        (typeof vectorResults)[number] & { similarity?: number; status?: string }
      >) {
        const effectiveStatus = (result.status as string) || (result.outcome as string) || '';
        if (!options.includeHistory && effectiveStatus && EXCLUDED_STATUSES.has(effectiveStatus)) {
          continue;
        }
        vectorMatched.push({
          id: String(result.id),
          topic: String(result.topic || ''),
          kind: ((result as { kind?: string }).kind ?? 'decision') as MemoryKind,
          summary: String(result.decision || ''),
          details: String(result.reasoning || ''),
          confidence: (result as { similarity?: number }).similarity ?? 0.5,
          status: (effectiveStatus as MemoryStatus) || 'active',
          scopes: vectorScopeMap.get(String(result.id)) ?? [],
          source: { package: 'mama-core', source_type: 'vector_search' },
          created_at: result.created_at ?? Date.now(),
          updated_at: result.created_at ?? Date.now(),
          event_date: result.event_date ?? null,
          event_datetime: result.event_datetime ?? null,
          outcome: (result.outcome as string | null) ?? null,
        });
        diagnostics.candidate_counts.vector += 1;
        if (typeof result.similarity === 'number' && Number.isFinite(result.similarity)) {
          vectorSimilarityById.set(String(result.id), result.similarity);
        }
      }
    } // end sub-query loop
  } catch (vectorErr) {
    warn(
      `[recallMemory] Vector search failed: ${vectorErr instanceof Error ? vectorErr.message : String(vectorErr)}`
    );
  }

  // Deduplicate vector results from multiple sub-queries
  const seenIds = new Set<string>();
  const dedupedVector: MemoryRecord[] = [];
  for (const r of vectorMatched) {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id);
      dedupedVector.push(r);
    }
  }
  vectorMatched.length = 0;
  vectorMatched.push(...dedupedVector);

  // Channel 2: FTS5 BM25 search (preferred) with in-memory lexical fallback
  // Lazy lexical: skip expensive FTS5/lexical when vector already returned enough results,
  // unless this is an aggregation query that benefits from broader coverage.
  const VECTOR_SUFFICIENT_THRESHOLD = 5;
  const shouldForceLexicalConfirmation =
    searchOptions.strictness !== 'recall' ||
    searchOptions.minLexicalSupport ||
    queryTokenCount(query) <= 3 ||
    // The vector channel separates Korean and Japanese text poorly (on a copy of the owner ledger,
    // paraphrases of one question left the record they described far outside its top 20), so
    // lexical search runs for any query with CJK text. Before short CJK words were kept, such a
    // query fell under the three-token cutoff by accident.
    CJK_TEXT.test(query) ||
    looksEntityLike(query);
  const needsLexical =
    textOnly ||
    isAggregation ||
    vectorMatched.length < VECTOR_SUFFICIENT_THRESHOLD ||
    shouldForceLexicalConfirmation;
  let lexicalCandidates: Array<{ memory: MemoryRecord; score: number }> = [];
  const lexicalLimit = isAggregation ? 100 : 50;

  if (needsLexical) {
    // Try FTS5 first — proper BM25 ranking, much better than in-memory .includes()
    // FTS5 MATCH treats spaces as AND; convert to OR so partial matches still surface.
    // Use all non-stopword tokens for FTS5 (stopwords already removed by getLexicalQueryTokens).
    // Additional high-frequency words that cause too many FTS5 matches are filtered separately.
    const FTS5_NOISE_WORDS = new Set([
      'this',
      'that',
      'also',
      'just',
      'like',
      'some',
      'many',
      'much',
      'very',
      'more',
      'most',
      'such',
      'each',
      'every',
      'been',
      'being',
      'about',
      'would',
      'could',
      'should',
      'will',
      'year',
      'years',
      'time',
      'know',
      'think',
      'want',
      'need',
      'make',
      'made',
    ]);
    const ftsTokens = getLexicalQueryTokens(query)
      .map((t) => stemToken(t))
      .filter((t) => !FTS5_NOISE_WORDS.has(t));
    // Every token is quoted text: a date or a hyphen unquoted is an FTS5 column filter and raised
    // an error that used to be swallowed into the in-memory scan. With no token left, every word
    // of the query must match.
    const ftsQuery =
      ftsTokens.length > 0 ? ftsMatchTerms(ftsTokens, 'OR') : ftsMatchTerms(ftsWords(query), 'AND');
    const lexicalExclusions = options.includeHistory
      ? undefined
      : { statuses: [...EXCLUDED_STATUSES], amendments: true };
    // Korean, Japanese and Chinese words are looked up in the trigram index, where a word matches
    // with a particle attached or inside a sentence written without spaces; the query's other
    // tokens stay in the word index, and the records are scored word by word across both.
    const cjkWords = cjkQueryWords(query);
    // An absent FTS table is already an empty answer inside fts5Search; any other failure is real.
    const ftsResults =
      cjkWords.length > 0
        ? await wordSearch(
            searchAdapter,
            [
              ...cjkWords,
              // A token joining Latin text to Korean or Japanese ("name-word") keeps its Latin words.
              ...ftsTokens
                .flatMap((token) =>
                  CJK_TEXT.test(token)
                    ? ftsWords(token).filter(
                        (part) => !CJK_TEXT.test(part) && characterCount(part) >= 2
                      )
                    : [token]
                )
                .map((token): QueryWord => ({ index: 'decisions_fts', forms: [token] })),
            ],
            lexicalLimit,
            options.kind,
            lexicalExclusions
          )
        : ftsQuery === null
          ? []
          : await fts5Search(
              searchAdapter,
              ftsQuery,
              lexicalLimit,
              options.kind,
              lexicalExclusions
            );
    if (ftsResults.length > 0) {
      const adapter = searchAdapter;
      const fallbackSource: SaveMemoryInput['source'] = {
        package: 'mama-core',
        source_type: 'fts5',
      };

      const maxRank = Math.max(...ftsResults.map((r) => Math.abs(r.rank)));

      for (const ftsRow of ftsResults) {
        const row = adapter
          .prepare(
            `SELECT id, topic, decision, reasoning, confidence, created_at, updated_at,
                  trust_context, kind, status, summary, event_date, event_datetime, outcome
           FROM decisions WHERE id = ?`
          )
          .get(ftsRow.id) as Record<string, unknown> | undefined;
        if (!row) continue;

        const effectiveStatus = (row.status as string) || '';
        if (!options.includeHistory && effectiveStatus && EXCLUDED_STATUSES.has(effectiveStatus)) {
          continue;
        }

        const memoryIds = [String(row.id)];
        const scopeMap = batchLoadScopes(adapter, memoryIds);
        const record = toMemoryRecord(row, scopeMap.get(String(row.id)) ?? [], fallbackSource);

        // Topic prefix filtering (matches vectorSearch behavior)
        if (searchOptions.topicPrefix && !record.topic.startsWith(searchOptions.topicPrefix))
          continue;

        if (!matchesKind(record.kind)) continue;

        // Scope filtering
        if (options.scopes && options.scopes.length > 0) {
          const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
          const scopes = scopeMap.get(record.id) ?? [];
          if (scopes.length === 0) continue;
          if (!scopes.some((s) => requestedScopes.has(`${s.kind}:${s.id}`))) continue;
        }

        const bm25Score = bm25Relevance(ftsRow.rank, maxRank);
        lexicalCandidates.push({ memory: record, score: bm25Score });
      }
    }

    // Topic-affinity rescore for FTS5 candidates: the OR-joined FTS query
    // floods the pool with body-text matches and plain BM25 buries rows whose
    // TOPIC matches the query (observed: target row present at rank 26/50 in
    // the pool, cut by the limit-5 slice). RRF consumes this array's ORDER,
    // so rescoring must happen before fusion.
    if (lexicalCandidates.length > 0) {
      const boostTokens = getLexicalQueryTokens(query);
      const boostQuery = query.toLowerCase();
      for (const candidate of lexicalCandidates) {
        candidate.score += topicAffinityBoost(candidate.memory.topic, boostTokens, boostQuery);
      }
      lexicalCandidates.sort(compareLexicalCandidates);
    }

    // Fallback: in-memory lexical if FTS5 returned nothing
    if (lexicalCandidates.length === 0) {
      let lexicalRecords = await loadLexical();

      if (options.scopes && options.scopes.length > 0) {
        const lexicalIds = lexicalRecords.map((r) => r.id);
        const scopeMap = batchLoadScopes(adapter, lexicalIds);
        const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
        lexicalRecords = lexicalRecords.filter((r) => {
          const scopes = scopeMap.get(r.id) ?? [];
          if (scopes.length === 0) return false;
          return scopes.some((s) => requestedScopes.has(`${s.kind}:${s.id}`));
        });
      }

      // Topic prefix filtering for in-memory lexical (matches vectorSearch behavior)
      if (searchOptions.topicPrefix) {
        lexicalRecords = lexicalRecords.filter((r) =>
          r.topic.startsWith(searchOptions.topicPrefix!)
        );
      }

      if (options.kind !== undefined) {
        lexicalRecords = lexicalRecords.filter((r) => matchesKind(r.kind));
      }

      if (!options.includeHistory && lexicalRecords.length > 0) {
        const amendments = amendmentIds(
          adapter,
          lexicalRecords.map((r) => r.id)
        );
        lexicalRecords = lexicalRecords.filter((r) => !amendments.has(r.id));
      }

      lexicalCandidates = buildLexicalCandidates(lexicalRecords, query);
      if (subQueries.length > 1) {
        for (const sq of subQueries.slice(1)) {
          const subCandidates = buildLexicalCandidates(lexicalRecords, sq);
          for (const c of subCandidates) {
            if (!lexicalCandidates.some((existing) => existing.memory.id === c.memory.id)) {
              lexicalCandidates.push(c);
            }
          }
        }
        lexicalCandidates.sort(compareLexicalCandidates);
      }
    }
  } // end needsLexical

  diagnostics.candidate_counts.lexical = lexicalCandidates.length;
  for (const candidate of lexicalCandidates) {
    lexicalScoreById.set(candidate.memory.id, candidate.score);
  }

  // RRF Fusion: combine vector and lexical/FTS5 results by reciprocal rank
  // FTS5 BM25 gets 2x weight — it naturally demotes records where query terms
  // appear only in passing (e.g. "wedding" mentioned once in a dating record),
  // so weighting it higher filters topical noise better than equal weighting.
  // Additionally, vector-only results (no lexical support) are penalized to
  // reduce semantic-but-off-topic noise.
  // Lexical-first fusion: FTS5 BM25 provides the primary ranking (topic relevance),
  // vector similarity acts as a secondary boost (semantic depth).
  // This prevents off-topic records that are semantically similar from ranking high.
  const RRF_K = 60;
  const rrfScores = new Map<string, { record: MemoryRecord; score: number }>();

  // Vector rank map for boosting lexical results
  const vectorRankMap = new Map<string, number>();
  for (let i = 0; i < vectorMatched.length; i++) {
    vectorRankMap.set(vectorMatched[i].id, i);
  }

  // Primary: lexical/FTS5 results with vector boost
  for (let i = 0; i < lexicalCandidates.length; i++) {
    const r = lexicalCandidates[i];
    if (!options.includeHistory && EXCLUDED_STATUSES.has(r.memory.status)) continue;
    const lexScore = 1 / (RRF_K + i + 1);
    const vecRank = vectorRankMap.get(r.memory.id);
    const vecBoost = vecRank !== undefined ? 0.2 * (1 / (RRF_K + vecRank + 1)) : 0;
    rrfScores.set(r.memory.id, { record: r.memory, score: lexScore + vecBoost });
  }

  // Secondary: vector-only results (no lexical backing) get heavily discounted
  for (let i = 0; i < vectorMatched.length; i++) {
    const r = vectorMatched[i];
    if (rrfScores.has(r.id)) continue; // Already included via lexical
    const rrfScore = 0.15 * (1 / (RRF_K + i + 1));
    rrfScores.set(r.id, { record: r, score: rrfScore });
  }

  const sortedRrf = Array.from(rrfScores.values()).sort((a, b) => b.score - a.score);
  const decisionFusedHits: FusedHit[] = sortedRrf.map((entry) => ({
    source_type: 'decision',
    source_id: entry.record.id,
    record: entry.record,
    fused_rank_score: entry.score,
  }));

  fusedHits = decisionFusedHits;

  // Normalize RRF scores to 0-1 range so downstream consumers (threshold filters,
  // similarity displays) get meaningful values.  The raw RRF score for K=60 tops out
  // around 0.033, which is misleading when compared against similarity thresholds.
  const maxRrf = sortedRrf.length > 0 ? sortedRrf[0].score : 1;
  matched = sortedRrf.map((entry) => ({
    ...entry.record,
    confidence: maxRrf > 0 ? entry.score / maxRrf : 0,
  }));

  if (vectorMatched.length > 0 && lexicalCandidates.length > 0) {
    retrievalSource = 'hybrid_rrf';
  } else if (vectorMatched.length > 0) {
    retrievalSource = 'vector_search';
  } else if (lexicalCandidates.length > 0) {
    retrievalSource = 'lexical_search';
  }

  const requestedScopeKeys = new Set(
    (options.scopes ?? []).map((scope) => `${scope.kind}:${scope.id}`)
  );
  const hasRequestedScopeSupport = (record: MemoryRecord): boolean => {
    if (requestedScopeKeys.size === 0) {
      return true;
    }
    return record.scopes.some((scope) => requestedScopeKeys.has(`${scope.kind}:${scope.id}`));
  };
  // exact_topic confirmation is intentionally narrow: short substring matches
  // would let two-letter queries like "ai" trip on words like "email" and
  // promote vector-only hits past strict/balanced rejection. Require either
  // exact equality or whole-token containment, and ignore tiny queries.
  const EXACT_TOPIC_MIN_QUERY_LENGTH = 3;
  const tokenizeForExactTopic = (input: string): string[] =>
    input.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  const hasExactTopicSupport = (record: MemoryRecord): boolean => {
    const normalizedQuery = query.trim().toLowerCase();
    const normalizedTopic = record.topic.trim().toLowerCase();
    if (!normalizedQuery || !normalizedTopic) {
      return false;
    }
    if (normalizedQuery.length < EXACT_TOPIC_MIN_QUERY_LENGTH) {
      return false;
    }
    if (normalizedQuery === normalizedTopic) {
      return true;
    }
    const queryTokens = tokenizeForExactTopic(normalizedQuery);
    const topicTokens = tokenizeForExactTopic(normalizedTopic);
    // Whole-token match: a topic word equals the entire query, OR the topic
    // (when itself a single token) appears as a complete word in the query.
    return topicTokens.includes(normalizedQuery) || queryTokens.includes(normalizedTopic);
  };
  // Combined check used for the wiki *filter* path: a wiki entry must have at
  // least one linked decision that matches BOTH the requested scope AND the
  // requested topicPrefix. Without this, the page passes when scope matches
  // decision A and topic matches decision B — i.e., neither single decision
  // satisfies the caller's filter. Diagnostics reporting (which only signals
  // scope confirmation) keeps using hasRequestedWikiScopeSupport.
  const buildDiagnostics = (
    record: MemoryRecord,
    graphSource: SearchHitDiagnostics['graph_source']
  ): SearchHitDiagnostics => {
    const vectorSimilarity = vectorSimilarityById.get(record.id) ?? null;
    const lexicalSupport = lexicalScoreById.has(record.id);
    const exactTopicSupport = hasExactTopicSupport(record);
    const scopeSupport = hasRequestedScopeSupport(record);
    const confirmationSignals = [
      lexicalSupport ? 'lexical' : null,
      exactTopicSupport ? 'exact_topic' : null,
    ].filter((signal): signal is string => signal !== null);
    const metadataSignals = [
      requestedScopeKeys.size > 0 && scopeSupport ? 'scope' : null,
      graphSource === 'primary' ? 'graph_primary' : null,
      graphSource === 'expanded' ? 'graph_expanded' : null,
    ].filter((signal): signal is string => signal !== null);
    const retrievalSourceForRecord =
      vectorSimilarity !== null && lexicalSupport
        ? 'hybrid_rrf'
        : vectorSimilarity !== null
          ? 'vector_search'
          : lexicalSupport
            ? 'lexical_search'
            : String(record.source.source_type || 'unknown');

    return {
      retrieval_source: retrievalSourceForRecord,
      vector_similarity: vectorSimilarity,
      lexical_support: lexicalSupport,
      scope_support: scopeSupport,
      graph_source: graphSource,
      is_vector_only: vectorSimilarity !== null && confirmationSignals.length === 0,
      confirmation_signals: confirmationSignals,
      metadata_signals: metadataSignals,
      candidate_threshold_used: searchOptions.threshold,
    };
  };
  const passesStrictness = (hitDiagnostics: SearchHitDiagnostics): boolean => {
    if (searchOptions.strictness === 'recall') {
      return true;
    }
    if (hitDiagnostics.confirmation_signals.length === 0) {
      return false;
    }
    if (!searchOptions.minLexicalSupport) {
      return true;
    }
    return (
      hitDiagnostics.lexical_support || hitDiagnostics.confirmation_signals.includes('exact_topic')
    );
  };

  const acceptedPrimaryIds = new Set<string>();
  matched = matched.flatMap((record) => {
    const recordDiagnostics = buildDiagnostics(record, 'primary');
    if (recordDiagnostics.is_vector_only) {
      diagnostics.candidate_counts.vector_only += 1;
    }
    if (!passesStrictness(recordDiagnostics)) {
      diagnostics.candidate_counts.rejected_by_strictness += 1;
      return [];
    }
    acceptedPrimaryIds.add(record.id);
    return [
      searchOptions.diagnostics ? { ...record, retrieval_diagnostics: recordDiagnostics } : record,
    ];
  });
  fusedHits = fusedHits.filter(
    (hit) => hit.source_type !== 'decision' || acceptedPrimaryIds.has(hit.source_id)
  );
  // A retirement or an outcome change audits another record; it is not a belief. Default recall
  // leaves it out and history shows it. Only the host writers put `amended` in a payload.
  if (!options.includeHistory && matched.length > 0) {
    const amendments = amendmentIds(
      adapter,
      matched.map((record) => record.id)
    );
    if (amendments.size > 0) {
      matched = matched.filter((record) => !amendments.has(record.id));
      fusedHits = fusedHits.filter(
        (hit) => hit.source_type !== 'decision' || !amendments.has(hit.source_id)
      );
    }
  }
  // Honor options.limit on the final memories (matched is RRF-rank-sorted, canonical
  // dual-write appends last). Without this cap the full fusion set (hundreds of records)
  // flowed into bundle.memories AND the per-record enrichment SQL loops below.
  if (matched.length > requestedLimit) {
    matched = matched.slice(0, requestedLimit);
    // Keep bundle.fused_hits consistent with the capped memories: drop decision hits
    // whose record no longer appears in `matched` (wiki hits are added below and are
    // not keyed to memories).
    const cappedIds = new Set(matched.map((record) => record.id));
    fusedHits = fusedHits.filter(
      (hit) => hit.source_type !== 'decision' || cappedIds.has(hit.source_id)
    );
  }

  // Superseded records are excluded from search, so an active record carries what it replaced:
  // the reader sees the correction and what it corrected. A predecessor is shown only inside the
  // reader's scopes, and marked as replaced.
  if (matched.length > 0) {
    const stmtChain = adapter.prepare(
      `SELECT id, summary, decision FROM decisions WHERE superseded_by = ?`
    );
    const readerScopes =
      options.scopes && options.scopes.length > 0
        ? new Set(options.scopes.map((scope) => `${scope.kind}:${scope.id}`))
        : null;
    for (const record of matched) {
      let predecessors = stmtChain.all(record.id) as Array<{
        id: string;
        summary?: string;
        decision?: string;
      }>;
      if (readerScopes && predecessors.length > 0) {
        const scopeMap = batchLoadScopes(
          adapter,
          predecessors.map((predecessor) => predecessor.id)
        );
        predecessors = predecessors.filter((predecessor) =>
          (scopeMap.get(predecessor.id) ?? []).some((scope) =>
            readerScopes.has(`${scope.kind}:${scope.id}`)
          )
        );
      }
      if (predecessors.length > 0) {
        const extra = predecessors
          .map((p) => String(p.summary ?? p.decision ?? ''))
          .filter(Boolean)
          .join(' | ');
        if (extra) {
          record.details = record.details
            ? `${record.details}\n[Replaced by this record] ${extra}`
            : `[Replaced by this record] ${extra}`;
        }
      }
    }
  }

  bundle.memories = matched;
  bundle.graph_context.primary = matched;
  bundle.graph_context.expanded = [];
  bundle.graph_context.edges = [];

  if (matched.length > 0 && !options.skipGraphExpansion && searchOptions.includeRelated) {
    const candidates = matched.map((m) => ({
      id: m.id,
      topic: m.topic,
      decision: m.summary,
      confidence: m.confidence,
      created_at: m.created_at,
      similarity: m.confidence ?? 0.5,
    }));
    const expanded = await expandWithGraphInAdapter(adapter, candidates);
    const primaryIds = new Set(matched.map((m) => m.id));
    let expandedOnly = expanded.filter((e) => !primaryIds.has(e.id));
    let expandedScopeMap = new Map<string, MemoryScopeRef[]>();

    // Re-filter expanded results: apply status and scope checks
    if (!options.includeHistory) {
      expandedOnly = expandedOnly.filter((e) => {
        const row = adapter.prepare(`SELECT kind, status FROM decisions WHERE id = ?`).get(e.id) as
          | { kind?: string; status?: string }
          | undefined;
        const status = row?.status || '';
        return matchesKind(row?.kind) && (!status || !EXCLUDED_STATUSES.has(status));
      });
      // A link an agent stated can point at a retirement or an outcome change; it stays out too.
      if (expandedOnly.length > 0) {
        const amendments = amendmentIds(
          adapter,
          expandedOnly.map((e) => e.id)
        );
        expandedOnly = expandedOnly.filter((e) => !amendments.has(e.id));
      }
    } else if (options.kind !== undefined) {
      expandedOnly = expandedOnly.filter((e) => {
        const row = adapter.prepare(`SELECT kind FROM decisions WHERE id = ?`).get(e.id) as
          | { kind?: string }
          | undefined;
        return matchesKind(row?.kind);
      });
    }
    if (options.scopes && options.scopes.length > 0) {
      const expandedIds = expandedOnly.map((e) => e.id);
      expandedScopeMap = batchLoadScopes(adapter, expandedIds);
      const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
      expandedOnly = expandedOnly.filter((e) => {
        const scopes = expandedScopeMap.get(e.id) ?? [];
        if (scopes.length === 0) return false;
        return scopes.some((s) => requestedScopes.has(`${s.kind}:${s.id}`));
      });
      // A correction is stated by a record; its reason shows under the rule the records follow.
      const correctionScopes = batchLoadScopes(
        adapter,
        expandedOnly.flatMap((e) => correctionAuthors(e.edge_corrected_by ?? []))
      );
      const readable = (correction: DecisionCorrection): boolean =>
        (correctionScopes.get(correction.from) ?? []).some((scope) =>
          requestedScopes.has(`${scope.kind}:${scope.id}`)
        );
      expandedOnly = expandedOnly.map((e) =>
        e.edge_corrected_by
          ? { ...e, edge_corrected_by: readableCorrections(e.edge_corrected_by, readable) }
          : e
      );
    }

    bundle.graph_context.expanded = expandedOnly.flatMap((e) => {
      const kindRow = adapter.prepare(`SELECT kind FROM decisions WHERE id = ?`).get(e.id) as
        | { kind?: string }
        | undefined;
      const expandedRecord: MemoryRecord = {
        id: String(e.id),
        topic: String(e.topic || ''),
        kind: (kindRow?.kind ?? 'decision') as MemoryKind,
        summary: String(e.decision || ''),
        details: '',
        confidence: (e.graph_rank as number) ?? 0.5,
        status: 'active' as const,
        scopes: expandedScopeMap.get(e.id) ?? [],
        source: {
          package: 'mama-core' as const,
          source_type: String(e.graph_source || 'graph_expansion'),
        },
        created_at: (e.created_at as number) ?? Date.now(),
        updated_at: (e.created_at as number) ?? Date.now(),
        ...(e.related_to
          ? {
              reached_through: {
                from: e.related_to,
                relation: String(e.graph_source),
                reason: e.edge_reason ?? null,
                ...(e.edge_corrected_by ? { corrected_by: e.edge_corrected_by } : {}),
              },
            }
          : {}),
      };
      const expandedDiagnostics = buildDiagnostics(expandedRecord, 'expanded');
      if (!passesStrictness(expandedDiagnostics)) {
        diagnostics.candidate_counts.rejected_by_strictness += 1;
        return [];
      }
      return [
        searchOptions.diagnostics
          ? {
              ...expandedRecord,
              retrieval_diagnostics: expandedDiagnostics,
            }
          : expandedRecord,
      ];
    });
    diagnostics.candidate_counts.graph_expanded = bundle.graph_context.expanded.length;
    // Graph-expanded hits are supporting context for the primary matches -
    // they must never OUTRANK them. The previous score ((graph_rank)*0.1,
    // typically 0.05-0.095) sat far above the entire RRF range (<=~0.018),
    // so expansion hits displaced every primary hit from the fused top-N
    // (delta-bench root cause: top-5 filled with related-but-wrong topics
    // while the queried topic's own rows were cut). Scale them into a band
    // strictly below the weakest primary hit, ordered by graph rank.
    const minPrimaryScore =
      fusedHits.length > 0 ? Math.min(...fusedHits.map((hit) => hit.fused_rank_score)) : 0.002;
    fusedHits = [
      ...fusedHits,
      ...bundle.graph_context.expanded.map((record) => ({
        source_type: 'decision' as const,
        source_id: record.id,
        record,
        fused_rank_score:
          minPrimaryScore * 0.9 * Math.min(1, Math.max(0.1, record.confidence ?? 0.5)),
        retrieval_diagnostics: record.retrieval_diagnostics,
      })),
    ].sort((left, right) => right.fused_rank_score - left.fused_rank_score);

    // bundle.graph_context.expanded is the strictness-filtered set of
    // expanded nodes that will actually be returned. Use those IDs (not
    // expandedOnly, which still contains rejected candidates) so edges
    // never point at nodes that never made it into the graph payload.
    const acceptedExpandedIds = bundle.graph_context.expanded.map((record) => record.id);
    const allIds = [...matched.map((m) => m.id), ...acceptedExpandedIds];
    const allEdges = await loadEdgesForIds(adapter, allIds);

    // Filter out edges pointing to decisions with excluded statuses
    const activeIds = new Set(allIds);
    const edgesToCheck = allEdges.filter(
      (e) => !activeIds.has(e.to_id) || !activeIds.has(e.from_id)
    );
    if (edgesToCheck.length > 0) {
      const checkIds = [
        ...new Set(
          edgesToCheck.flatMap((e) => [e.from_id, e.to_id]).filter((id) => !activeIds.has(id))
        ),
      ];
      const placeholders = checkIds.map(() => '?').join(', ');
      const statusRows = adapter
        .prepare(`SELECT id, status FROM decisions WHERE id IN (${placeholders})`)
        .all(...checkIds) as Array<{ id: string; status: string | null }>;
      const excludedIds = new Set(
        statusRows.filter((r) => r.status && EXCLUDED_STATUSES.has(r.status)).map((r) => r.id)
      );
      bundle.graph_context.edges = allEdges.filter(
        (e) => !excludedIds.has(e.from_id) && !excludedIds.has(e.to_id)
      );
    } else {
      bundle.graph_context.edges = allEdges;
    }
  }

  (bundle as RecallBundle & { fused_hits?: FusedHit[] }).fused_hits = fusedHits;
  bundle.search_meta.scope_order = (options.scopes ?? []).map((scope) => scope.kind);
  bundle.search_meta.retrieval_sources = [retrievalSource];
  if (searchOptions.diagnostics) {
    bundle.search_meta.diagnostics = diagnostics;
  }

  if (options.includeProfile) {
    bundle.profile = await buildProfile(adapter, options.scopes ?? []);
  }

  return bundle;
}

async function ingestMemoryInternal(
  adapter: DatabaseInstance,
  input: IngestMemoryInput
): Promise<{ success: boolean; id: string }> {
  // Raw evidence goes through source.ingest: exactly one immutable observation
  // per request, no judgment row, no extraction.
  const normalized = input.content;
  const provenance = normalizeMemoryWriteProvenance();
  const requestedScopes = input.scopes ?? [];
  const access = writeAccessForProvenance(provenance, requestedScopes);
  const commandId = `source:${crypto
    .createHash('sha256')
    .update(
      canonicalizeJSON({
        content: normalized,
        scopes: requestedScopes,
        source: input.source,
        eventDate: input.eventDate ?? null,
        eventDateTime: input.eventDateTime ?? null,
        provenance: provenance.provenance,
      })
    )
    .digest('hex')
    .slice(0, 24)}`;
  const receipt = await ingestSource(
    {
      commandId,
      source: {
        connector: input.source.source_type ?? 'ingest',
        id: commandId,
      },
      body: normalized,
      sourceAt:
        typeof input.eventDateTime === 'number'
          ? input.eventDateTime
          : input.eventDate
            ? Date.parse(input.eventDate)
            : null,
      metadata: {
        source: input.source as unknown as JsonValue,
        eventDate: input.eventDate ?? null,
        eventDateTime: input.eventDateTime ?? null,
      },
      scopes: [...requestedScopes],
      event: {
        actor: provenance.actor,
        ...(provenance.source_turn_id ? { sourceTurnId: provenance.source_turn_id } : {}),
        ...(provenance.source_refs.length > 0 ? { evidenceRefs: provenance.source_refs } : {}),
        reason: 'ingest memory',
      },
    },
    access,
    { adapter }
  );
  return { success: true, id: receipt.observationId };
}

export async function ingestMemory(
  adapter: DatabaseInstance,
  input: IngestMemoryInput
): Promise<{ success: boolean; id: string }> {
  return ingestMemoryInternal(adapter, sanitizePublicIngestMemoryInput(input));
}

async function ingestConversationInternal(
  adapter: DatabaseInstance,
  input: IngestConversationInput
): Promise<IngestConversationResult> {
  if (!input.messages || input.messages.length === 0) {
    throw new Error('messages array must not be empty');
  }
  // Extraction was removed from the write boundary: conversations are stored as
  // raw evidence only. The option is rejected before any write so a caller can
  // never mistake a raw observation for an extracted judgment.
  if (input.extract !== undefined) {
    throw new Error(
      'ingestConversation() no longer supports the extract option; ' +
        'conversations are stored as raw source observations without judgment writes'
    );
  }

  const conversationText = input.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  const topicPrefix = input.topicPrefix || '';
  const body = topicPrefix ? `${topicPrefix}${conversationText}` : conversationText;

  const provenance = normalizeMemoryWriteProvenance();
  const requestedScopes = input.scopes ?? [];
  const access = writeAccessForProvenance(provenance, requestedScopes);
  // No observedAt in the command: it must hash identically on a retry so the
  // same commandId replays its stored receipt instead of conflicting.
  const commandId = `source-conv:${crypto
    .createHash('sha256')
    .update(
      canonicalizeJSON({
        body,
        scopes: requestedScopes,
        source: input.source,
        sessionDate: input.sessionDate ?? null,
        provenance: provenance.provenance,
      })
    )
    .digest('hex')
    .slice(0, 24)}`;
  const receipt = await ingestSource(
    {
      commandId,
      source: {
        connector: `conversation:${input.source.source_type ?? 'unknown'}`,
        id: commandId,
      },
      body,
      sourceAt: input.sessionDate ? Date.parse(input.sessionDate) : null,
      metadata: {
        message_count: input.messages.length,
        roles: input.messages.map((m) => m.role),
        session_date: input.sessionDate ?? null,
        topic_prefix: topicPrefix || null,
        source: input.source as unknown as JsonValue,
      },
      scopes: [...requestedScopes],
      event: {
        actor: provenance.actor,
        ...(provenance.source_turn_id ? { sourceTurnId: provenance.source_turn_id } : {}),
        ...(provenance.source_refs.length > 0 ? { evidenceRefs: provenance.source_refs } : {}),
        reason: 'ingest conversation',
      },
    },
    access,
    { adapter }
  );

  return { rawId: receipt.observationId, extractedMemories: [] };
}

export async function ingestConversation(
  adapter: DatabaseInstance,
  input: IngestConversationInput
): Promise<IngestConversationResult> {
  return ingestConversationInternal(adapter, sanitizePublicIngestConversationInput(input));
}

// ── Adapter-bound reads and writes the catalog actions call ─────────────────
//
// These were `mama-api.ts`'s, beside an ambient-handle facade for callers who
// did not hold a database. The catalog holds one and calls these directly, so
// they live with the rest of the memory API. What stays in `mama-api.ts` is the
// facade and the formatting the CLI still uses (W22).

function numberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function resultRecord(result: SearchRollupResult): Record<string, unknown> {
  if (
    typeof result.record === 'object' &&
    result.record !== null &&
    !Array.isArray(result.record)
  ) {
    return result.record as Record<string, unknown>;
  }
  return {};
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function confidenceValue(record: Record<string, unknown>, fallback: number): number {
  const numeric = numberOrNull(record.confidence);
  if (numeric !== null) {
    return numeric;
  }

  switch (record.confidence) {
    case 'high':
      return 0.9;
    case 'medium':
      return 0.6;
    case 'low':
      return 0.3;
    default:
      return fallback;
  }
}

/**
 * Expand search results with graph context (Phase 1 - Graph-Enhanced Retrieval)
 *
 * For each candidate decision:
 * 1. Add supersedes chain (evolution history)
 * 2. Add semantic edges (refines, contradicts)
 * 3. Deduplicate by ID
 * 4. Re-rank by relevance (primary candidates ranked higher)
 *
 * @param {Array} candidates - Initial search results from vector/keyword search
 * @returns {Promise<Array>} Graph-enhanced results with evolution context
 */
export interface SearchCandidate {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string | null;
  confidence?: number;
  similarity?: number;
  created_at?: number | string;
  graph_source?: string;
  graph_rank?: number;
  related_to?: string | null;
  edge_reason?: string | null;
  /** Later links that contradict the link this record was reached through. */
  edge_corrected_by?: DecisionCorrection[];
  recency_score?: number;
  recency_age_days?: number;
  final_score?: number;
  outcome?: string | null;
  failure_reason?: string | null;
  is_static?: number;
}

export async function expandWithGraphInAdapter(
  adapter: DatabaseAdapter,
  candidates: SearchCandidate[]
): Promise<SearchCandidate[]> {
  const graphEnhanced = new Map<string, SearchCandidate>(); // Use Map for deduplication by ID
  const primaryIds = new Set(candidates.map((c: SearchCandidate) => c.id)); // Track primary candidates
  const reachedThrough = new Map<string, string>(); // expanded record id -> the link's edge id

  // Process each candidate
  for (const candidate of candidates) {
    // Add primary candidate with higher rank
    if (!graphEnhanced.has(candidate.id)) {
      graphEnhanced.set(candidate.id, {
        ...candidate,
        graph_source: 'primary', // Mark as primary result
        graph_rank: 1.0, // Highest rank
      });
    }

    // 1. The records this one replaced, down its supersedes chain
    const chain = await queryDecisionGraph(adapter, candidate.topic, candidate.id);
    for (const decision of chain) {
      if (!graphEnhanced.has(decision.id)) {
        graphEnhanced.set(decision.id, {
          ...decision,
          graph_source: 'supersedes_chain',
          graph_rank: 0.8, // Lower rank than primary
          similarity: (candidate.similarity ?? 0) * 0.9, // Inherit similarity, slightly reduced
          related_to: candidate.id, // Track relationship
        });
      }
    }

    // 2. The links an agent stated (refines, contradicts, builds_on, debates, synthesizes)
    const rawEdges = (await querySemanticEdges(adapter, [candidate.id])) || {};
    const edges = {
      refines: rawEdges.refines || [],
      refined_by: rawEdges.refined_by || [],
      contradicts: rawEdges.contradicts || [],
      contradicted_by: rawEdges.contradicted_by || [],
      builds_on: rawEdges.builds_on || [],
      built_on_by: rawEdges.built_on_by || [],
      debates: rawEdges.debates || [],
      debated_by: rawEdges.debated_by || [],
      synthesizes: rawEdges.synthesizes || [],
      synthesized_by: rawEdges.synthesized_by || [],
    };

    // Helper to add edge to graph
    const addEdge = (
      edge: SemanticEdgeItem,
      idField: 'to_id' | 'from_id',
      source: string,
      rank: number,
      simFactor: number
    ): void => {
      const id = edge[idField];
      if (!graphEnhanced.has(id)) {
        graphEnhanced.set(id, {
          id: id,
          topic: edge.topic,
          decision: edge.decision,
          confidence: edge.confidence,
          created_at: edge.created_at,
          graph_source: source,
          graph_rank: rank,
          similarity: (candidate.similarity ?? 0) * simFactor,
          related_to: candidate.id,
          edge_reason: edge.reason,
        });
        if (edge.edge_id) reachedThrough.set(id, edge.edge_id);
      }
    };

    // Add refines edges
    for (const edge of edges.refines) {
      addEdge(edge, 'to_id', 'refines', 0.7, 0.85);
    }

    // Add refined_by edges
    for (const edge of edges.refined_by) {
      addEdge(edge, 'from_id', 'refined_by', 0.7, 0.85);
    }

    // Add contradicts edges (lower rank, but still relevant)
    for (const edge of edges.contradicts) {
      addEdge(edge, 'to_id', 'contradicts', 0.6, 0.8);
    }

    // Story 2.1: Add builds_on edges (high relevance - extending prior work)
    for (const edge of edges.builds_on) {
      addEdge(edge, 'to_id', 'builds_on', 0.75, 0.9);
    }

    // Add built_on_by edges (someone built on this decision)
    for (const edge of edges.built_on_by) {
      addEdge(edge, 'from_id', 'built_on_by', 0.75, 0.9);
    }

    // Add debates edges (alternative view)
    for (const edge of edges.debates) {
      addEdge(edge, 'to_id', 'debates', 0.65, 0.85);
    }

    // Add debated_by edges
    for (const edge of edges.debated_by) {
      addEdge(edge, 'from_id', 'debated_by', 0.65, 0.85);
    }

    // Add synthesizes edges (unified approach)
    for (const edge of edges.synthesizes) {
      addEdge(edge, 'to_id', 'synthesizes', 0.7, 0.88);
    }

    // Add synthesized_by edges
    for (const edge of edges.synthesized_by) {
      addEdge(edge, 'from_id', 'synthesized_by', 0.7, 0.88);
    }
  }

  // A link the agent later contradicted still leads here; the correction goes with the record.
  const corrections = correctionsOf(adapter, [...reachedThrough.values()]);
  for (const [id, edgeId] of reachedThrough) {
    const correctedBy = corrections.get(edgeId);
    if (correctedBy)
      graphEnhanced.set(id, { ...graphEnhanced.get(id)!, edge_corrected_by: correctedBy });
  }

  // 3. Convert Map to Array
  const allResults = Array.from(graphEnhanced.values());

  // 4. Sort: Interleave expanded results after their related primary
  // This ensures edge-connected decisions appear near their source
  const primaryResults = allResults
    .filter((r) => primaryIds.has(r.id))
    .sort((a, b) => {
      const scoreA = a.final_score || a.similarity || 0;
      const scoreB = b.final_score || b.similarity || 0;
      return scoreB - scoreA;
    });

  const expandedResults = allResults.filter((r) => !primaryIds.has(r.id));

  // Build final results: each primary followed by its related expanded results
  const results = [];
  for (const primary of primaryResults) {
    results.push(primary);

    // Find expanded results related to this primary
    const relatedExpanded = expandedResults.filter((e) => e.related_to === primary.id);

    // Sort related by graph_rank (higher first)
    relatedExpanded.sort((a, b) => (b.graph_rank || 0) - (a.graph_rank || 0));

    // Add related expanded results right after their primary
    results.push(...relatedExpanded);
  }

  // Add any orphaned expanded results (shouldn't happen, but safety net)
  const includedIds = new Set(results.map((r) => r.id));
  const orphaned = expandedResults.filter((e) => !includedIds.has(e.id));
  results.push(...orphaned);

  return results;
}

/**
 * Apply Gaussian Decay recency boosting (Elasticsearch-style)
 * Allows Claude to dynamically adjust search strategy based on results
 *
 * @param {Array} results - Search results with similarity scores
 * @param {Object} options - Recency boosting options
 * @returns {Array} Results with recency-boosted final scores
 */
interface RecencyBoostOptions {
  recencyWeight?: number;
  recencyScale?: number;
  recencyDecay?: number;
  disableRecency?: boolean;
}

function applyRecencyBoost(
  results: SearchCandidate[],
  options: RecencyBoostOptions = {}
): SearchCandidate[] {
  const {
    recencyWeight = 0.3,
    recencyScale = 7,
    recencyDecay = 0.5,
    disableRecency = false,
  } = options;

  if (disableRecency || recencyWeight === 0) {
    return results;
  }

  const now = Date.now(); // Current timestamp in milliseconds

  return results
    .map((r: SearchCandidate) => {
      // created_at is stored in milliseconds in the database
      const createdAt =
        typeof r.created_at === 'number' ? r.created_at : Date.parse(r.created_at || '0');
      const ageInDays = (now - createdAt) / (86400 * 1000);

      // Gaussian Decay: exp(-((age / scale)^2) / (2 * ln(1 / decay)))
      // At scale days: score = decay (e.g., 7 days = 50%)
      const gaussianDecay = Math.exp(
        -Math.pow(ageInDays / recencyScale, 2) / (2 * Math.log(1 / recencyDecay))
      );

      // Combine semantic similarity with recency
      const similarity = r.similarity ?? 0;
      const finalScore = similarity * (1 - recencyWeight) + gaussianDecay * recencyWeight;

      return {
        ...r,
        recency_score: gaussianDecay,
        recency_age_days: Math.round(ageInDays * 10) / 10,
        final_score: finalScore,
      };
    })
    .sort((a: SearchCandidate, b: SearchCandidate) => (b.final_score ?? 0) - (a.final_score ?? 0));
}

/**
 * Suggest relevant decisions based on user question
 *
 * DEFAULT: Returns JSON object with search results (LLM-first design)
 * OPTIONAL: Returns Markdown string if format='markdown' (for human display)
 *
 * Simplified: Direct vector search without LLM intent analysis
 * Works with short queries, long questions, Korean/English
 *
 * @param {string} userQuestion - User's question or intent
 * @param {Object} options - Search options
 * @param {string} [options.format='json'] - Output format: 'json' (default) or 'markdown'
 * @param {number} [options.limit=5] - Max results to return
 * @param {number} [options.threshold=0.6] - Minimum similarity (adaptive by query length)
 * @param {boolean} [options.useReranking=false] - Use LLM re-ranking (optional, slower)
 * @returns {Promise<Object|string|null>} Search results as JSON or Markdown, null if no results
 *
 * @example
 * // LLM usage (default)
 * const data = await mama.suggest('Why did we choose JWT?');
 * // → { query, results: [...], meta: {...} }
 *
 * // Human display
 * const markdown = await mama.suggest('mesh optimization', { format: 'markdown' });
 * // → "💡 MAMA found 3 related topics:\n1. ..."
 */
export interface SuggestFunctionOptions extends SearchQualityOptions {
  format?: 'json' | 'markdown';
  limit?: number;
  kind?: MemoryKind;
  useReranking?: boolean;
  recencyWeight?: number;
  recencyScale?: number;
  recencyDecay?: number;
  scopes?: Array<{ kind: string; id: string }>;
  /**
   * The model this runtime opened, when `useReranking` asks for one. This
   * module used to open its own (a local Ollama endpoint), which decided for
   * every host installing the library; the host states it now (§2.1).
   */
  runner?: TextCompletion;
}

/** One stated link from or to a search hit: a pointer the reader opens. */
export interface SearchHitLink {
  id: string;
  topic: string;
  /** The record's first line. */
  summary: string;
  /** Present when the record is no longer active, e.g. `superseded`. */
  status?: string;
  /** Seen from the hit: `builds_on` out, `built_on_by` in, and so on. */
  relation: string;
  reason: string | null;
  corrected_by?: DecisionCorrection[];
}

/** The relations search follows, and their names seen from the other end. */
const POINTER_RELATIONS: Record<string, string> = {
  refines: 'refined_by',
  contradicts: 'contradicted_by',
  builds_on: 'built_on_by',
  debates: 'debated_by',
  synthesizes: 'synthesized_by',
  supersedes: 'superseded_by',
};

/**
 * Each direct hit names the records its stated links reach, in both directions, including a link
 * to another hit. Expanded rows rank below every direct hit (a measured regression when they did
 * not) and are cut at the usual limits, so the link comes along on its hit instead, and the
 * reader opens the record it names. A scoped search names only records in its scopes, and a
 * correction only when the record stating it is in them.
 */
function withLinkPointers<T extends { id: string; related_to?: string | null }>(
  rows: T[],
  adapter: DatabaseAdapter,
  scopes: readonly MemoryScopeRef[] | undefined
): Array<T & { links?: SearchHitLink[] }> {
  const hitIds = rows.filter((row) => !row.related_to).map((row) => row.id);
  if (hitIds.length === 0) return rows;
  const hits = hitIds.map(() => '?').join(', ');
  const relations = Object.keys(POINTER_RELATIONS);
  const edges = adapter
    .prepare(
      `SELECT edge_id, from_id, to_id, relationship, reason FROM ${STATED_DECISION_EDGES} e
        WHERE (from_id IN (${hits}) OR to_id IN (${hits}))
          AND relationship IN (${relations.map(() => '?').join(', ')})
          AND (approved_by_user = 1 OR approved_by_user IS NULL)
        ORDER BY created_at`
    )
    .all(...hitIds, ...hitIds, ...relations) as Array<{
    edge_id: string | null;
    from_id: string;
    to_id: string;
    relationship: string;
    reason: string | null;
  }>;
  if (edges.length === 0) return rows;
  const hitSet = new Set(hitIds);
  const otherIds = [...new Set(edges.flatMap((edge) => [edge.from_id, edge.to_id]))];
  const records = new Map(
    (
      adapter
        .prepare(
          `SELECT id, topic, decision, status FROM decisions
            WHERE id IN (${otherIds.map(() => '?').join(', ')})`
        )
        .all(...otherIds) as Array<{ id: string; topic: string; decision: string; status: string }>
    ).map((record) => [record.id, record])
  );
  const corrections = correctionsOf(
    adapter,
    edges.flatMap((edge) => (edge.edge_id ? [edge.edge_id] : []))
  );
  const requested = scopes?.length ? new Set(scopes.map((s) => `${s.kind}:${s.id}`)) : null;
  const scopeMap = requested
    ? batchLoadScopes(adapter as DatabaseInstance, [
        ...otherIds,
        ...[...corrections.values()].flatMap((list) => correctionAuthors(list)),
      ])
    : new Map<string, MemoryScopeRef[]>();
  const inScope = (id: string): boolean =>
    !requested ||
    (scopeMap.get(id) ?? []).some((scope) => requested.has(`${scope.kind}:${scope.id}`));
  const byHit = new Map<string, SearchHitLink[]>();
  const point = (
    hitId: string,
    otherId: string,
    relation: string,
    edge: (typeof edges)[number]
  ) => {
    const record = records.get(otherId);
    if (!record || !inScope(otherId)) return;
    const correctedBy = edge.edge_id ? corrections.get(edge.edge_id) : undefined;
    const readable = correctedBy
      ? readableCorrections(correctedBy, (correction) => inScope(correction.from))
      : undefined;
    const list = byHit.get(hitId) ?? [];
    list.push({
      id: record.id,
      topic: record.topic,
      summary: record.decision.split('\n')[0]!.slice(0, 200),
      ...(record.status && record.status !== 'active' ? { status: record.status } : {}),
      relation,
      reason: edge.reason,
      ...(readable ? { corrected_by: readable } : {}),
    });
    byHit.set(hitId, list);
  };
  for (const edge of edges) {
    if (hitSet.has(edge.from_id)) point(edge.from_id, edge.to_id, edge.relationship, edge);
    if (hitSet.has(edge.to_id))
      point(edge.to_id, edge.from_id, POINTER_RELATIONS[edge.relationship]!, edge);
  }
  return rows.map((row) => {
    const links = row.related_to ? undefined : byHit.get(row.id);
    return links ? { ...row, links } : row;
  });
}

/**
 * A hit that is one revision of a work item says which one and the item's head. Search ranks an
 * item's revisions by their text, so an earlier revision can rank above the one that corrected it
 * (on a copy of the owner's database a revision 16 of 20 ranked first and the head was not in the
 * top ten); the reader opens the head before answering from an earlier one.
 */
function withWorkRevision<T extends { id: string }>(
  rows: T[],
  adapter: DatabaseAdapter
): Array<T & { work_item?: { commitment_id: string; revision: number; head_revision: number } }> {
  if (rows.length === 0) return rows;
  const found = new Map(
    (
      adapter
        .prepare(
          `SELECT a.record_id, a.commitment_id, a.revision, c.current_revision
             FROM commitment_assignments a
             JOIN commitments c ON c.commitment_id = a.commitment_id
            WHERE a.record_id IN (${rows.map(() => '?').join(', ')})`
        )
        .all(...rows.map((row) => row.id)) as Array<{
        record_id: string;
        commitment_id: string;
        revision: number;
        current_revision: number;
      }>
    ).map((row) => [row.record_id, row])
  );
  return rows.map((row) => {
    const work = found.get(row.id);
    return work
      ? {
          ...row,
          work_item: {
            commitment_id: work.commitment_id,
            revision: work.revision,
            head_revision: work.current_revision,
          },
        }
      : row;
  });
}

function mapRolledUpResult(result: SearchRollupResult) {
  const record = resultRecord(result);
  const reached = (record as { reached_through?: MemoryReachedThrough }).reached_through;
  const retrievalDiagnostics = result.retrieval_diagnostics;
  const topic = stringOrNull(record.topic ?? record.title) ?? result.source_id;
  // For wiki_page leaves, prefer the markdown body (`content`) in `decision` so
  // downstream consumers see the meaningful body rather than the short title.
  // Decision/checkpoint records use their own fields (summary/decision).
  const isWikiPageLeaf = result.source_type === 'wiki_page';
  const decision = isWikiPageLeaf
    ? (stringOrNull(record.content ?? record.summary ?? record.decision ?? record.title) ??
      result.source_id)
    : (stringOrNull(record.summary ?? record.decision ?? record.title ?? record.content) ??
      result.source_id);
  const reasoning =
    stringOrNull(record.details ?? record.reasoning ?? record.status_reason ?? record.content) ??
    '';

  return {
    id: result.source_id,
    topic,
    decision,
    reasoning,
    confidence: confidenceValue(record, result.score),
    // NOT similarity. `result.score` is normalized Reciprocal Rank Fusion
    // (RRF_K = 60, divided by the top hit), so the second result scores 61/62
    // and the third 61/63 whatever they say -- rank, not likeness. Mirroring it
    // into `similarity` made every save warn "High similarity (98%)" against
    // something unrelated, which teaches the reader to ignore the check. The
    // rollup path already says this and returns null; this one now agrees.
    similarity: null,
    retrieval_score: result.score,
    created_at: record.created_at ?? null,
    event_date: record.event_date ?? null,
    event_datetime: record.event_datetime ?? null,
    // An expanded record says which hit it came from and through which link, so the reader
    // can tell it from a direct hit and weigh the link's reason (and any correction of it).
    graph_source: reached?.relation ?? retrievalDiagnostics?.graph_source ?? 'primary',
    graph_rank: 1,
    related_to: reached?.from ?? null,
    edge_reason: reached?.reason ?? null,
    ...(reached?.corrected_by ? { edge_corrected_by: reached.corrected_by } : {}),
    case_id: result.case_id,
    source_type: result.source_type,
    kind: stringOrNull(record.kind) ?? 'decision',
    contributing_leaves: result.contributing_leaves ?? null,
    ...(result.contributing_leaf_diagnostics
      ? { contributing_leaf_diagnostics: result.contributing_leaf_diagnostics }
      : {}),
    ...(retrievalDiagnostics ? { retrieval_diagnostics: retrievalDiagnostics } : {}),
  };
}

export async function suggestInAdapter(
  adapter: DatabaseInstance,
  userQuestion: string,
  options: SuggestFunctionOptions = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (!userQuestion || typeof userQuestion !== 'string') {
    throw new Error('mama.suggest() requires userQuestion (string)');
  }

  const {
    format = 'json',
    limit = 5,
    threshold,
    useReranking = false,
    // Recency boosting parameters (Gaussian Decay - Elasticsearch style)
    recencyWeight = 0.3, // 0-1: How much to weight recency (0.3 = 70% semantic, 30% recency)
    recencyScale = 7, // Days until recency score drops to 50%
    recencyDecay = 0.5, // Score at scale point (0.5 = 50%)
    disableRecency = false, // Set true to disable recency boosting entirely
    strict,
    strictness,
    includeRelated,
    minLexicalSupport,
    diagnostics: includeDiagnostics,
    kind,
  } = options;
  const normalizedSearchOptions = normalizeSearchQualityOptions({
    threshold,
    strict,
    strictness,
    disableRecency,
    includeRelated,
    topicPrefix: options.topicPrefix,
    minLexicalSupport,
    diagnostics: includeDiagnostics,
  });
  const memoryV2QualityContractRequested =
    threshold !== undefined ||
    strict !== undefined ||
    strictness !== undefined ||
    includeRelated !== undefined ||
    minLexicalSupport !== undefined ||
    includeDiagnostics === true ||
    options.topicPrefix !== undefined ||
    options.scopes !== undefined ||
    options.kind !== undefined;

  try {
    // `recallMemoryInAdapter` was mama-api's alias for this file's own
    // `recallMemory`. Inside it, the function has its name.
    const bundle = await recallMemory(adapter, userQuestion, {
      includeProfile: false,
      topicPrefix: options.topicPrefix,
      limit: limit,
      threshold,
      strict,
      strictness,
      disableRecency,
      includeRelated,
      minLexicalSupport,
      diagnostics: includeDiagnostics,
      kind,
      ...(options.scopes && { scopes: options.scopes }),
    });
    const diagnosticsByMemoryId = new Map(
      bundle.memories
        .filter((memory) => memory.retrieval_diagnostics)
        .map((memory) => [memory.id, memory.retrieval_diagnostics as SearchHitDiagnostics])
    );
    const rawFusedHits = (bundle as { fused_hits?: SearchRollupLeafHit[] }).fused_hits ?? [];
    const fusedHits = rawFusedHits.map((hit) => {
      if (hit.source_type !== 'decision') {
        return hit;
      }

      const recordDiagnostics =
        typeof hit.record === 'object' && hit.record !== null && !Array.isArray(hit.record)
          ? (hit.record as { retrieval_diagnostics?: SearchHitDiagnostics }).retrieval_diagnostics
          : undefined;
      const retrievalDiagnostics = diagnosticsByMemoryId.get(hit.source_id) ?? recordDiagnostics;
      if (!retrievalDiagnostics) {
        return hit;
      }

      const record =
        typeof hit.record === 'object' && hit.record !== null && !Array.isArray(hit.record)
          ? { ...hit.record, retrieval_diagnostics: retrievalDiagnostics }
          : hit.record;
      return {
        ...hit,
        record,
        retrieval_diagnostics: retrievalDiagnostics,
      };
    });
    const rolledUp = fusedHits.length > 0 ? rollUpSearchHits({ fusedHits, adapter }) : [];
    const diagnosticsResponse =
      includeDiagnostics === true ? { diagnostics: bundle.search_meta.diagnostics ?? null } : {};

    const summarizeGraphExpansion = <
      T extends {
        graph_source?: string | null;
      },
    >(
      rows: T[]
    ) => {
      const sources = {
        primary: 0,
        supersedes_chain: 0,
        refines: 0,
        refined_by: 0,
        contradicts: 0,
      };

      let expandedCount = 0;
      for (const row of rows) {
        const graphSource = row.graph_source ?? 'primary';
        if (graphSource === 'primary') {
          sources.primary += 1;
          continue;
        }

        expandedCount += 1;
        if (graphSource in sources) {
          const key = graphSource as keyof typeof sources;
          sources[key] += 1;
        }
      }

      return {
        total_results: rows.length,
        primary_count: sources.primary,
        expanded_count: expandedCount,
        sources,
      };
    };

    if (rolledUp.length > 0) {
      const filteredResults = rolledUp.slice(0, limit);
      const mappedResults = filteredResults.map(mapRolledUpResult);
      const limitedResults = withWorkRevision(
        withLinkPointers(mappedResults.slice(0, limit), adapter, options.scopes),
        adapter
      );

      if (format === 'markdown') {
        const context = limitedResults
          .map(
            (result, index) =>
              `${index + 1}. [${result.topic}] ${result.decision}\n   ${result.reasoning}`
          )
          .join('\n');
        return `🔍 Search method: memory_v2\n${context}`;
      }

      return {
        query: userQuestion,
        results: limitedResults,
        ...diagnosticsResponse,
        meta: {
          count: limitedResults.length,
          search_method: 'memory_v2',
          threshold: normalizedSearchOptions.threshold,
          recency_boost: disableRecency
            ? null
            : {
                weight: recencyWeight,
                scale: recencyScale,
                decay: recencyDecay,
              },
          graph_expansion: summarizeGraphExpansion(limitedResults),
        },
      };
    }

    if (bundle.memories.length > 0) {
      // recallMemory uses RRF fusion — confidence is overwritten with the normalized
      // retrieval score (0-1 range, where 1.0 = best match in this result set).
      // The original stored confidence is lost after RRF normalization.
      // We capture the retrieval score separately so `similarity` reflects search
      // relevance while `confidence` is passed through as-is from the bundle.
      const filteredMemories = bundle.memories.slice(0, limit);
      const baseRows = filteredMemories.map((memory) => ({
        id: memory.id,
        topic: memory.topic,
        decision: memory.summary,
        reasoning: memory.details,
        confidence: memory.confidence,
        // recallMemory currently normalizes fused retrieval rank into `confidence`.
        // Keep that value visible as retrieval_score, but do not pretend it is
        // semantic similarity; save-time warning logic keys off `similarity`.
        similarity: null,
        retrieval_score: memory.confidence ?? null,
        final_score: memory.confidence ?? null,
        created_at: memory.created_at,
        event_date: memory.event_date ?? null,
        event_datetime: memory.event_datetime ?? null,
        graph_source: memory.retrieval_diagnostics?.graph_source ?? 'primary',
        graph_rank: 1,
        related_to: null,
        edge_reason: null,
        case_id: null as string | null,
        source_type:
          memory.kind ??
          memory.source?.source_type ??
          (memory as { source_type?: string; type?: string }).source_type ??
          (memory as { type?: string }).type ??
          'decision',
        kind: memory.kind,
        ...(memory.retrieval_diagnostics
          ? { retrieval_diagnostics: memory.retrieval_diagnostics }
          : {}),
      }));
      const limitedRows = withWorkRevision(
        withLinkPointers(baseRows.slice(0, limit), adapter, options.scopes),
        adapter
      );

      if (format === 'markdown') {
        const context = limitedRows
          .map((row, index) => `${index + 1}. [${row.topic}] ${row.decision}\n   ${row.reasoning}`)
          .join('\n');
        return `🔍 Search method: memory_v2\n${context}`;
      }

      return {
        query: userQuestion,
        results: limitedRows,
        ...diagnosticsResponse,
        meta: {
          count: limitedRows.length,
          search_method: 'memory_v2',
          threshold: normalizedSearchOptions.threshold,
          recency_boost: disableRecency
            ? null
            : {
                weight: recencyWeight,
                scale: recencyScale,
                decay: recencyDecay,
              },
          graph_expansion: summarizeGraphExpansion(limitedRows),
        },
      };
    }

    if (memoryV2QualityContractRequested) {
      const emptyRows: Array<{ id: string; source_type?: string; graph_source?: string | null }> =
        [];
      if (format === 'markdown') {
        return '🔍 Search method: memory_v2\n';
      }

      return {
        query: userQuestion,
        results: emptyRows,
        ...diagnosticsResponse,
        meta: {
          count: 0,
          search_method: 'memory_v2',
          threshold: normalizedSearchOptions.threshold,
          recency_boost: disableRecency
            ? null
            : {
                weight: recencyWeight,
                scale: recencyScale,
                decay: recencyDecay,
              },
          graph_expansion: summarizeGraphExpansion(emptyRows),
        },
      };
    }

    // 1. Try vector search first (if sqlite-vss is available)
    // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-explicit-any
    let results: any[] = [];
    let searchMethod = 'vector';

    try {
      // Generate query embedding
      const queryEmbedding = await generateEmbedding(userQuestion, 'query');

      // Adaptive threshold (shorter queries need higher confidence)
      const wordCount = userQuestion.split(/\s+/).length;
      const adaptiveThreshold = threshold !== undefined ? threshold : wordCount < 3 ? 0.7 : 0.6;

      // Vector search
      results = await vectorSearch(
        adapter,
        queryEmbedding,
        limit * 2,
        0.5,
        undefined,
        undefined,
        kind
      ); // Get more candidates

      // Filter by adaptive threshold
      results = results.filter((r) => r.similarity >= adaptiveThreshold);

      // Stage 1.4: Temporal boost — detect time-related queries and boost matching results
      {
        const temporalPatterns = [
          // English
          /\b(yesterday|today|last\s+(?:week|month|year)|(\d+)\s+(?:days?|weeks?|months?)\s+ago)\b/i,
          /\b(before|after|since|until|during)\s+\w+/i,
          /\b(how\s+long|when\s+did|what\s+date|what\s+day)\b/i,
          // Korean
          /(?:어제|오늘|그제|지난\s*(?:주|달|해)|(\d+)\s*(?:일|주|달|개월)\s*(?:전|후|뒤))/, // Korean: temporal query detection
          /(?:언제|얼마나|며칠|몇\s*(?:일|주|달|개월))/, // Korean: temporal query detection
        ];
        const isTemporalQuery = temporalPatterns.some((p) => p.test(userQuestion));

        if (isTemporalQuery && results.length > 0) {
          // Boost results that contain date/time references in their content
          const datePatterns = [
            /\d{4}[-/]\d{1,2}[-/]\d{1,2}/,
            /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d/i,
            /\d+\s*(?:일|월|년|주|시간|분)/, // Korean: date reference in content
            /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
            /(?:월요일|화요일|수요일|목요일|금요일|토요일|일요일)/, // Korean: date reference in content
          ];

          for (const result of results) {
            const content = `${result.decision || ''} ${result.reasoning || ''}`;
            const hasDateRef = datePatterns.some((p) => p.test(content));
            if (hasDateRef) {
              result.similarity = Math.min(1.0, (result.similarity || 0) + 0.1);
            }
          }
          results.sort(
            (a: { similarity?: number }, b: { similarity?: number }) =>
              (b.similarity || 0) - (a.similarity || 0)
          );
        }
      }

      // Stage 1.5: Apply recency boosting (Gaussian Decay)
      // Allows Claude to adjust search strategy (recent vs historical)
      if (results.length > 0 && !disableRecency) {
        results = applyRecencyBoost(results, {
          recencyWeight,
          recencyScale,
          recencyDecay,
          disableRecency,
        });
        searchMethod = 'vector+recency';
      }

      // Stage 1.7: FTS5 hybrid merge (Haiku Memory Layer)
      {
        // The question's words as quoted text, all of them required, as before; unquoted, a date or
        // a hyphen raised an FTS5 error here that was swallowed.
        const ftsExpression = ftsMatchTerms(ftsWords(userQuestion), 'AND');
        const ftsResults =
          ftsExpression === null ? [] : await fts5Search(adapter, ftsExpression, limit * 2, kind);
        if (ftsResults.length > 0) {
          const maxRank = Math.max(...ftsResults.map((r) => Math.abs(r.rank)));
          const ftsMap = new Map(ftsResults.map((r) => [r.id, bm25Relevance(r.rank, maxRank)]));

          // Tunable hybrid weights (env: MAMA_VECTOR_WEIGHT, MAMA_FTS5_WEIGHT)
          const vectorWeight = parseFloat(process.env.MAMA_VECTOR_WEIGHT || '0.6');
          const fts5Weight = parseFloat(process.env.MAMA_FTS5_WEIGHT || '0.4');

          // Merge: boost existing results that also matched FTS5
          for (const result of results) {
            const ftsScore = ftsMap.get(result.id);
            if (ftsScore !== undefined) {
              result.similarity = vectorWeight * result.similarity + fts5Weight * ftsScore;
              ftsMap.delete(result.id);
            }
          }

          // Add FTS5-only results (not in embedding results)
          for (const [id, ftsScore] of ftsMap) {
            const ftsResult = ftsResults.find((r) => r.id === id);
            if (ftsResult) {
              // Need to get full decision record
              const stmt = adapter.prepare(
                'SELECT * FROM decisions WHERE id = ? AND superseded_by IS NULL'
              );
              const decision = stmt.get(id) as (DecisionRecord & { kind?: string }) | undefined;
              if (decision && (kind === undefined || decision.kind === kind)) {
                results.push({
                  ...decision,
                  similarity: fts5Weight * ftsScore, // Only FTS5 score component
                  graph_source: 'fts5',
                });
              }
            }
          }

          // Re-sort by similarity
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          results.sort(
            (a: { similarity?: number }, b: { similarity?: number }) =>
              (b.similarity || 0) - (a.similarity || 0)
          );
          searchMethod = disableRecency ? 'vector+fts5' : 'vector+recency+fts5';
        }
      }

      // Stage 2: Graph expansion (NEW - Phase 1)
      // Expand candidates with supersedes chain and semantic edges
      if (results.length > 0) {
        const graphEnhanced = await expandWithGraphInAdapter(adapter, results);
        results = graphEnhanced;
        searchMethod = disableRecency ? 'vector+graph' : 'vector+recency+graph';
      }

      // Stage 2.5: is_static boost (after graph expansion to preserve sort order)
      for (const result of results) {
        if (result.is_static === 1) {
          result.final_score = Math.min(1.0, (result.final_score ?? result.similarity ?? 0) + 0.2);
        }
      }
      // Re-sort by final_score after is_static boost
      results.sort(
        (a, b) => (b.final_score ?? b.similarity ?? 0) - (a.final_score ?? a.similarity ?? 0)
      );
    } catch (vectorError: unknown) {
      // Fallback to keyword search if vector search unavailable
      logWarn(
        `Vector search failed: ${vectorError instanceof Error ? vectorError.message : String(vectorError)}, falling back to keyword search`
      );
      searchMethod = 'keyword';

      // Keyword search fallback
      const keywords = userQuestion
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2); // Filter short words

      if (keywords.length === 0) {
        if (format === 'markdown') {
          return `💡 Hint: Please be more specific.\nExample: "Railway Volume settings" or "mesh parameter optimization"`;
        }
        return null; // JSON mode returns null for empty/invalid queries
      }

      // Build LIKE query for each keyword
      const likeConditions = keywords.map(() => '(topic LIKE ? OR decision LIKE ?)').join(' OR ');
      const likeParams = keywords.flatMap((k) => [`%${k}%`, `%${k}%`]);
      const kindClause = kind === undefined ? '' : 'AND kind = ?';

      const stmt = adapter.prepare(`
        SELECT * FROM decisions
        WHERE ${likeConditions}
        AND superseded_by IS NULL
        ${kindClause}
        ORDER BY created_at DESC
        LIMIT ?
      `);

      const rows = (await stmt.all(
        ...likeParams,
        ...(kind === undefined ? [] : [kind]),
        limit
      )) as DecisionRecord[];
      results = rows.map((row: DecisionRecord) => ({
        ...row,
        similarity: 0.75, // Assign moderate similarity for keyword matches
      }));

      // Stage 2: Graph expansion for keyword results (Phase 1)
      if (results.length > 0) {
        const graphEnhanced = await expandWithGraphInAdapter(adapter, results);
        results = graphEnhanced;
        searchMethod = 'keyword+graph';
      }
    }

    if (results.length === 0) {
      if (format === 'markdown') {
        const wordCount = userQuestion.split(/\s+/).length;
        if (wordCount < 3) {
          return `💡 Hint: Please be more specific.\nExample: "Why did we choose COMPLEX mesh structure?" or "What parameters are used for large layers?"`;
        }
      }
      return null;
    }

    // 5. Optional: LLM re-ranking (only if requested)
    if (useReranking) {
      results = await rerankWithLLM(options.runner, userQuestion, results);
    }

    const rerankCandidateResults = results.slice(0, limit);

    const vectorRows = rerankCandidateResults.map((r) => ({
      id: r.id,
      topic: r.topic,
      decision: r.decision,
      reasoning: r.reasoning,
      confidence: r.confidence,
      similarity: r.similarity,
      created_at: r.created_at,
      event_date: r.event_date ?? null,
      event_datetime: r.event_datetime ?? null,
      kind: (r as DecisionRecord & { kind?: string }).kind ?? 'decision',
      // Recency metadata (NEW - Gaussian Decay)
      recency_score: r.recency_score,
      recency_age_days: r.recency_age_days,
      final_score: r.final_score || r.similarity, // Falls back to similarity if no recency
      retrieval_score: r.similarity ?? null,
      // Graph metadata (NEW - Phase 1)
      graph_source: r.graph_source || 'primary',
      graph_rank: r.graph_rank || 1.0,
      related_to: r.related_to || null,
      edge_reason: r.edge_reason || null,
      case_id: null as string | null,
      source_type: 'decision',
    }));
    const finalResults = vectorRows.slice(0, limit);

    // Markdown format (for human display)
    if (format === 'markdown') {
      const context = formatContext(finalResults, { maxTokens: 500 });

      // Add graph expansion summary if applicable
      let graphSummary = '';
      if (searchMethod.includes('graph')) {
        const primaryCount = finalResults.filter((r) => r.graph_source === 'primary').length;
        const expandedCount = finalResults.filter((r) => r.graph_source !== 'primary').length;

        graphSummary = `\n📊 Graph expansion: ${primaryCount} primary + ${expandedCount} related (supersedes/refines/contradicts)\n`;
      }

      return `🔍 Search method: ${searchMethod}${graphSummary}\n${context}`;
    }

    // Calculate graph expansion stats
    const graphStats = {
      total_results: finalResults.length,
      primary_count: finalResults.filter((r) => r.graph_source === 'primary').length,
      expanded_count: finalResults.filter((r) => r.graph_source !== 'primary').length,
      sources: {
        primary: finalResults.filter((r) => r.graph_source === 'primary').length,
        supersedes_chain: finalResults.filter((r) => r.graph_source === 'supersedes_chain').length,
        refines: finalResults.filter((r) => r.graph_source === 'refines').length,
        refined_by: finalResults.filter((r) => r.graph_source === 'refined_by').length,
        contradicts: finalResults.filter((r) => r.graph_source === 'contradicts').length,
      },
    };

    return {
      query: userQuestion,
      results: finalResults,
      meta: {
        count: finalResults.length,
        search_method: searchMethod,
        threshold: threshold || 'adaptive',
        // Recency boosting config (NEW - Gaussian Decay)
        recency_boost: disableRecency
          ? null
          : {
              weight: recencyWeight,
              scale: recencyScale,
              decay: recencyDecay,
            },
        // Graph expansion stats (NEW - Phase 1)
        graph_expansion: searchMethod.includes('graph') ? graphStats : null,
      },
    };
  } catch (error: unknown) {
    // Graceful degradation
    logWarn(`mama.suggest() failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Re-rank search results using local LLM (optional enhancement)
 *
 * @param {string} userQuestion - User's question
 * @param {Array} results - Vector search results
 * @returns {Promise<Array>} Re-ranked results
 */
async function rerankWithLLM(
  runner: TextCompletion | undefined,
  userQuestion: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  results: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  if (!runner) {
    // No model was stated for this runtime, so there is nothing to ask. The
    // ranking already computed stands, which is what an unreachable model
    // produced before — said once, here, rather than discovered as a failure.
    logWarn('Re-ranking skipped: this runtime states no model runner; using vector ranking');
    return results;
  }
  try {
    const prompt = `User asked: "${userQuestion}"

Found decisions (ranked by vector similarity):
${results.map((r: SearchCandidate, i: number) => `${i + 1}. [${(r.similarity ?? 0).toFixed(3)}] ${r.topic}: ${r.decision.substring(0, 60)}...`).join('\n')}

Re-rank these by actual relevance to the user's intent (not just keyword similarity).
Return JSON: { "ranking": [index1, index2, ...] } (0-based indices)

Example: { "ranking": [2, 0, 4, 1, 3] } means 3rd is most relevant, then 1st, then 5th...`;

    const response = await runner(prompt, {
      format: 'json',
      temperature: 0.3,
      maxTokens: 100,
      timeoutMs: 3000,
    });

    const parsed = typeof response === 'string' ? JSON.parse(response) : response;

    // Reorder results based on LLM ranking
    return parsed.ranking.map((idx: number) => results[idx]).filter(Boolean);
  } catch (error: unknown) {
    logWarn(
      `Re-ranking failed: ${error instanceof Error ? error.message : String(error)}, using vector ranking`
    );
    return results; // Fallback to vector ranking
  }
}

/**
 * List recent decisions (all topics, chronological)
 *
 * DEFAULT: Returns JSON array with recent decisions (LLM-first design)
 * OPTIONAL: Returns Markdown string if format='markdown' (for human display)
 *
 * @param {Object} [options] - Options
 * @param {number} [options.limit=10] - Max results
 * @param {string} [options.format='json'] - Output format
 * @returns {Promise<Array|string>} Recent decisions
 */
export interface ListDecisionsOptions {
  limit?: number;
  format?: 'json' | 'markdown';
  kind?: MemoryKind;
  scopes?: Array<{ kind: string; id: string }>;
  /**
   * Exact ledger read: every decision whose topic starts with this string, superseded rows
   * included (they are the earlier rounds of the same item). `%` and `_` are literal.
   * This is a lookup, not a search - `suggest({topicPrefix})` treats the prefix as a soft
   * signal and was measured returning 5 of 12 rows plus one from another item.
   */
  topicPrefix?: string;
}

/** `LIKE ? ESCAPE '\\'` pattern that matches topics starting with `prefix`, metacharacters literal. */
function topicPrefixLikePattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listDecisionsInAdapter(
  adapter: DatabaseAdapter,
  options: ListDecisionsOptions = {}
): Promise<DecisionRecord[] | string> {
  const { limit = 10, format = 'json' } = options;

  try {
    let decisions;
    const topicPrefix = typeof options.topicPrefix === 'string' ? options.topicPrefix.trim() : '';
    // A prefix read keeps superseded rows: they are the item's earlier rounds.
    const currency = topicPrefix ? '' : 'AND d.superseded_by IS NULL';
    const kindClause = options.kind === undefined ? '' : 'AND d.kind = ?';
    const prefixClause = topicPrefix ? "AND d.topic LIKE ? ESCAPE '\\'" : '';
    const prefixParams = topicPrefix ? [topicPrefixLikePattern(topicPrefix)] : [];
    const kindParams = options.kind === undefined ? [] : [options.kind];

    if (options.scopes && options.scopes.length > 0) {
      // Scope-filtered query: JOIN memory_scope_bindings + memory_scopes
      const scopeIds = await Promise.all(
        options.scopes.map((s) => ensureMemoryScope(adapter, s.kind, s.id))
      );
      const placeholders = scopeIds.map(() => '?').join(', ');
      const stmt = adapter.prepare(`
        SELECT DISTINCT d.* FROM decisions d
        JOIN memory_scope_bindings msb ON msb.memory_id = d.id
        WHERE msb.scope_id IN (${placeholders})
          ${currency}
          ${kindClause}
          ${prefixClause}
        ORDER BY COALESCE(d.event_datetime, d.created_at) DESC, d.created_at DESC
        LIMIT ?
      `);
      decisions = await stmt.all(...scopeIds, ...kindParams, ...prefixParams, limit);
    } else {
      const stmt = adapter.prepare(`
        SELECT d.* FROM decisions d
        WHERE 1 = 1
          ${currency}
          ${kindClause}
          ${prefixClause}
        ORDER BY COALESCE(d.event_datetime, d.created_at) DESC, d.created_at DESC
        LIMIT ?
      `);
      decisions = await stmt.all(...kindParams, ...prefixParams, limit);
    }

    if (format === 'markdown') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return formatList(decisions as any[]);
    }

    return decisions as DecisionRecord[];
  } catch (error: unknown) {
    throw new Error(
      `mama.listDecisions() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Update outcome of a decision
 *
 * Track whether a decision succeeded, failed, or partially worked
 * AC: Evolutionary Decision Memory - Learn from outcomes
 *
 * @param {string} decisionId - Decision ID to update
 * @param {Object} outcome - Outcome details
 * @param {string} outcome.outcome - 'SUCCESS', 'FAILED', or 'PARTIAL'
 * @param {string} [outcome.failure_reason] - Reason for failure (if FAILED)
 * @param {string} [outcome.limitation] - Limitation description (if PARTIAL)
 * @returns {Promise<void>}
 *
 * @example
 * await mama.updateOutcome('decision_auth_strategy_123456_abc', {
 *   outcome: 'FAILED',
 *   failure_reason: 'Missing token expiration handling'
 * });
 */
export interface UpdateOutcomeParams {
  outcome: string;
  failure_reason?: string | null;
  limitation?: string | null;
}

export async function updateOutcomeInAdapter(
  adapter: DatabaseInstance,
  decisionId: string,
  { outcome, failure_reason, limitation }: UpdateOutcomeParams
): Promise<void> {
  if (!decisionId || typeof decisionId !== 'string') {
    throw new Error('mama.updateOutcome() requires decisionId (string)');
  }

  // AX Improvement: Be forgiving with case sensitivity
  const normalizedOutcome = outcome ? outcome.toUpperCase() : null;

  if (!normalizedOutcome || !['SUCCESS', 'FAILED', 'PARTIAL'].includes(normalizedOutcome)) {
    throw new Error('mama.updateOutcome() outcome must be "SUCCESS", "FAILED", or "PARTIAL"');
  }

  try {
    // Append-only: one judgment record carries the outcome change; the
    // maintained decisions projection columns move in the same transaction.
    await appendOutcomeAmendment(
      decisionId,
      {
        outcome: normalizedOutcome,
        failureReason: failure_reason || null,
        limitation: limitation || null,
        eventReason: `mama.updateOutcome(${decisionId})`,
      },
      { adapter }
    );

    return;
  } catch (error: unknown) {
    throw new Error(
      `mama.updateOutcome() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * List recent checkpoints (New Feature: Session Continuity)
 *
 * @param {number} limit - Max number of checkpoints to return
 * @returns {Promise<Array>} Recent checkpoints
 */
/** What a stats read answers: counts over the memory a caller may see. */
export interface MemoryStatsResult {
  total: number;
  thisWeek: number;
  thisMonth: number;
  checkpoints: number;
  outcomes: Record<string, number>;
  topTopics: Array<{ topic: string; count: number }>;
}

/**
 * Counts over the admitted corpus.
 *
 * Every count answers the same question the scope filter answers for a listing:
 * a decision this caller may not read is not a decision it may count. An
 * admitted-empty caller counts zero rather than counting everything — the same
 * fail-closed reading the listing gives.
 */
export async function readMemoryStatsInAdapter(
  adapter: DatabaseAdapter,
  scopes: readonly { kind: string; id: string }[]
): Promise<MemoryStatsResult> {
  const empty: MemoryStatsResult = {
    total: 0,
    thisWeek: 0,
    thisMonth: 0,
    checkpoints: 0,
    outcomes: {},
    topTopics: [],
  };
  if (scopes.length === 0) {
    return empty;
  }
  const scopeIds = await Promise.all(
    scopes.map((scope) => ensureMemoryScope(adapter, scope.kind, scope.id))
  );
  const placeholders = scopeIds.map(() => '?').join(', ');
  const admitted = `
    JOIN memory_scope_bindings msb ON msb.memory_id = d.id
    WHERE msb.scope_id IN (${placeholders})
  `;
  const now = Date.now();
  const countSince = async (since?: number): Promise<number> => {
    const stmt = adapter.prepare(`
      SELECT COUNT(DISTINCT d.id) as count FROM decisions d
      ${admitted}
      ${since === undefined ? '' : 'AND d.created_at > ?'}
    `);
    const row = (await stmt.get(...scopeIds, ...(since === undefined ? [] : [since]))) as
      | { count?: number }
      | undefined;
    return row?.count ?? 0;
  };
  const day = 24 * 60 * 60 * 1000;
  const [total, thisWeek, thisMonth] = await Promise.all([
    countSince(),
    countSince(now - 7 * day),
    countSince(now - 30 * day),
  ]);
  const outcomeRows = (await adapter
    .prepare(
      `SELECT d.outcome as outcome, COUNT(DISTINCT d.id) as count FROM decisions d
       ${admitted} AND d.outcome IS NOT NULL
       GROUP BY d.outcome`
    )
    .all(...scopeIds)) as Array<{ outcome: string | null; count: number }>;
  const outcomes: Record<string, number> = {};
  for (const row of outcomeRows) {
    outcomes[row.outcome?.toLowerCase() ?? 'unknown'] = row.count;
  }
  const topTopics = (await adapter
    .prepare(
      `SELECT d.topic as topic, COUNT(DISTINCT d.id) as count FROM decisions d
       ${admitted} AND d.topic IS NOT NULL
       GROUP BY d.topic
       ORDER BY count DESC
       LIMIT 5`
    )
    .all(...scopeIds)) as Array<{ topic: string; count: number }>;
  // Checkpoints carry no scope binding, and `memory.checkpoint.load` reads them
  // under the same authority: the count is of what that read can reach.
  const checkpointRow = (await adapter
    .prepare('SELECT COUNT(*) as count FROM checkpoints')
    .get()) as { count?: number } | undefined;
  return {
    total,
    thisWeek,
    thisMonth,
    checkpoints: checkpointRow?.count ?? 0,
    outcomes,
    topTopics,
  };
}

/**
 * Load latest active checkpoint (New Feature: Session Continuity)
 *
 * @returns {Promise<Object|null>} Latest checkpoint or null
 */
interface ConversationMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/**
 * Save current session checkpoint (New Feature: Session Continuity)
 *
 * @param {string} summary - Summary of current session state
 * @param {Array<string>} openFiles - List of currently open files
 * @param {string} nextSteps - Next steps to be taken
 * @returns {Promise<number>} Checkpoint ID
 */
export async function saveCheckpointInAdapter(
  adapter: DatabaseAdapter,
  summary: string,
  openFiles: string[] = [],
  nextSteps: string = '',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recentConversation: any[] = []
): Promise<number | bigint> {
  if (!summary) {
    throw new Error('Summary is required for checkpoint');
  }
  const scan = scanMemoryWriteInput({
    summary,
    open_files: openFiles,
    next_steps: nextSteps,
    recent_conversation: recentConversation,
  });
  if (!scan.clean) throw new SecretMaterialRefusedError(scan.matches);
  if (scan.warnings.length > 0) warn(`Checkpoint content warnings: ${scan.warnings.join(', ')}`);

  try {
    const stmt = adapter.prepare(`
      INSERT INTO checkpoints (timestamp, summary, open_files, next_steps, recent_conversation, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `);

    const result = stmt.run(
      Date.now(),
      summary,
      JSON.stringify(openFiles),
      nextSteps,
      JSON.stringify(recentConversation || [])
    );

    return result.lastInsertRowid;
  } catch (error: unknown) {
    throw new Error(
      `Failed to save checkpoint: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export interface CheckpointRow {
  id?: number;
  timestamp?: number;
  summary?: string;
  open_files?: string | string[];
  next_steps?: string;
  recent_conversation?: string | ConversationMessage[];
  status?: string;
}

export async function loadCheckpointInAdapter(
  adapter: DatabaseAdapter
): Promise<CheckpointRow | null> {
  try {
    const stmt = adapter.prepare(`
      SELECT * FROM checkpoints
      WHERE status = 'active'
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const checkpoint = stmt.get() as CheckpointRow | undefined;

    if (checkpoint) {
      try {
        checkpoint.open_files =
          typeof checkpoint.open_files === 'string'
            ? JSON.parse(checkpoint.open_files)
            : checkpoint.open_files || [];
      } catch {
        checkpoint.open_files = [];
      }

      try {
        checkpoint.recent_conversation =
          typeof checkpoint.recent_conversation === 'string'
            ? JSON.parse(checkpoint.recent_conversation || '[]')
            : checkpoint.recent_conversation || [];
      } catch {
        checkpoint.recent_conversation = [];
      }
    }

    return checkpoint || null;
  } catch (error: unknown) {
    throw new Error(
      `Failed to load checkpoint: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function listCheckpointsInAdapter(
  adapter: DatabaseAdapter,
  limit: number = 10
): Promise<CheckpointRow[]> {
  try {
    const stmt = adapter.prepare(`
      SELECT * FROM checkpoints
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const checkpoints = stmt.all(limit) as CheckpointRow[];

    return checkpoints.map((c: CheckpointRow) => {
      try {
        c.open_files =
          typeof c.open_files === 'string' ? JSON.parse(c.open_files) : c.open_files || [];
      } catch {
        c.open_files = [];
      }
      try {
        c.recent_conversation =
          typeof c.recent_conversation === 'string'
            ? JSON.parse(c.recent_conversation)
            : c.recent_conversation || [];
      } catch {
        c.recent_conversation = [];
      }
      return c;
    });
  } catch (error: unknown) {
    throw new Error(
      `Failed to list checkpoints: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
