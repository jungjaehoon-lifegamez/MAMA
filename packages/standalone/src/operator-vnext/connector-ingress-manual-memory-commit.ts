import crypto from 'node:crypto';
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  createTrustedProvenanceCapability,
  listMemoriesByGatewayCallId,
  promoteMemoryStatus,
  saveMemoryWithTrustedProvenance,
  type MemoryKind,
  type MemoryProvenanceRecord,
  type MemoryScopeRef,
  type MemoryStatus,
  type PublicSaveMemoryInput,
  type TrustedMemoryWriteOptions,
} from '@jungjaehoon/mama-core';
import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';
import { serializeSourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { SQLiteDatabase } from '../sqlite.js';
import {
  buildConnectorOperatorCursorName,
  type ConnectorEventIngressAdapter,
} from './connector-event-ingress.js';
import {
  assertReviewedConnectorIngressSeqs,
  MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS,
  readConnectorOperatorCursorSeq,
  readReviewedConnectorIngressEvents,
} from './connector-ingress-reviewed-events.js';
import { ConnectorIngressManualCommitRequestError } from './connector-ingress-manual-commit.js';
import {
  runWithPrimaryOperatorCursorLock,
  type PrimaryOperatorBatchResult,
  type PrimaryOperatorEvent,
} from './primary-operator-runtime.js';
import {
  buildConnectorIdempotencyKey,
  buildCursorScopedIdempotencyKey,
  commitOperatorCursor,
} from './operator-cursor-commit.js';
import { nonNegativeInteger, requiredString } from './validation.js';

interface ExistingOperatorCommitRow {
  idempotency_key: string;
  status: string;
  changed_refs_json: string;
}

interface ExistingMemoryOperatorCommitRow extends ExistingOperatorCommitRow {
  source_refs_json: string;
  first_change_seq: number;
  last_change_seq: number;
}

type MemoryCommitIntentStatus = 'pending' | 'saving' | 'saved' | 'promoted';

interface MemoryCommitIntentRow {
  intent_id: string;
  cursor_name: string;
  idempotency_key: string;
  expected_memory_count: number;
  memory_payload_hash: string;
  memory_ids_json: string;
  source_refs_json: string;
  status: MemoryCommitIntentStatus;
  claim_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface PreparedMemoryCursorCommit {
  seq: number;
  idempotencyKey: string;
  sourceRefs: readonly SourceRef[];
  memories: readonly ManualMemorySaveInput[];
  changedRefs: SourceRef[];
  memoryIds: string[];
  intentStatus: MemoryCommitIntentStatus;
}

export interface ManualMemorySaveInput {
  topic: string;
  kind: MemoryKind;
  summary: string;
  details: string;
  confidence?: number;
  status?: MemoryStatus;
  scopes: MemoryScopeRef[];
  eventDate?: string;
  eventDateTime?: number;
}

export interface ConnectorIngressManualMemoryEventMemories {
  eventIndexId: string;
  memories: readonly ManualMemorySaveInput[];
}

export interface ConnectorIngressManualMemoryCommitInput {
  rawAdapter: ConnectorEventIngressAdapter;
  operatorDb: SQLiteDatabase;
  connector: string;
  channel: string;
  expectedAdvancedThroughSeq: number;
  eventMemories: readonly ConnectorIngressManualMemoryEventMemories[];
  saveMemory: (
    input: PublicSaveMemoryInput,
    options: TrustedMemoryWriteOptions
  ) => Promise<{ success: boolean; id: string }>;
  createTrustedProvenanceCapability: () => TrustedMemoryWriteOptions['capability'];
  listMemoriesByGatewayCallId: (gatewayCallId: string) => Promise<MemoryProvenanceRecord[]>;
  setMemoryStatus: (input: { memoryId: string; status: MemoryStatus }) => Promise<void> | void;
  nowMs?: () => number;
}

export interface ConnectorIngressManualMemoryCommitResult {
  ok: boolean;
  mode: 'manual_memory_commit';
  status: PrimaryOperatorBatchResult['status'];
  cursorName: string;
  connector: string;
  channel: string;
  requestedCount: number;
  processed: number;
  advancedThroughSeq: number;
  firstSeq: number | null;
  lastSeq: number | null;
  memoriesSaved: number;
  promotionPending?: boolean;
  commits: Array<{
    seq: number;
    status: 'changed';
    outcome: 'committed' | 'already_committed' | 'recovered';
    cursorAdvanced: boolean;
  }>;
  failedSeq?: number;
  error?: string;
}

export type ConnectorIngressManualMemoryCommitProvider = (
  input: Omit<
    ConnectorIngressManualMemoryCommitInput,
    | 'rawAdapter'
    | 'operatorDb'
    | 'saveMemory'
    | 'createTrustedProvenanceCapability'
    | 'listMemoriesByGatewayCallId'
    | 'setMemoryStatus'
    | 'nowMs'
  >
) => Promise<ConnectorIngressManualMemoryCommitResult>;

export const MAX_MANUAL_MEMORY_COMMIT_TOTAL_MEMORIES = MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS;

const PARTIAL_FAILURE_MESSAGE = 'Manual memory commit partially failed.';
const MEMORY_COMMIT_SAVING_LEASE_MS = 15 * 60 * 1000;
const MEMORY_COMMIT_SAVING_HEARTBEAT_MS = Math.floor(MEMORY_COMMIT_SAVING_LEASE_MS / 3);
const MEMORY_KIND_SET = new Set<string>(MEMORY_KINDS);
const MEMORY_STATUS_SET = new Set<string>(MEMORY_STATUSES);
const MEMORY_SCOPE_KIND_SET = new Set<string>(['global', 'user', 'channel', 'project']);

function requestError(message: string): ConnectorIngressManualCommitRequestError {
  return new ConnectorIngressManualCommitRequestError(message);
}

function readReviewedEvents(input: {
  rawAdapter: ConnectorEventIngressAdapter;
  connector: string;
  channel: string;
  eventIndexIds: readonly string[];
}): PrimaryOperatorEvent[] {
  return readReviewedConnectorIngressEvents({
    rawAdapter: input.rawAdapter,
    connector: input.connector,
    channel: input.channel,
    eventIndexIds: input.eventIndexIds,
    requestError,
  });
}

function rejectManualMemoryInput(): never {
  throw requestError(
    'Manual memory source and refs are derived from reviewed events, not request payloads'
  );
}

function requiredMemoryString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw requestError(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw requestError(`${field} must be a non-empty string`);
  }
  return trimmed;
}

function optionalMemoryString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredMemoryString(value, field);
}

function normalizeConfidence(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw requestError('confidence must be a number between 0 and 1');
  }
  return value;
}

function normalizeEventDate(value: unknown): string | undefined {
  const eventDate = optionalMemoryString(value, 'eventDate');
  if (eventDate === undefined) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventDate);
  if (!match) {
    throw requestError('eventDate must be an ISO 8601 YYYY-MM-DD date');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw requestError('eventDate must be an ISO 8601 YYYY-MM-DD date');
  }
  return eventDate;
}

function normalizeEventDateTime(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw requestError('eventDateTime must be a positive millisecond timestamp');
  }
  return value;
}

function normalizeKind(value: unknown): MemoryKind {
  const kind = requiredMemoryString(value, 'kind');
  if (!MEMORY_KIND_SET.has(kind)) {
    throw requestError(`Unsupported memory kind: ${kind}`);
  }
  return kind as MemoryKind;
}

function normalizeStatus(value: unknown): MemoryStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  const status = requiredMemoryString(value, 'status');
  if (!MEMORY_STATUS_SET.has(status)) {
    throw requestError(`Unsupported memory status: ${status}`);
  }
  return status as MemoryStatus;
}

function normalizeScopes(value: unknown): MemoryScopeRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw requestError('scopes must be a non-empty array');
  }
  return value.map((rawScope, index) => {
    if (typeof rawScope !== 'object' || rawScope === null || Array.isArray(rawScope)) {
      throw requestError('scopes must contain objects');
    }
    const scope = rawScope as Record<string, unknown>;
    const kind = requiredMemoryString(scope.kind, `scopes[${index}].kind`);
    if (!MEMORY_SCOPE_KIND_SET.has(kind)) {
      throw requestError(`Unsupported memory scope kind: ${kind}`);
    }
    return {
      kind: kind as MemoryScopeRef['kind'],
      id: requiredMemoryString(scope.id, `scopes[${index}].id`),
    };
  });
}

function assertNoCallerSuppliedSourceOrRefs(rawMemory: Record<string, unknown>): void {
  const forbiddenKeys = [
    'source',
    'provenance',
    'sourceRefs',
    'source_refs',
    'sourceIds',
    'source_ids',
    'changedRefs',
    'changed_refs',
    'gatewayCallId',
    'gateway_call_id',
    'agentId',
    'agent_id',
    'modelRunId',
    'model_run_id',
    'envelopeHash',
    'envelope_hash',
    'timelineEvent',
    'timeline_event',
    'entityObservationIds',
    'entity_observation_ids',
  ];
  if (forbiddenKeys.some((key) => Object.prototype.hasOwnProperty.call(rawMemory, key))) {
    rejectManualMemoryInput();
  }
}

function normalizeManualMemory(memory: ManualMemorySaveInput): ManualMemorySaveInput {
  if (typeof memory !== 'object' || memory === null || Array.isArray(memory)) {
    throw requestError('event_memories[].memories[] must be a non-null object');
  }
  const rawMemory = memory as unknown as Record<string, unknown>;
  assertNoCallerSuppliedSourceOrRefs(rawMemory);
  const normalized: ManualMemorySaveInput = {
    topic: requiredMemoryString(rawMemory.topic, 'topic'),
    kind: normalizeKind(rawMemory.kind),
    summary: requiredMemoryString(rawMemory.summary, 'summary'),
    details: requiredMemoryString(rawMemory.details, 'details'),
    scopes: normalizeScopes(rawMemory.scopes),
  };
  const confidence = normalizeConfidence(rawMemory.confidence);
  if (confidence !== undefined) {
    normalized.confidence = confidence;
  }
  const status = normalizeStatus(rawMemory.status);
  if (status !== undefined) {
    normalized.status = status;
  }
  const eventDate = normalizeEventDate(rawMemory.eventDate);
  if (eventDate !== undefined) {
    normalized.eventDate = eventDate;
  }
  const eventDateTime = normalizeEventDateTime(rawMemory.eventDateTime);
  if (eventDateTime !== undefined) {
    normalized.eventDateTime = eventDateTime;
  }
  return normalized;
}

function normalizeEventMemories(
  eventMemories: readonly ConnectorIngressManualMemoryEventMemories[]
): {
  eventIndexIds: string[];
  memoriesByEventIndexId: Map<string, readonly ManualMemorySaveInput[]>;
} {
  if (!Array.isArray(eventMemories) || eventMemories.length === 0) {
    throw requestError('event_memories must not be empty');
  }
  if (eventMemories.length > MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS) {
    throw requestError(
      `event_memories must contain at most ${MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS} items`
    );
  }
  const eventIndexIds: string[] = [];
  const memoriesByEventIndexId = new Map<string, readonly ManualMemorySaveInput[]>();
  let totalMemories = 0;
  for (const eventMemory of eventMemories) {
    const eventIndexId = requiredString(
      eventMemory.eventIndexId,
      'event_memories[].event_index_id'
    );
    if (memoriesByEventIndexId.has(eventIndexId)) {
      throw requestError('event_memories must not contain duplicate event_index_id values');
    }
    if (!Array.isArray(eventMemory.memories) || eventMemory.memories.length === 0) {
      throw requestError('event_memories[].memories must not be empty');
    }
    totalMemories += eventMemory.memories.length;
    if (totalMemories > MAX_MANUAL_MEMORY_COMMIT_TOTAL_MEMORIES) {
      throw requestError(
        `event_memories must contain at most ${MAX_MANUAL_MEMORY_COMMIT_TOTAL_MEMORIES} total memories`
      );
    }
    eventIndexIds.push(eventIndexId);
    memoriesByEventIndexId.set(
      eventIndexId,
      eventMemory.memories.map((memory: ManualMemorySaveInput) => normalizeManualMemory(memory))
    );
  }
  return { eventIndexIds, memoriesByEventIndexId };
}

function memoriesForEvent(
  memoriesByEventIndexId: Map<string, readonly ManualMemorySaveInput[]>,
  event: PrimaryOperatorEvent
): readonly ManualMemorySaveInput[] {
  const memories = memoriesByEventIndexId.get(event.sourceRef.id);
  if (!memories || memories.length === 0) {
    throw requestError('Reviewed event is missing manual memories');
  }
  return memories;
}

function parseStringArrayJson(value: string, field: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be a string array`);
  }
  return parsed;
}

function parseMemoryIdsJson(value: string, expectedMemoryCount: number): Array<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('memory_ids_json must be valid JSON');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expectedMemoryCount ||
    !parsed.every((item) => item === null || (typeof item === 'string' && item.length > 0))
  ) {
    throw new Error('memory_ids_json does not match the expected memory count');
  }
  return parsed as Array<string | null>;
}

function assertResolvedMemoryIds(memoryIds: readonly (string | null)[]): string[] {
  if (memoryIds.some((id) => id === null)) {
    throw requestError('Manual memory commit replay has unresolved memory ids');
  }
  return memoryIds.map((id) => id!);
}

function isSavedMemoryCommitStatus(status: MemoryCommitIntentStatus): boolean {
  return status === 'saved' || status === 'promoted';
}

function sourceRefsJson(sourceRefs: readonly SourceRef[]): string {
  return JSON.stringify(sourceRefs.map((ref) => serializeSourceRef(ref)));
}

function canonicalMemoryPayload(memory: ManualMemorySaveInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    topic: memory.topic,
    kind: memory.kind,
    summary: memory.summary,
    details: memory.details,
    scopes: memory.scopes.map((scope) => ({ kind: scope.kind, id: scope.id })),
  };
  if (memory.confidence !== undefined) {
    payload.confidence = memory.confidence;
  }
  if (memory.status !== undefined) {
    payload.status = memory.status;
  }
  if (memory.eventDate !== undefined) {
    payload.eventDate = memory.eventDate;
  }
  if (memory.eventDateTime !== undefined) {
    payload.eventDateTime = memory.eventDateTime;
  }
  return payload;
}

function memoryPayloadHash(memories: readonly ManualMemorySaveInput[]): string {
  const payloadJson = JSON.stringify(memories.map((memory) => canonicalMemoryPayload(memory)));
  return `sha256:${crypto.createHash('sha256').update(payloadJson).digest('hex')}`;
}

function assertNoExistingNonMemoryCommits(input: {
  operatorDb: SQLiteDatabase;
  cursorName: string;
  connector: string;
  events: readonly PrimaryOperatorEvent[];
}): void {
  if (input.events.length === 0) {
    return;
  }
  const idempotencyKeys: string[] = [];
  for (const event of input.events) {
    idempotencyKeys.push(
      buildCursorScopedIdempotencyKey(input.cursorName, event.seq, event.seq),
      buildConnectorIdempotencyKey(input.connector, event.seq, event.seq)
    );
  }
  const placeholders = idempotencyKeys.map(() => '?').join(', ');
  const rows = input.operatorDb
    .prepare(
      `SELECT idempotency_key, status, changed_refs_json
       FROM vnext_operator_commits
       WHERE cursor_name = ?
         AND idempotency_key IN (${placeholders})`
    )
    .all(input.cursorName, ...idempotencyKeys) as ExistingOperatorCommitRow[];
  for (const row of rows) {
    if (row.status !== 'changed') {
      throw requestError('Manual memory commit cannot replace a non-changed operator commit');
    }
    const changedRefs = parseStringArrayJson(row.changed_refs_json, 'changed_refs_json');
    if (changedRefs.length === 0 || changedRefs.some((ref) => !ref.startsWith('memory:'))) {
      throw requestError(
        'Manual memory commit cannot replace a non-memory changed operator commit'
      );
    }
  }
}

function getMemoryCommitIntent(
  db: SQLiteDatabase,
  idempotencyKey: string
): MemoryCommitIntentRow | undefined {
  return db
    .prepare(
      `SELECT intent_id, cursor_name, idempotency_key, expected_memory_count,
              memory_payload_hash, memory_ids_json, source_refs_json,
              status, claim_token, created_at_ms, updated_at_ms
       FROM operator_memory_commit_intents
       WHERE idempotency_key = ?`
    )
    .get(idempotencyKey) as MemoryCommitIntentRow | undefined;
}

function assertMemoryCommitIntentMatches(input: {
  intent: MemoryCommitIntentRow;
  cursorName: string;
  expectedMemoryCount: number;
  memoryPayloadHash: string;
  sourceRefs: readonly SourceRef[];
}): void {
  if (
    input.intent.cursor_name !== input.cursorName ||
    input.intent.expected_memory_count !== input.expectedMemoryCount ||
    input.intent.memory_payload_hash !== input.memoryPayloadHash ||
    input.intent.source_refs_json !== sourceRefsJson(input.sourceRefs)
  ) {
    throw requestError('Manual memory commit replay memory payload does not match the original');
  }
}

function assertExistingMemoryCommitPayloads(input: {
  operatorDb: SQLiteDatabase;
  cursorName: string;
  connector: string;
  events: readonly PrimaryOperatorEvent[];
  memoriesByEventIndexId: Map<string, readonly ManualMemorySaveInput[]>;
}): void {
  for (const event of input.events) {
    const seq = nonNegativeInteger(event.seq, 'event.seq');
    const idempotencyKeys = [
      buildCursorScopedIdempotencyKey(input.cursorName, seq, seq),
      buildConnectorIdempotencyKey(input.connector, seq, seq),
    ];
    const memories = memoriesForEvent(input.memoriesByEventIndexId, event);
    const payloadHash = memoryPayloadHash(memories);
    const sourceRefs = [event.sourceRef];
    for (const idempotencyKey of idempotencyKeys) {
      const commit = input.operatorDb
        .prepare(
          `SELECT idempotency_key, status, changed_refs_json
           FROM vnext_operator_commits
           WHERE cursor_name = ? AND idempotency_key = ?`
        )
        .get(input.cursorName, idempotencyKey) as ExistingOperatorCommitRow | undefined;
      const intent = getMemoryCommitIntent(input.operatorDb, idempotencyKey);
      if (intent) {
        assertMemoryCommitIntentMatches({
          intent,
          cursorName: input.cursorName,
          expectedMemoryCount: memories.length,
          memoryPayloadHash: payloadHash,
          sourceRefs,
        });
      }
      if (commit) {
        if (!intent || !isSavedMemoryCommitStatus(intent.status)) {
          throw requestError('Manual memory commit replay is missing saved memory intent details');
        }
        const changedRefs = parseStringArrayJson(commit.changed_refs_json, 'changed_refs_json');
        const memoryIds = parseMemoryIdsJson(intent.memory_ids_json, memories.length);
        if (
          commit.status !== 'changed' ||
          changedRefs.length !== memoryIds.length ||
          changedRefs.some((ref, index) => ref !== `memory:${memoryIds[index]}`)
        ) {
          throw requestError('Manual memory commit replay does not match saved memory refs');
        }
      }
    }
  }
}

function readExistingMemoryOperatorCommit(input: {
  operatorDb: SQLiteDatabase;
  cursorName: string;
  idempotencyKeys: readonly string[];
  sourceRefs: readonly SourceRef[];
}): ExistingMemoryOperatorCommitRow | null {
  const expectedSourceRefsJson = sourceRefsJson(input.sourceRefs);
  for (const idempotencyKey of input.idempotencyKeys) {
    const row = input.operatorDb
      .prepare(
        `SELECT
          idempotency_key, status, changed_refs_json, source_refs_json,
          first_change_seq, last_change_seq
         FROM vnext_operator_commits
         WHERE cursor_name = ? AND idempotency_key = ?`
      )
      .get(input.cursorName, idempotencyKey) as ExistingMemoryOperatorCommitRow | undefined;
    if (!row) {
      continue;
    }
    if (row.status !== 'changed') {
      throw requestError('Manual memory commit cannot replace a non-changed operator commit');
    }
    if (row.source_refs_json !== expectedSourceRefsJson) {
      throw requestError('Manual memory commit replay source refs do not match the original');
    }
    return row;
  }
  return null;
}

function upsertMemoryCommitIntent(input: {
  db: SQLiteDatabase;
  cursorName: string;
  idempotencyKey: string;
  expectedMemoryCount: number;
  memoryPayloadHash: string;
  sourceRefs: readonly SourceRef[];
  nowMs: number;
}): Array<string | null> {
  const expectedSourceRefsJson = sourceRefsJson(input.sourceRefs);
  const memoryIds = Array.from({ length: input.expectedMemoryCount }, () => null);
  input.db
    .prepare(
      `INSERT OR IGNORE INTO operator_memory_commit_intents (
        intent_id, cursor_name, idempotency_key, expected_memory_count,
        memory_payload_hash, memory_ids_json, source_refs_json, status, claim_token, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `memory-intent:${input.idempotencyKey}`,
      input.cursorName,
      input.idempotencyKey,
      input.expectedMemoryCount,
      input.memoryPayloadHash,
      JSON.stringify(memoryIds),
      expectedSourceRefsJson,
      'pending',
      null,
      input.nowMs,
      input.nowMs
    );
  const intent = getMemoryCommitIntent(input.db, input.idempotencyKey);
  if (!intent) {
    throw new Error('Manual memory commit intent was not initialized');
  }
  if (
    intent.cursor_name !== input.cursorName ||
    intent.expected_memory_count !== input.expectedMemoryCount ||
    intent.memory_payload_hash !== input.memoryPayloadHash ||
    intent.source_refs_json !== expectedSourceRefsJson
  ) {
    throw requestError('Manual memory commit replay memory payload does not match the original');
  }
  return parseMemoryIdsJson(intent.memory_ids_json, input.expectedMemoryCount);
}

function updateMemoryCommitIntent(input: {
  db: SQLiteDatabase;
  idempotencyKey: string;
  claimToken: string;
  memoryIds: readonly (string | null)[];
  status: MemoryCommitIntentStatus;
  nowMs: number;
}): void {
  const result = input.db
    .prepare(
      `UPDATE operator_memory_commit_intents
       SET memory_ids_json = ?, status = ?, claim_token = ?, updated_at_ms = ?
       WHERE idempotency_key = ? AND status = 'saving' AND claim_token = ?`
    )
    .run(
      JSON.stringify(input.memoryIds),
      input.status,
      input.status === 'saving' ? input.claimToken : null,
      input.nowMs,
      input.idempotencyKey,
      input.claimToken
    );
  if (result.changes !== 1) {
    throw new Error('Manual memory commit lost save claim');
  }
}

function refreshMemoryCommitIntentLease(input: {
  db: SQLiteDatabase;
  idempotencyKey: string;
  claimToken: string;
  memoryIds: readonly (string | null)[];
  nowMs: () => number;
}): void {
  updateMemoryCommitIntent({
    db: input.db,
    idempotencyKey: input.idempotencyKey,
    claimToken: input.claimToken,
    memoryIds: input.memoryIds,
    status: 'saving',
    nowMs: input.nowMs(),
  });
}

async function runWithMemoryCommitLeaseHeartbeat<T>(
  input: {
    db: SQLiteDatabase;
    idempotencyKey: string;
    claimToken: string;
    memoryIds: readonly (string | null)[];
    nowMs: () => number;
  },
  work: () => Promise<T>
): Promise<T> {
  let heartbeatError: unknown = null;
  refreshMemoryCommitIntentLease(input);
  const heartbeat = setInterval(() => {
    try {
      refreshMemoryCommitIntentLease(input);
    } catch (error) {
      heartbeatError = error;
      clearInterval(heartbeat);
    }
  }, MEMORY_COMMIT_SAVING_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const result = await work();
    if (heartbeatError) {
      throw heartbeatError;
    }
    refreshMemoryCommitIntentLease(input);
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

function releaseMemoryCommitIntentAfterSaveFailure(input: {
  db: SQLiteDatabase;
  idempotencyKey: string;
  claimToken: string;
  memoryIds: readonly (string | null)[];
  nowMs: number;
}): void {
  input.db
    .prepare(
      `UPDATE operator_memory_commit_intents
       SET memory_ids_json = ?, status = 'pending', claim_token = NULL, updated_at_ms = ?
       WHERE idempotency_key = ? AND status = 'saving' AND claim_token = ?`
    )
    .run(JSON.stringify(input.memoryIds), input.nowMs, input.idempotencyKey, input.claimToken);
}

function markMemoryCommitIntentStatus(input: {
  db: SQLiteDatabase;
  idempotencyKey: string;
  status: MemoryCommitIntentStatus;
  expectedStatus?: MemoryCommitIntentStatus;
  nowMs: number;
}): void {
  const result =
    input.expectedStatus === undefined
      ? input.db
          .prepare(
            `UPDATE operator_memory_commit_intents
             SET status = ?, claim_token = NULL, updated_at_ms = ?
             WHERE idempotency_key = ?`
          )
          .run(input.status, input.nowMs, input.idempotencyKey)
      : input.db
          .prepare(
            `UPDATE operator_memory_commit_intents
             SET status = ?, claim_token = NULL, updated_at_ms = ?
             WHERE idempotency_key = ? AND status = ?`
          )
          .run(input.status, input.nowMs, input.idempotencyKey, input.expectedStatus);
  if (result.changes !== 1 && input.expectedStatus !== undefined) {
    const intent = getMemoryCommitIntent(input.db, input.idempotencyKey);
    if (intent?.status !== input.status) {
      throw new Error('Manual memory commit intent status changed concurrently');
    }
  }
}

function claimMemoryCommitIntentForSaving(input: {
  db: SQLiteDatabase;
  idempotencyKey: string;
  expectedMemoryCount: number;
  nowMs: number;
}): {
  memoryIds: Array<string | null>;
  status: MemoryCommitIntentStatus;
  canSave: boolean;
  claimToken?: string;
} {
  const intent = getMemoryCommitIntent(input.db, input.idempotencyKey);
  if (!intent) {
    throw new Error('Manual memory commit intent was not initialized');
  }
  const memoryIds = parseMemoryIdsJson(intent.memory_ids_json, input.expectedMemoryCount);
  if (isSavedMemoryCommitStatus(intent.status)) {
    return { memoryIds, status: intent.status, canSave: false };
  }
  if (intent.status === 'saving') {
    if (input.nowMs - intent.updated_at_ms < MEMORY_COMMIT_SAVING_LEASE_MS) {
      throw new Error('Manual memory commit is already saving');
    }
    const claimToken = `claim:${crypto.randomUUID()}`;
    const result =
      intent.claim_token === null
        ? input.db
            .prepare(
              `UPDATE operator_memory_commit_intents
               SET claim_token = ?, updated_at_ms = ?
               WHERE idempotency_key = ? AND status = 'saving'
                 AND updated_at_ms = ? AND claim_token IS NULL`
            )
            .run(claimToken, input.nowMs, input.idempotencyKey, intent.updated_at_ms)
        : input.db
            .prepare(
              `UPDATE operator_memory_commit_intents
               SET claim_token = ?, updated_at_ms = ?
               WHERE idempotency_key = ? AND status = 'saving'
                 AND updated_at_ms = ? AND claim_token = ?`
            )
            .run(
              claimToken,
              input.nowMs,
              input.idempotencyKey,
              intent.updated_at_ms,
              intent.claim_token
            );
    if (result.changes !== 1) {
      throw new Error('Manual memory commit is already saving');
    }
    return { memoryIds, status: 'saving', canSave: true, claimToken };
  }
  const expectedStatus = intent.status;
  const claimToken = `claim:${crypto.randomUUID()}`;
  const result = input.db
    .prepare(
      `UPDATE operator_memory_commit_intents
       SET status = 'saving', claim_token = ?, updated_at_ms = ?
       WHERE idempotency_key = ? AND status = ? AND updated_at_ms = ? AND claim_token IS NULL`
    )
    .run(claimToken, input.nowMs, input.idempotencyKey, expectedStatus, intent.updated_at_ms);
  if (result.changes !== 1) {
    throw new Error('Manual memory commit is already saving');
  }
  return { memoryIds, status: 'saving', canSave: true, claimToken };
}

function readSavedMemoryIntentForReplay(input: {
  db: SQLiteDatabase;
  idempotencyKey: string;
  expectedMemoryCount: number;
}): { memoryIds: string[]; status: MemoryCommitIntentStatus } {
  const intent = getMemoryCommitIntent(input.db, input.idempotencyKey);
  if (!intent || !isSavedMemoryCommitStatus(intent.status)) {
    throw requestError('Manual memory commit replay is missing saved memory intent details');
  }
  return {
    memoryIds: assertResolvedMemoryIds(
      parseMemoryIdsJson(intent.memory_ids_json, input.expectedMemoryCount)
    ),
    status: intent.status,
  };
}

function buildMemoryGatewayCallId(idempotencyKey: string, index: number): string {
  return `${idempotencyKey}:memory:${index}`;
}

function buildMemorySaveInput(input: {
  memory: ManualMemorySaveInput;
  channel: string;
}): PublicSaveMemoryInput {
  return {
    ...input.memory,
    status: 'stale',
    source: {
      package: 'standalone',
      source_type: 'manual-connector-ingress-memory',
      channel_id: input.channel,
    },
  };
}

function targetMemoryStatus(memory: ManualMemorySaveInput): MemoryStatus {
  return memory.status ?? 'active';
}

async function setDefaultMemoryStatus(input: {
  memoryId: string;
  status: MemoryStatus;
}): Promise<void> {
  await promoteMemoryStatus(input);
}

async function promoteMemoryStatuses(input: {
  memoryIds: readonly string[];
  memories: readonly ManualMemorySaveInput[];
  setMemoryStatus: ConnectorIngressManualMemoryCommitInput['setMemoryStatus'];
}): Promise<void> {
  if (input.memoryIds.length !== input.memories.length) {
    throw new Error('Manual memory commit memory ids do not match memory payloads');
  }
  for (const [index, memoryId] of input.memoryIds.entries()) {
    await input.setMemoryStatus({
      memoryId,
      status: targetMemoryStatus(input.memories[index]!),
    });
  }
}

function matchingRecoveredMemories(input: {
  records: readonly MemoryProvenanceRecord[];
  sourceRefs: readonly SourceRef[];
}): MemoryProvenanceRecord[] {
  const expectedSourceRefs = sourceRefsJson(input.sourceRefs);
  return input.records.filter(
    (record) => JSON.stringify(record.source_refs) === expectedSourceRefs
  );
}

async function resolveMemoryId(input: {
  memory: ManualMemorySaveInput;
  index: number;
  channel: string;
  sourceRefs: readonly SourceRef[];
  idempotencyKey: string;
  saveMemory: ConnectorIngressManualMemoryCommitInput['saveMemory'];
  createTrustedProvenanceCapability: ConnectorIngressManualMemoryCommitInput['createTrustedProvenanceCapability'];
  listMemoriesByGatewayCallId: ConnectorIngressManualMemoryCommitInput['listMemoriesByGatewayCallId'];
}): Promise<{ memoryId: string; saved: boolean }> {
  const gatewayCallId = buildMemoryGatewayCallId(input.idempotencyKey, input.index);
  const recovered = matchingRecoveredMemories({
    records: await input.listMemoriesByGatewayCallId(gatewayCallId),
    sourceRefs: input.sourceRefs,
  });
  if (recovered.length > 1) {
    throw new Error('Manual memory commit recovered duplicate memories for one gateway call');
  }
  if (recovered.length === 1) {
    return { memoryId: recovered[0].memory_id, saved: false };
  }
  const result = await input.saveMemory(buildMemorySaveInput(input), {
    capability: input.createTrustedProvenanceCapability(),
    projectTruth: false,
    provenance: {
      actor: 'user',
      agent_id: 'operator:manual-admin',
      tool_name: 'mama_save',
      gateway_call_id: gatewayCallId,
      source_refs: input.sourceRefs.map((ref) => serializeSourceRef(ref)),
    },
  });
  if (result.success !== true || typeof result.id !== 'string' || result.id.length === 0) {
    throw new Error('Manual memory commit save failed');
  }
  return { memoryId: result.id, saved: true };
}

async function commitMemoriesForEvent(input: {
  operatorDb: SQLiteDatabase;
  cursorName: string;
  channel: string;
  idempotencyKey: string;
  sourceRefs: readonly SourceRef[];
  memories: readonly ManualMemorySaveInput[];
  memoryPayloadHash: string;
  saveMemory: ConnectorIngressManualMemoryCommitInput['saveMemory'];
  createTrustedProvenanceCapability: ConnectorIngressManualMemoryCommitInput['createTrustedProvenanceCapability'];
  listMemoriesByGatewayCallId: ConnectorIngressManualMemoryCommitInput['listMemoriesByGatewayCallId'];
  nowMs: () => number;
}): Promise<{
  changedRefs: SourceRef[];
  memoryIds: string[];
  saved: number;
  intentStatus: MemoryCommitIntentStatus;
}> {
  upsertMemoryCommitIntent({
    db: input.operatorDb,
    cursorName: input.cursorName,
    idempotencyKey: input.idempotencyKey,
    expectedMemoryCount: input.memories.length,
    memoryPayloadHash: input.memoryPayloadHash,
    sourceRefs: input.sourceRefs,
    nowMs: input.nowMs(),
  });
  const claim = claimMemoryCommitIntentForSaving({
    db: input.operatorDb,
    idempotencyKey: input.idempotencyKey,
    expectedMemoryCount: input.memories.length,
    nowMs: input.nowMs(),
  });
  const memoryIds = claim.memoryIds;
  let saved = 0;
  if (!claim.canSave) {
    const resolvedMemoryIds = assertResolvedMemoryIds(memoryIds);
    return {
      changedRefs: resolvedMemoryIds.map((id) => ({ kind: 'memory', id }) satisfies SourceRef),
      memoryIds: resolvedMemoryIds,
      saved,
      intentStatus: claim.status,
    };
  }
  if (!claim.claimToken) {
    throw new Error('Manual memory commit save claim missing token');
  }

  try {
    for (const [index, memory] of input.memories.entries()) {
      if (memoryIds[index]) {
        continue;
      }
      const resolved = await runWithMemoryCommitLeaseHeartbeat(
        {
          db: input.operatorDb,
          idempotencyKey: input.idempotencyKey,
          claimToken: claim.claimToken,
          memoryIds,
          nowMs: input.nowMs,
        },
        () =>
          resolveMemoryId({
            memory,
            index,
            channel: input.channel,
            sourceRefs: input.sourceRefs,
            idempotencyKey: input.idempotencyKey,
            saveMemory: input.saveMemory,
            createTrustedProvenanceCapability: input.createTrustedProvenanceCapability,
            listMemoriesByGatewayCallId: input.listMemoriesByGatewayCallId,
          })
      );
      memoryIds[index] = resolved.memoryId;
      if (resolved.saved) {
        saved += 1;
      }
      updateMemoryCommitIntent({
        db: input.operatorDb,
        idempotencyKey: input.idempotencyKey,
        claimToken: claim.claimToken,
        memoryIds,
        status: 'saving',
        nowMs: input.nowMs(),
      });
    }
  } catch (error) {
    releaseMemoryCommitIntentAfterSaveFailure({
      db: input.operatorDb,
      idempotencyKey: input.idempotencyKey,
      claimToken: claim.claimToken,
      memoryIds,
      nowMs: input.nowMs(),
    });
    throw error;
  }
  if (memoryIds.some((id) => id === null)) {
    throw new Error('Manual memory commit did not resolve every memory id');
  }
  updateMemoryCommitIntent({
    db: input.operatorDb,
    idempotencyKey: input.idempotencyKey,
    claimToken: claim.claimToken,
    memoryIds,
    status: 'saved',
    nowMs: input.nowMs(),
  });
  const resolvedMemoryIds = memoryIds.map((id) => id!);
  return {
    changedRefs: resolvedMemoryIds.map((id) => ({ kind: 'memory', id }) satisfies SourceRef),
    memoryIds: resolvedMemoryIds,
    saved,
    intentStatus: 'saved',
  };
}

function batchResult(input: {
  ok: boolean;
  status: PrimaryOperatorBatchResult['status'];
  cursorName: string;
  connector: string;
  channel: string;
  requestedCount: number;
  processed: number;
  advancedThroughSeq: number;
  firstSeq: number | null;
  lastSeq: number | null;
  memoriesSaved: number;
  promotionPending?: boolean;
  commits: ConnectorIngressManualMemoryCommitResult['commits'];
  failedSeq?: number;
  error?: string;
}): ConnectorIngressManualMemoryCommitResult {
  return {
    ok: input.ok,
    mode: 'manual_memory_commit',
    status: input.status,
    cursorName: input.cursorName,
    connector: input.connector,
    channel: input.channel,
    requestedCount: input.requestedCount,
    processed: input.processed,
    advancedThroughSeq: input.advancedThroughSeq,
    firstSeq: input.firstSeq,
    lastSeq: input.lastSeq,
    memoriesSaved: input.memoriesSaved,
    ...(input.promotionPending === true ? { promotionPending: true } : {}),
    commits: input.commits,
    ...(input.failedSeq !== undefined ? { failedSeq: input.failedSeq } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

async function tryPromoteSavedMemories(input: {
  operatorDb: SQLiteDatabase;
  idempotencyKey: string;
  memoryIds: readonly string[];
  memories: readonly ManualMemorySaveInput[];
  setMemoryStatus: ConnectorIngressManualMemoryCommitInput['setMemoryStatus'];
  nowMs: number;
}): Promise<boolean> {
  try {
    await promoteMemoryStatuses({
      memoryIds: input.memoryIds,
      memories: input.memories,
      setMemoryStatus: input.setMemoryStatus,
    });
    markMemoryCommitIntentStatus({
      db: input.operatorDb,
      idempotencyKey: input.idempotencyKey,
      status: 'promoted',
      expectedStatus: 'saved',
      nowMs: input.nowMs,
    });
    return true;
  } catch {
    return false;
  }
}

export async function commitConnectorIngressMemoryBatch(
  input: ConnectorIngressManualMemoryCommitInput
): Promise<ConnectorIngressManualMemoryCommitResult> {
  const connector = requiredString(input.connector, 'connector');
  const channel = requiredString(input.channel, 'channel');
  const cursorName = buildConnectorOperatorCursorName({ connector, channel });
  const { eventIndexIds, memoriesByEventIndexId } = normalizeEventMemories(input.eventMemories);

  return runWithPrimaryOperatorCursorLock(cursorName, async () => {
    const events = readReviewedEvents({
      rawAdapter: input.rawAdapter,
      connector,
      channel,
      eventIndexIds,
    });
    assertReviewedConnectorIngressSeqs(
      {
        rawAdapter: input.rawAdapter,
        connector,
        channel,
      },
      events,
      input.expectedAdvancedThroughSeq,
      readConnectorOperatorCursorSeq(input.operatorDb, cursorName),
      requestError
    );
    assertNoExistingNonMemoryCommits({
      operatorDb: input.operatorDb,
      cursorName,
      connector,
      events,
    });
    assertExistingMemoryCommitPayloads({
      operatorDb: input.operatorDb,
      cursorName,
      connector,
      events,
      memoriesByEventIndexId,
    });

    const firstSeq = events[0]?.seq ?? null;
    const lastSeq = events[events.length - 1]?.seq ?? null;
    const commits: ConnectorIngressManualMemoryCommitResult['commits'] = [];
    const preparedCommits: PreparedMemoryCursorCommit[] = [];
    let advancedThroughSeq = readConnectorOperatorCursorSeq(input.operatorDb, cursorName);
    let memoriesSaved = 0;

    for (const event of events) {
      const seq = nonNegativeInteger(event.seq, 'event.seq');
      const idempotencyKey = buildCursorScopedIdempotencyKey(cursorName, seq, seq);
      const legacyIdempotencyKey = buildConnectorIdempotencyKey(connector, seq, seq);
      const fallbackIdempotencyKeys =
        legacyIdempotencyKey === idempotencyKey ? [] : [legacyIdempotencyKey];
      const sourceRefs = [event.sourceRef];
      const memories = memoriesForEvent(memoriesByEventIndexId, event);
      const payloadHash = memoryPayloadHash(memories);
      try {
        const existingCommit = readExistingMemoryOperatorCommit({
          operatorDb: input.operatorDb,
          cursorName,
          idempotencyKeys: [idempotencyKey, ...fallbackIdempotencyKeys],
          sourceRefs,
        });
        if (existingCommit) {
          const savedIntent = readSavedMemoryIntentForReplay({
            db: input.operatorDb,
            idempotencyKey: existingCommit.idempotency_key,
            expectedMemoryCount: memories.length,
          });
          preparedCommits.push({
            seq,
            idempotencyKey: existingCommit.idempotency_key,
            sourceRefs,
            memories,
            changedRefs: savedIntent.memoryIds.map(
              (id) => ({ kind: 'memory', id }) satisfies SourceRef
            ),
            memoryIds: savedIntent.memoryIds,
            intentStatus: savedIntent.status,
          });
          continue;
        }
        if (seq <= advancedThroughSeq) {
          throw new Error(
            `Operator events must advance cursor; current seq ${advancedThroughSeq}, got ${seq}`
          );
        }
        const memoryCommit = await commitMemoriesForEvent({
          operatorDb: input.operatorDb,
          cursorName,
          channel,
          idempotencyKey,
          sourceRefs,
          memories,
          memoryPayloadHash: payloadHash,
          saveMemory: input.saveMemory,
          createTrustedProvenanceCapability: input.createTrustedProvenanceCapability,
          listMemoriesByGatewayCallId: input.listMemoriesByGatewayCallId,
          nowMs: () => input.nowMs?.() ?? Date.now(),
        });
        memoriesSaved += memoryCommit.saved;
        preparedCommits.push({
          seq,
          idempotencyKey,
          sourceRefs,
          memories,
          changedRefs: memoryCommit.changedRefs,
          memoryIds: memoryCommit.memoryIds,
          intentStatus: memoryCommit.intentStatus,
        });
      } catch {
        return batchResult({
          ok: false,
          status: 'partial_failure',
          cursorName,
          connector,
          channel,
          requestedCount: input.eventMemories.length,
          processed: 0,
          advancedThroughSeq,
          firstSeq,
          lastSeq,
          memoriesSaved,
          commits: [],
          failedSeq: seq,
          error: PARTIAL_FAILURE_MESSAGE,
        });
      }
    }

    let commitFailureSeq = preparedCommits[0]?.seq ?? firstSeq ?? 0;
    try {
      const commitPreparedBatch = input.operatorDb.transaction(() => {
        const committed: ConnectorIngressManualMemoryCommitResult['commits'] = [];
        let transactionAdvancedThroughSeq = advancedThroughSeq;
        for (const prepared of preparedCommits) {
          commitFailureSeq = prepared.seq;
          const commitNowMs = input.nowMs?.() ?? Date.now();
          const commit = commitOperatorCursor(input.operatorDb, {
            cursorName,
            firstChangeSeq: prepared.seq,
            lastChangeSeq: prepared.seq,
            idempotencyKey: prepared.idempotencyKey,
            status: 'changed',
            changedRefs: prepared.changedRefs,
            sourceRefs: prepared.sourceRefs,
            nowMs: commitNowMs,
            allowSeqGaps: true,
          });
          committed.push({
            seq: commit.lastChangeSeq,
            status: 'changed',
            outcome: commit.outcome,
            cursorAdvanced: commit.cursorAdvanced,
          });
          transactionAdvancedThroughSeq = Math.max(
            transactionAdvancedThroughSeq,
            commit.lastChangeSeq
          );
        }
        return {
          commits: committed,
          advancedThroughSeq: transactionAdvancedThroughSeq,
        };
      });
      const committed = commitPreparedBatch();
      commits.push(...committed.commits);
      advancedThroughSeq = committed.advancedThroughSeq;
    } catch {
      return batchResult({
        ok: false,
        status: 'partial_failure',
        cursorName,
        connector,
        channel,
        requestedCount: input.eventMemories.length,
        processed: 0,
        advancedThroughSeq,
        firstSeq,
        lastSeq,
        memoriesSaved,
        commits: [],
        failedSeq: commitFailureSeq,
        error: PARTIAL_FAILURE_MESSAGE,
      });
    }

    for (const prepared of preparedCommits) {
      if (prepared.intentStatus === 'promoted') {
        continue;
      }
      const promoted = await tryPromoteSavedMemories({
        operatorDb: input.operatorDb,
        idempotencyKey: prepared.idempotencyKey,
        memoryIds: prepared.memoryIds,
        memories: prepared.memories,
        setMemoryStatus: input.setMemoryStatus,
        nowMs: input.nowMs?.() ?? Date.now(),
      });
      if (!promoted) {
        return batchResult({
          ok: true,
          status: 'committed',
          cursorName,
          connector,
          channel,
          requestedCount: input.eventMemories.length,
          processed: commits.length,
          advancedThroughSeq,
          firstSeq,
          lastSeq,
          memoriesSaved,
          promotionPending: true,
          commits,
        });
      }
    }

    return batchResult({
      ok: true,
      status: 'committed',
      cursorName,
      connector,
      channel,
      requestedCount: input.eventMemories.length,
      processed: commits.length,
      advancedThroughSeq,
      firstSeq,
      lastSeq,
      memoriesSaved,
      commits,
    });
  });
}

export function createConnectorIngressManualMemoryCommitProvider(
  options: Omit<
    ConnectorIngressManualMemoryCommitInput,
    'expectedAdvancedThroughSeq' | 'eventMemories'
  >
): ConnectorIngressManualMemoryCommitProvider {
  const connector = requiredString(options.connector, 'connector');
  const channel = requiredString(options.channel, 'channel');
  return async (input) => {
    const requestedConnector = requiredString(input.connector, 'connector');
    const requestedChannel = requiredString(input.channel, 'channel');
    if (requestedConnector !== connector || requestedChannel !== channel) {
      throw requestError(
        'Connector ingress manual memory commit is locked to the configured connector/channel'
      );
    }
    return commitConnectorIngressMemoryBatch({
      rawAdapter: options.rawAdapter,
      operatorDb: options.operatorDb,
      connector,
      channel,
      expectedAdvancedThroughSeq: input.expectedAdvancedThroughSeq,
      eventMemories: input.eventMemories,
      saveMemory: options.saveMemory,
      createTrustedProvenanceCapability: options.createTrustedProvenanceCapability,
      listMemoriesByGatewayCallId: options.listMemoriesByGatewayCallId,
      setMemoryStatus: options.setMemoryStatus,
      nowMs: options.nowMs,
    });
  };
}

export function createDefaultConnectorIngressManualMemoryCommitProvider(
  options: Omit<
    ConnectorIngressManualMemoryCommitInput,
    | 'expectedAdvancedThroughSeq'
    | 'eventMemories'
    | 'saveMemory'
    | 'createTrustedProvenanceCapability'
    | 'listMemoriesByGatewayCallId'
    | 'setMemoryStatus'
  >
): ConnectorIngressManualMemoryCommitProvider {
  return createConnectorIngressManualMemoryCommitProvider({
    ...options,
    saveMemory: saveMemoryWithTrustedProvenance,
    createTrustedProvenanceCapability,
    listMemoriesByGatewayCallId,
    setMemoryStatus: setDefaultMemoryStatus,
  });
}
