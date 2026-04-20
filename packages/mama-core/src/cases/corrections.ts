import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { runImmediateTransaction, type ImmediateTransactionAdapter } from './sqlite-transaction.js';
import { canonicalTargetRef, type CaseTargetRef } from './target-ref.js';
import type { CaseCorrectionRequiresReconfirmResult } from './types.js';

export type CaseCorrectionErrorCode =
  | 'case.precompile_gap'
  | 'case.correction_requires_reconfirm'
  | 'case.correction_active_conflict'
  | 'case.correction_not_found'
  | 'case.correction_reverted'
  | 'case.correction_inactive'
  | 'case.correction_already_superseded'
  | 'case.supersede_target_mismatch'
  | 'case.reconfirm_token_invalid'
  | 'case.reconfirm_token_replayed'
  | 'case.terminal_status'
  | 'case.lock_held';

export interface ApplyCorrectionInput {
  case_id: string;
  target_kind: 'case_field' | 'membership' | 'wiki_section';
  target_ref: CaseTargetRef;
  field_name?: 'status' | 'status_reason' | 'primary_actors' | 'blockers' | 'confidence';
  old_value_json?: string | null;
  reconfirm_token?: string | null;
  session_id?: string | null;
  new_value_json: string;
  reason: string;
  confirmed: true;
  confirmed_by: string;
  confirmation_summary: string;
  now?: string;
}

export type CorrectionApplyResult =
  | {
      kind: 'applied';
      correction_id: string;
      case_id: string;
      target_ref_json: string;
      canonical_hash_hex: string;
    }
  | CaseCorrectionRequiresReconfirmResult
  | { kind: 'precompile_gap'; code: 'case.precompile_gap'; case_id: string }
  | { kind: 'rejected'; code: CaseCorrectionErrorCode; message: string; case_id: string };

export interface RevertCorrectionInput {
  correction_id: string;
  confirmed: true;
  confirmed_by: string;
  confirmation_summary: string;
  now?: string;
}

export type CorrectionRevertResult =
  | { kind: 'reverted'; correction_id: string; case_id: string }
  | { kind: 'precompile_gap'; code: 'case.precompile_gap'; case_id: string }
  | { kind: 'rejected'; code: CaseCorrectionErrorCode; message: string; correction_id?: string };

export interface SupersedeCorrectionInput {
  old_correction_id: string;
  new_value_json: string;
  reason: string;
  confirmed: true;
  confirmed_by: string;
  confirmation_summary: string;
  /**
   * The current value the user saw in the drawer when they chose to
   * supersede. When provided and it disagrees with the live value, the
   * helper returns `case.correction_requires_reconfirm`. Omit to skip
   * CAS — in that case the caller trusts the active correction as the
   * sole source of truth.
   */
  expected_current_value_json?: string | null;
  reconfirm_token?: string | null;
  session_id?: string | null;
  now?: string;
}

export type CorrectionSupersedeResult =
  | {
      kind: 'superseded';
      old_correction_id: string;
      new_correction_id: string;
      case_id: string;
      target_ref_json: string;
      canonical_hash_hex: string;
    }
  | CaseCorrectionRequiresReconfirmResult
  | { kind: 'precompile_gap'; code: 'case.precompile_gap'; case_id: string }
  | {
      kind: 'rejected';
      code: CaseCorrectionErrorCode;
      message: string;
      correction_id?: string;
      case_id?: string;
    };

export interface ReconfirmTokenPayload {
  v: 1;
  kid: string;
  nonce: string;
  case_id: string;
  target_kind: ApplyCorrectionInput['target_kind'];
  target_ref_hash_hex: string;
  current_value_hash_hex: string;
  proposed_value_hash_hex: string;
  confirmed_by: string;
  session_id: string | null;
  expires_at: string;
}

export interface ReconfirmTokenEnvelope {
  kid: string;
  payload: ReconfirmTokenPayload;
  signature_hex: string;
}

export interface InsertCaseCorrectionLockInput {
  correction_id?: string;
  case_id: string;
  target_kind: ApplyCorrectionInput['target_kind'];
  target_ref: CaseTargetRef;
  field_name?: ApplyCorrectionInput['field_name'] | null;
  old_value_json: string | null;
  new_value_json: string;
  reason: string;
  applied_by: string;
  applied_at: string;
  is_lock_active?: 0 | 1;
  superseded_by?: string | null;
}

export interface InsertCaseCorrectionLockResult {
  correction_id: string;
  case_id: string;
  target_kind: ApplyCorrectionInput['target_kind'];
  target_ref_json: string;
  target_ref_hash: Uint8Array;
  canonical_hash_hex: string;
  applied_at: string;
  is_lock_active: 0 | 1;
}

type CorrectionAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'> &
  Partial<Pick<ImmediateTransactionAdapter, 'exec'>>;

type CorrectionFieldName = NonNullable<ApplyCorrectionInput['field_name']>;

interface CaseGateRow {
  case_id: string;
  status: string;
  canonical_case_id: string | null;
}

interface CaseTruthValueRow {
  status: string;
  status_reason: string | null;
  primary_actors: string | null;
  blockers: string | null;
  confidence: string | null;
}

interface MembershipValueRow {
  status: string;
  role: string | null;
  confidence: number | null;
  reason: string | null;
  user_locked: number;
  added_by?: string;
}

interface CorrectionStatusRow {
  correction_id: string;
  case_id: string;
  target_kind: ApplyCorrectionInput['target_kind'];
  target_ref_json: string;
  field_name: ApplyCorrectionInput['field_name'] | null;
  old_value_json: string | null;
  is_lock_active: number;
  reverted_at: string | null;
  superseded_by?: string | null;
}

interface CurrentSecret {
  kid: string;
  secret: Buffer;
}

const RECONFIRM_TOKEN_TTL_MS = 10 * 60_000;
const TERMINAL_CASE_STATUSES = new Set(['merged', 'archived', 'split']);
const CORRECTION_FIELD_NAMES = new Set<string>([
  'status',
  'status_reason',
  'primary_actors',
  'blockers',
  'confidence',
]);

function normalizeNow(value?: string): string {
  return value ?? new Date().toISOString();
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmacHex(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

function deterministicCorrectionId(nonce: string): string {
  return `corr_${sha256Hex(`case-reconfirm:v1:${nonce}`).slice(0, 32)}`;
}

function randomCorrectionId(): string {
  return `corr_${randomUUID().replace(/-/g, '')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonValue(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function canonicalJsonOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return canonicalizeJSON(parseJsonValue(value));
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error('Membership confidence must be a finite number.');
  }
  return n;
}

function canonicalStoredJson(value: string | null): string {
  if (value === null || value.trim().length === 0) {
    return canonicalizeJSON(null);
  }
  return canonicalizeJSON(parseJsonValue(value));
}

function decodeSecret(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    const hex = Buffer.from(trimmed, 'hex');
    if (hex.length >= 32) {
      return hex;
    }
  }

  const base64 = Buffer.from(trimmed, 'base64');
  if (base64.length >= 32) {
    return base64;
  }

  const utf8 = Buffer.from(trimmed, 'utf8');
  if (utf8.length >= 32) {
    return utf8;
  }

  return null;
}

function secretKid(secret: Buffer): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function currentSecret(): CurrentSecret {
  const raw = process.env.MAMA_RECONFIRM_TOKEN_SECRET;
  const secret = raw ? decodeSecret(raw) : null;
  if (!secret) {
    throw new Error('MAMA_RECONFIRM_TOKEN_SECRET must be a 32+ byte base64 or hex secret.');
  }

  return {
    kid: secretKid(secret),
    secret,
  };
}

function verificationSecrets(): Map<string, Buffer> {
  const secrets = new Map<string, Buffer>();
  const current = currentSecret();
  secrets.set(current.kid, current.secret);

  for (const raw of (process.env.MAMA_RECONFIRM_TOKEN_OLD_SECRETS ?? '').split(',')) {
    const secret = decodeSecret(raw);
    if (secret) {
      secrets.set(secretKid(secret), secret);
    }
  }

  return secrets;
}

function encodeReconfirmToken(payload: ReconfirmTokenPayload, secret: Buffer): string {
  const payloadJson = canonicalizeJSON(payload);
  const signatureHex = hmacHex(secret, payloadJson);
  const envelope: ReconfirmTokenEnvelope = {
    kid: payload.kid,
    payload,
    signature_hex: signatureHex,
  };

  return Buffer.from(canonicalizeJSON(envelope), 'utf8').toString('base64url');
}

function readReconfirmEnvelope(token: string): ReconfirmTokenEnvelope | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.payload)) {
      return null;
    }

    const payload = parsed.payload;
    if (
      parsed.kid !== payload.kid ||
      payload.v !== 1 ||
      typeof parsed.kid !== 'string' ||
      typeof parsed.signature_hex !== 'string' ||
      typeof payload.kid !== 'string' ||
      typeof payload.nonce !== 'string' ||
      typeof payload.case_id !== 'string' ||
      typeof payload.target_kind !== 'string' ||
      typeof payload.target_ref_hash_hex !== 'string' ||
      typeof payload.current_value_hash_hex !== 'string' ||
      typeof payload.proposed_value_hash_hex !== 'string' ||
      typeof payload.confirmed_by !== 'string' ||
      !(payload.session_id === null || typeof payload.session_id === 'string') ||
      typeof payload.expires_at !== 'string'
    ) {
      return null;
    }

    if (
      payload.target_kind !== 'case_field' &&
      payload.target_kind !== 'membership' &&
      payload.target_kind !== 'wiki_section'
    ) {
      return null;
    }

    return {
      kid: parsed.kid,
      payload: payload as unknown as ReconfirmTokenPayload,
      signature_hex: parsed.signature_hex,
    };
  } catch {
    return null;
  }
}

function verifyReconfirmToken(input: {
  token: string;
  case_id: string;
  target_kind: ApplyCorrectionInput['target_kind'];
  target_ref_hash_hex: string;
  proposed_value_hash_hex: string;
  confirmed_by: string;
  session_id: string | null;
  now: string;
}): ReconfirmTokenPayload | null {
  const envelope = readReconfirmEnvelope(input.token);
  if (!envelope) {
    return null;
  }

  const secret = verificationSecrets().get(envelope.kid);
  if (!secret) {
    return null;
  }

  const expected = Buffer.from(hmacHex(secret, canonicalizeJSON(envelope.payload)), 'hex');
  const actual = Buffer.from(envelope.signature_hex, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  const expiresAtMs = Date.parse(envelope.payload.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= timestampMs(input.now)) {
    return null;
  }

  if (
    envelope.payload.case_id !== input.case_id ||
    envelope.payload.target_kind !== input.target_kind ||
    envelope.payload.target_ref_hash_hex !== input.target_ref_hash_hex ||
    envelope.payload.proposed_value_hash_hex !== input.proposed_value_hash_hex ||
    envelope.payload.confirmed_by !== input.confirmed_by ||
    envelope.payload.session_id !== input.session_id
  ) {
    return null;
  }

  return envelope.payload;
}

function buildRequiresReconfirm(input: {
  case_id: string;
  target_kind: ApplyCorrectionInput['target_kind'];
  target_ref_json: string;
  target_ref_hash_hex: string;
  current_value_json: string;
  old_value_json: string | null;
  proposed_new_value_json: string;
  confirmed_by: string;
  session_id: string | null;
  now: string;
}): Extract<CorrectionApplyResult, { kind: 'requires_reconfirm' }> {
  const secret = currentSecret();
  const expiresAt = new Date(timestampMs(input.now) + RECONFIRM_TOKEN_TTL_MS).toISOString();
  const payload: ReconfirmTokenPayload = {
    v: 1,
    kid: secret.kid,
    nonce: randomUUID(),
    case_id: input.case_id,
    target_kind: input.target_kind,
    target_ref_hash_hex: input.target_ref_hash_hex,
    current_value_hash_hex: sha256Hex(input.current_value_json),
    proposed_value_hash_hex: sha256Hex(input.proposed_new_value_json),
    confirmed_by: input.confirmed_by,
    session_id: input.session_id,
    expires_at: expiresAt,
  };

  return {
    kind: 'requires_reconfirm',
    code: 'case.correction_requires_reconfirm',
    case_id: input.case_id,
    target_kind: input.target_kind,
    target_ref_json: input.target_ref_json,
    current_value_json: input.current_value_json,
    old_value_json: input.old_value_json,
    proposed_new_value_json: input.proposed_new_value_json,
    reconfirm_token: encodeReconfirmToken(payload, secret.secret),
    reconfirm_token_expires_at: expiresAt,
    message: 'The target changed since the viewed snapshot. Reconfirm against the current value.',
  };
}

function requireMatchingTargetKind(input: ApplyCorrectionInput): void {
  if (input.target_ref.kind !== input.target_kind) {
    throw new Error(
      `Correction target_kind ${input.target_kind} does not match target_ref kind ${input.target_ref.kind}.`
    );
  }
}

function correctionFieldName(input: ApplyCorrectionInput): CorrectionFieldName {
  const fieldFromRef = input.target_ref.kind === 'case_field' ? input.target_ref.field : null;
  const field = input.field_name ?? fieldFromRef;
  if (!field || !CORRECTION_FIELD_NAMES.has(field)) {
    throw new Error(`Unsupported case correction field: ${String(field)}`);
  }

  if (input.field_name && fieldFromRef && input.field_name !== fieldFromRef) {
    throw new Error('field_name must match target_ref.field.');
  }

  return field as CorrectionFieldName;
}

function membershipTarget(
  input: ApplyCorrectionInput
): Extract<CaseTargetRef, { kind: 'membership' }> {
  if (input.target_ref.kind !== 'membership') {
    throw new Error('Membership correction requires membership target_ref.');
  }
  return input.target_ref;
}

function readCaseFieldCurrentValueJson(
  adapter: CorrectionAdapter,
  caseId: string,
  field: CorrectionFieldName
): string {
  const row = adapter
    .prepare(
      `
        SELECT status, status_reason, primary_actors, blockers, confidence
        FROM case_truth
        WHERE case_id = ?
      `
    )
    .get(caseId) as CaseTruthValueRow | undefined;

  if (!row) {
    throw new Error(`case_truth row disappeared while applying correction: ${caseId}`);
  }

  if (field === 'primary_actors' || field === 'blockers') {
    return canonicalStoredJson(row[field]);
  }

  if (field === 'confidence') {
    if (row.confidence === null || row.confidence === undefined) {
      return canonicalizeJSON(null);
    }
    const confidence = Number(row.confidence);
    if (!Number.isFinite(confidence)) {
      throw new Error(`case_truth confidence is not a finite number for case_id=${caseId}`);
    }
    return canonicalizeJSON(confidence);
  }

  return canonicalizeJSON(row[field]);
}

function readMembershipCurrentValueJson(
  adapter: CorrectionAdapter,
  caseId: string,
  sourceType: string,
  sourceId: string
): string {
  const row = adapter
    .prepare(
      `
        SELECT status, role, confidence, reason, user_locked
        FROM case_memberships
        WHERE case_id = ?
          AND source_type = ?
          AND source_id = ?
      `
    )
    .get(caseId, sourceType, sourceId) as MembershipValueRow | undefined;

  if (!row) {
    return canonicalizeJSON(null);
  }

  return canonicalizeJSON({
    status: row.status,
    role: row.role,
    confidence: row.confidence,
    reason: row.reason,
    user_locked: Number(row.user_locked) === 1 ? 1 : 0,
  });
}

function readCurrentValueJson(adapter: CorrectionAdapter, input: ApplyCorrectionInput): string {
  if (input.target_kind === 'case_field') {
    return readCaseFieldCurrentValueJson(adapter, input.case_id, correctionFieldName(input));
  }

  if (input.target_kind === 'membership') {
    const target = membershipTarget(input);
    return readMembershipCurrentValueJson(
      adapter,
      input.case_id,
      target.source_type,
      target.source_id
    );
  }

  return canonicalizeJSON(null);
}

function storageValueForCaseField(field: CorrectionFieldName, newValueJson: string): string | null {
  const value = parseJsonValue(newValueJson);
  if (value === null) {
    return null;
  }

  if (field === 'primary_actors' || field === 'blockers') {
    return canonicalizeJSON(value);
  }

  if (field === 'confidence') {
    const confidence = Number(value);
    if (!Number.isFinite(confidence)) {
      throw new Error('Case field confidence correction value must be a finite number or null.');
    }
    return String(confidence);
  }

  if (typeof value !== 'string') {
    throw new Error(`Case field ${field} correction value must be a JSON string or null.`);
  }

  return value;
}

function applyCaseFieldMutation(input: {
  adapter: CorrectionAdapter;
  case_id: string;
  field: CorrectionFieldName;
  new_value_json: string;
  now: string;
}): void {
  const storageValue = storageValueForCaseField(input.field, input.new_value_json);
  const result = input.adapter
    .prepare(
      `
        UPDATE case_truth
           SET ${input.field} = ?,
               updated_at = ?
         WHERE case_id = ?
           AND status NOT IN ('merged','archived','split')
      `
    )
    .run(storageValue, input.now, input.case_id);

  if (result.changes !== 1) {
    throw new Error(`Failed to apply case field correction for case_id=${input.case_id}.`);
  }

  const actual = readCaseFieldCurrentValueJson(input.adapter, input.case_id, input.field);
  const expected = canonicalizeJSON(parseJsonValue(input.new_value_json));
  if (actual !== expected) {
    throw new Error(`Case field correction verification failed for ${input.field}.`);
  }
}

function membershipStatus(value: unknown): 'active' | 'excluded' | 'removed' {
  if (value === 'active' || value === 'excluded' || value === 'removed') {
    return value;
  }
  throw new Error('Membership correction status must be active, excluded, or removed.');
}

function verifyMembershipMutation(input: {
  adapter: CorrectionAdapter;
  case_id: string;
  source_type: string;
  source_id: string;
  expected: Record<string, unknown>;
}): void {
  const row = input.adapter
    .prepare(
      `
        SELECT status, role, confidence, reason, user_locked, added_by
        FROM case_memberships
        WHERE case_id = ?
          AND source_type = ?
          AND source_id = ?
      `
    )
    .get(input.case_id, input.source_type, input.source_id) as MembershipValueRow | undefined;

  if (!row) {
    throw new Error('Membership correction verification failed: row missing.');
  }

  const expectedStatus = String(input.expected.status);
  if (
    row.status !== expectedStatus ||
    Number(row.user_locked) !== 1 ||
    row.added_by !== 'user-correction'
  ) {
    throw new Error('Membership correction verification failed.');
  }

  if (expectedStatus === 'active') {
    const expectedRole = nullableString(input.expected.role);
    const expectedConfidence = nullableNumber(input.expected.confidence);
    const expectedReason = nullableString(input.expected.reason);

    if (
      row.role !== expectedRole ||
      row.confidence !== expectedConfidence ||
      row.reason !== expectedReason
    ) {
      throw new Error('Active membership correction verification failed.');
    }
  }
}

function applyMembershipMutation(input: {
  adapter: CorrectionAdapter;
  case_id: string;
  target: Extract<CaseTargetRef, { kind: 'membership' }>;
  new_value_json: string;
  reason: string;
  now: string;
}): void {
  const value = parseJsonValue(input.new_value_json);
  if (!isRecord(value)) {
    throw new Error('Membership correction value must be a JSON object.');
  }

  const status = membershipStatus(value.status);
  if (status === 'removed') {
    input.adapter
      .prepare(
        `
          UPDATE case_memberships
             SET status = 'removed',
                 user_locked = 1,
                 added_by = 'user-correction',
                 updated_at = ?
           WHERE case_id = ?
             AND source_type = ?
             AND source_id = ?
        `
      )
      .run(input.now, input.case_id, input.target.source_type, input.target.source_id);
  } else if (status === 'excluded') {
    const confidence = nullableNumber(value.confidence);
    const reason = nullableString(value.reason) ?? input.reason;
    input.adapter
      .prepare(
        `
          INSERT INTO case_memberships (
            case_id, source_type, source_id, role, confidence, reason, status,
            added_by, added_at, user_locked, updated_at
          )
          VALUES (?, ?, ?, NULL, ?, ?, 'excluded', 'user-correction', ?, 1, ?)
          ON CONFLICT(case_id, source_type, source_id) DO UPDATE SET
            role = excluded.role,
            confidence = excluded.confidence,
            reason = excluded.reason,
            status = excluded.status,
            added_by = 'user-correction',
            user_locked = 1,
            updated_at = excluded.updated_at
        `
      )
      .run(
        input.case_id,
        input.target.source_type,
        input.target.source_id,
        confidence,
        reason,
        input.now,
        input.now
      );
  } else {
    const role = nullableString(value.role);
    const confidence = nullableNumber(value.confidence);
    const reason = nullableString(value.reason);
    input.adapter
      .prepare(
        `
          INSERT INTO case_memberships (
            case_id, source_type, source_id, role, confidence, reason, status,
            added_by, added_at, user_locked, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 'active', 'user-correction', ?, 1, ?)
          ON CONFLICT(case_id, source_type, source_id) DO UPDATE SET
            role = excluded.role,
            confidence = excluded.confidence,
            reason = excluded.reason,
            status = excluded.status,
            added_by = 'user-correction',
            user_locked = 1,
            updated_at = excluded.updated_at
        `
      )
      .run(
        input.case_id,
        input.target.source_type,
        input.target.source_id,
        role,
        confidence,
        reason,
        input.now,
        input.now
      );
  }

  verifyMembershipMutation({
    adapter: input.adapter,
    case_id: input.case_id,
    source_type: input.target.source_type,
    source_id: input.target.source_id,
    expected: value,
  });
}

function applyTargetMutation(input: {
  adapter: CorrectionAdapter;
  correction: ApplyCorrectionInput;
  now: string;
}): void {
  if (input.correction.target_kind === 'case_field') {
    applyCaseFieldMutation({
      adapter: input.adapter,
      case_id: input.correction.case_id,
      field: correctionFieldName(input.correction),
      new_value_json: input.correction.new_value_json,
      now: input.now,
    });
    return;
  }

  if (input.correction.target_kind === 'membership') {
    applyMembershipMutation({
      adapter: input.adapter,
      case_id: input.correction.case_id,
      target: membershipTarget(input.correction),
      new_value_json: input.correction.new_value_json,
      reason: input.correction.reason,
      now: input.now,
    });
  }
}

function revertMembershipValueJson(value: string | null): string {
  const canonicalValue = canonicalJsonOrNull(value);
  if (canonicalValue === null || canonicalValue === canonicalizeJSON(null)) {
    return canonicalizeJSON({ status: 'removed' });
  }
  return canonicalValue;
}

function insertCorrectionMemoryEvent(input: {
  adapter: CorrectionAdapter;
  event_type: 'case.correction_applied' | 'case.correction_reverted' | 'case.correction_superseded';
  correction_id: string;
  case_id: string;
  actor: string;
  source_turn_id?: string | null;
  confirmation_summary: string;
  now: string;
  extra_refs?: string[];
}): void {
  const evidenceRefs = [input.correction_id, ...(input.extra_refs ?? [])];
  input.adapter
    .prepare(
      `
        INSERT INTO memory_events (
          event_id, event_type, actor, source_turn_id, memory_id, topic,
          scope_refs, evidence_refs, reason, created_at
        )
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      `
    )
    .run(
      `evt_${randomUUID().replace(/-/g, '')}`,
      input.event_type,
      input.actor,
      input.source_turn_id ?? null,
      `case:${input.case_id}`,
      canonicalizeJSON([{ type: 'case', id: input.case_id }]),
      canonicalizeJSON(evidenceRefs),
      canonicalizeJSON({
        correction_id: input.correction_id,
        confirmation_summary: input.confirmation_summary,
        ...(input.extra_refs ? { predecessor_correction_ids: input.extra_refs } : {}),
      }),
      timestampMs(input.now)
    );
}

function activeCorrectionForTarget(
  adapter: CorrectionAdapter,
  caseId: string,
  targetRefHash: Buffer
): { correction_id: string } | null {
  const row = adapter
    .prepare(
      `
        SELECT correction_id
        FROM case_corrections
        WHERE case_id = ?
          AND target_ref_hash = ?
          AND is_lock_active = 1
          AND reverted_at IS NULL
        LIMIT 1
      `
    )
    .get(caseId, targetRefHash) as { correction_id: string } | undefined;

  return row ?? null;
}

function correctionExists(adapter: CorrectionAdapter, correctionId: string): boolean {
  const row = adapter
    .prepare('SELECT correction_id FROM case_corrections WHERE correction_id = ?')
    .get(correctionId) as { correction_id: string } | undefined;
  return row !== undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(error.message)
  );
}

export function insertCaseCorrectionLock(
  adapter: DatabaseAdapter,
  input: InsertCaseCorrectionLockInput
): InsertCaseCorrectionLockResult {
  const correctionAdapter = adapter as unknown as CorrectionAdapter;
  const canonical = canonicalTargetRef(input.target_ref);
  const correctionId = input.correction_id ?? randomCorrectionId();
  const isLockActive = input.is_lock_active ?? 1;

  correctionAdapter
    .prepare(
      `
        INSERT INTO case_corrections (
          correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
          field_name, old_value_json, new_value_json, reason,
          applied_by, applied_at, is_lock_active, reverted_at, superseded_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?);
      `
    )
    .run(
      correctionId,
      input.case_id,
      input.target_kind,
      canonical.json,
      canonical.hash,
      input.field_name ?? null,
      input.old_value_json,
      input.new_value_json,
      input.reason,
      input.applied_by,
      input.applied_at,
      isLockActive,
      input.superseded_by ?? null
    );

  return {
    correction_id: correctionId,
    case_id: input.case_id,
    target_kind: input.target_kind,
    target_ref_json: canonical.json,
    target_ref_hash: canonical.hash,
    canonical_hash_hex: canonical.hash.toString('hex'),
    applied_at: input.applied_at,
    is_lock_active: isLockActive,
  };
}

export function applyCorrection(
  adapter: DatabaseAdapter,
  input: ApplyCorrectionInput
): CorrectionApplyResult {
  const correctionAdapter = adapter as unknown as CorrectionAdapter;

  return runImmediateTransaction(correctionAdapter, () => {
    requireMatchingTargetKind(input);
    const now = normalizeNow(input.now);
    const caseRow = correctionAdapter
      .prepare(
        `
          SELECT case_id, status, canonical_case_id
          FROM case_truth
          WHERE case_id = ?;
        `
      )
      .get(input.case_id) as CaseGateRow | undefined;

    if (!caseRow) {
      return { kind: 'precompile_gap', code: 'case.precompile_gap', case_id: input.case_id };
    }

    if (TERMINAL_CASE_STATUSES.has(caseRow.status)) {
      return {
        kind: 'rejected',
        code: 'case.terminal_status',
        message: `Active corrections cannot target terminal case status ${caseRow.status}.`,
        case_id: input.case_id,
      };
    }

    const canonical = canonicalTargetRef(input.target_ref);
    const targetRefHashHex = canonical.hash.toString('hex');
    const currentValueJson = readCurrentValueJson(correctionAdapter, input);
    const expectedOldValueJson = canonicalJsonOrNull(input.old_value_json);
    let correctionId = randomCorrectionId();

    if (expectedOldValueJson !== null && expectedOldValueJson !== currentValueJson) {
      const token = input.reconfirm_token ?? null;
      if (!token) {
        return buildRequiresReconfirm({
          case_id: input.case_id,
          target_kind: input.target_kind,
          target_ref_json: canonical.json,
          target_ref_hash_hex: targetRefHashHex,
          current_value_json: currentValueJson,
          old_value_json: expectedOldValueJson,
          proposed_new_value_json: input.new_value_json,
          confirmed_by: input.confirmed_by,
          session_id: input.session_id ?? null,
          now,
        });
      }

      const payload = verifyReconfirmToken({
        token,
        case_id: input.case_id,
        target_kind: input.target_kind,
        target_ref_hash_hex: targetRefHashHex,
        proposed_value_hash_hex: sha256Hex(input.new_value_json),
        confirmed_by: input.confirmed_by,
        session_id: input.session_id ?? null,
        now,
      });

      if (!payload) {
        return buildRequiresReconfirm({
          case_id: input.case_id,
          target_kind: input.target_kind,
          target_ref_json: canonical.json,
          target_ref_hash_hex: targetRefHashHex,
          current_value_json: currentValueJson,
          old_value_json: expectedOldValueJson,
          proposed_new_value_json: input.new_value_json,
          confirmed_by: input.confirmed_by,
          session_id: input.session_id ?? null,
          now,
        });
      }

      correctionId = deterministicCorrectionId(payload.nonce);
      if (correctionExists(correctionAdapter, correctionId)) {
        return {
          kind: 'rejected',
          code: 'case.reconfirm_token_replayed',
          message: 'Reconfirm token has already been consumed.',
          case_id: input.case_id,
        };
      }

      if (payload.current_value_hash_hex !== sha256Hex(currentValueJson)) {
        return buildRequiresReconfirm({
          case_id: input.case_id,
          target_kind: input.target_kind,
          target_ref_json: canonical.json,
          target_ref_hash_hex: targetRefHashHex,
          current_value_json: currentValueJson,
          old_value_json: expectedOldValueJson,
          proposed_new_value_json: input.new_value_json,
          confirmed_by: input.confirmed_by,
          session_id: input.session_id ?? null,
          now,
        });
      }
    }

    if (activeCorrectionForTarget(correctionAdapter, input.case_id, canonical.hash)) {
      return {
        kind: 'rejected',
        code: 'case.correction_active_conflict',
        message: 'An active correction already locks this target.',
        case_id: input.case_id,
      };
    }

    let inserted: InsertCaseCorrectionLockResult;
    try {
      inserted = insertCaseCorrectionLock(adapter, {
        correction_id: correctionId,
        case_id: input.case_id,
        target_kind: input.target_kind,
        target_ref: input.target_ref,
        field_name: input.target_kind === 'case_field' ? correctionFieldName(input) : null,
        old_value_json: currentValueJson,
        new_value_json: input.new_value_json,
        reason: input.reason,
        applied_by: input.confirmed_by,
        applied_at: now,
        is_lock_active: 1,
        superseded_by: null,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return {
          kind: 'rejected',
          code: 'case.correction_active_conflict',
          message: 'An active correction already locks this target.',
          case_id: input.case_id,
        };
      }
      throw error;
    }

    applyTargetMutation({ adapter: correctionAdapter, correction: input, now });
    insertCorrectionMemoryEvent({
      adapter: correctionAdapter,
      event_type: 'case.correction_applied',
      correction_id: inserted.correction_id,
      case_id: input.case_id,
      actor: input.confirmed_by,
      source_turn_id: input.session_id ?? null,
      confirmation_summary: input.confirmation_summary,
      now,
    });

    return {
      kind: 'applied',
      correction_id: inserted.correction_id,
      case_id: input.case_id,
      target_ref_json: inserted.target_ref_json,
      canonical_hash_hex: inserted.canonical_hash_hex,
    };
  });
}

export function revertCorrection(
  adapter: DatabaseAdapter,
  input: RevertCorrectionInput
): CorrectionRevertResult {
  const correctionAdapter = adapter as unknown as CorrectionAdapter;

  return runImmediateTransaction(correctionAdapter, () => {
    const now = normalizeNow(input.now);
    const row = correctionAdapter
      .prepare(
        `
          SELECT correction_id, case_id, target_kind, target_ref_json, field_name,
                 old_value_json, is_lock_active, reverted_at
                 , superseded_by
          FROM case_corrections
          WHERE correction_id = ?
        `
      )
      .get(input.correction_id) as CorrectionStatusRow | undefined;

    if (!row) {
      return {
        kind: 'rejected',
        code: 'case.correction_not_found',
        message: 'Correction not found.',
        correction_id: input.correction_id,
      };
    }

    if (row.reverted_at !== null) {
      return {
        kind: 'rejected',
        code: 'case.correction_reverted',
        message: 'Correction has already been reverted.',
        correction_id: input.correction_id,
      };
    }
    if (Number(row.is_lock_active) === 0 && row.superseded_by) {
      return {
        kind: 'rejected',
        code: 'case.correction_already_superseded',
        message: 'Correction has already been superseded.',
        correction_id: input.correction_id,
      };
    }
    if (Number(row.is_lock_active) === 0) {
      return {
        kind: 'rejected',
        code: 'case.correction_inactive',
        message: 'Correction is inactive.',
        correction_id: input.correction_id,
      };
    }

    const caseRow = correctionAdapter
      .prepare('SELECT status, canonical_case_id FROM case_truth WHERE case_id = ?')
      .get(row.case_id) as CaseGateRow | undefined;

    if (!caseRow) {
      return {
        kind: 'precompile_gap',
        code: 'case.precompile_gap',
        case_id: row.case_id,
      };
    }
    if (TERMINAL_CASE_STATUSES.has(caseRow.status)) {
      return {
        kind: 'rejected',
        code: 'case.terminal_status',
        message: 'Case is in a terminal status.',
        case_id: row.case_id,
      };
    }

    applyTargetMutation({
      adapter: correctionAdapter,
      correction: {
        case_id: row.case_id,
        target_kind: row.target_kind,
        target_ref: parseJsonValue(row.target_ref_json) as CaseTargetRef,
        field_name: row.field_name ?? undefined,
        old_value_json: null,
        new_value_json:
          row.target_kind === 'membership'
            ? revertMembershipValueJson(row.old_value_json)
            : row.old_value_json ?? canonicalizeJSON(null),
        reason: 'Revert correction',
        confirmed: true,
        confirmed_by: input.confirmed_by,
        confirmation_summary: input.confirmation_summary,
      },
      now,
    });

    correctionAdapter
      .prepare(
        `
          UPDATE case_corrections
             SET reverted_at = ?,
                 is_lock_active = 0
           WHERE correction_id = ?
        `
      )
      .run(now, input.correction_id);

    insertCorrectionMemoryEvent({
      adapter: correctionAdapter,
      event_type: 'case.correction_reverted',
      correction_id: input.correction_id,
      case_id: row.case_id,
      actor: input.confirmed_by,
      confirmation_summary: input.confirmation_summary,
      now,
    });

    return { kind: 'reverted', correction_id: input.correction_id, case_id: row.case_id };
  });
}

/**
 * supersedeCorrection — Phase 2b. Unblocked by spec amendment-8 (2026-04-18)
 * which added `superseded_by` to the mutable-column set in §5.4.
 *
 * Semantics: user changes their mind on an active correction. Inside a single
 * transaction:
 *   1. Read OLD row; reject if not found / reverted / already superseded / inactive.
 *   2. INSERT new correction row referencing the same (case_id, target_kind,
 *      target_ref_hash) with new_value_json and is_lock_active=1.
 *   3. UPDATE OLD row: superseded_by = new.correction_id, is_lock_active = 0.
 *   4. Emit case.correction_superseded memory_event.
 *
 * Per spec §5.4 invariant (amendment-8), the three mutable columns are
 * is_lock_active + reverted_at + superseded_by. superseded_by is written
 * ONLY inside this transition.
 */
export function supersedeCorrection(
  adapter: DatabaseAdapter,
  input: SupersedeCorrectionInput
): CorrectionSupersedeResult {
  const correctionAdapter = adapter as unknown as CorrectionAdapter;

  return runImmediateTransaction(correctionAdapter, () => {
    const now = normalizeNow(input.now);
    const old = correctionAdapter
      .prepare(
        `
          SELECT correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
                 field_name, is_lock_active, reverted_at, superseded_by
          FROM case_corrections
          WHERE correction_id = ?
        `
      )
      .get(input.old_correction_id) as
      | {
          correction_id: string;
          case_id: string;
          target_kind: 'case_field' | 'membership' | 'wiki_section';
          target_ref_json: string;
          target_ref_hash: Uint8Array;
          field_name: string | null;
          is_lock_active: number;
          reverted_at: string | null;
          superseded_by: string | null;
        }
      | undefined;

    if (!old) {
      return {
        kind: 'rejected',
        code: 'case.correction_not_found',
        message: 'Old correction not found.',
        correction_id: input.old_correction_id,
      };
    }

    if (old.reverted_at !== null) {
      return {
        kind: 'rejected',
        code: 'case.correction_reverted',
        message: 'Cannot supersede a reverted correction.',
        correction_id: input.old_correction_id,
      };
    }

    if (old.superseded_by !== null) {
      return {
        kind: 'rejected',
        code: 'case.correction_already_superseded',
        message: 'Correction has already been superseded.',
        correction_id: input.old_correction_id,
      };
    }

    if (Number(old.is_lock_active) === 0) {
      if (old.superseded_by !== null) {
        return {
          kind: 'rejected',
          code: 'case.correction_already_superseded',
          message: 'Correction has already been superseded.',
          correction_id: input.old_correction_id,
        };
      }
      return {
        kind: 'rejected',
        code: 'case.correction_inactive',
        message: 'Correction is inactive.',
        correction_id: input.old_correction_id,
      };
    }

    // Terminal-case gate — mirror applyCorrection. Supersede must not
    // rotate locks or mutate live state on merged/archived/split cases.
    // Without this guard, case_field supersede throws from
    // applyCaseFieldMutation (transaction rolls back but handler leaks
    // 500) and membership supersede silently writes to a dead case.
    const caseRow = correctionAdapter
      .prepare('SELECT status, canonical_case_id FROM case_truth WHERE case_id = ?')
      .get(old.case_id) as CaseGateRow | undefined;

    if (!caseRow) {
      return {
        kind: 'precompile_gap',
        code: 'case.precompile_gap',
        case_id: old.case_id,
      };
    }

    if (TERMINAL_CASE_STATUSES.has(caseRow.status)) {
      return {
        kind: 'rejected',
        code: 'case.terminal_status',
        message: `Supersede rejected: case is in terminal status ${caseRow.status}.`,
        case_id: old.case_id,
      };
    }

    let newCorrectionId = randomCorrectionId();

    // Reconstruct the ApplyCorrection-shaped input from OLD's canonical
    // target_ref_json so we can reuse readCurrentValueJson + applyTargetMutation.
    // The JSON round-trips through canonicalizeJSON on insert so it is safe to
    // parse here without re-validating shape.
    const syntheticTargetRef = parseJsonValue(old.target_ref_json) as CaseTargetRef;
    const syntheticInput: ApplyCorrectionInput = {
      case_id: old.case_id,
      target_kind: old.target_kind,
      target_ref: syntheticTargetRef,
      field_name: (old.field_name as ApplyCorrectionInput['field_name']) ?? undefined,
      new_value_json: input.new_value_json,
      reason: input.reason,
      confirmed: true,
      confirmed_by: input.confirmed_by,
      confirmation_summary: input.confirmation_summary,
    };

    // Snapshot the current live value BEFORE mutating so the NEW row's
    // old_value_json reflects the state the user actually superseded
    // (not NULL, which would erase the audit trail).
    const currentValueJson = readCurrentValueJson(correctionAdapter, syntheticInput);
    const targetRefHashHex = Buffer.from(old.target_ref_hash).toString('hex');

    // CAS / reconfirm dance — mirrors applyCorrection. Now that supersede
    // actually writes live state (P1-1 fix), a stale-view supersede could
    // silently overwrite a value the user never saw. Opt-in via
    // expected_current_value_json (undefined/null = skip CAS).
    //
    // Canonicalize the caller's expected value before comparison so
    // key-ordering or whitespace differences do not cause false 409s.
    // Invalid JSON (including empty string "") throws at the handler
    // boundary — the caller sees a validation_error rather than a bogus
    // silent 409.
    let canonicalExpectedCurrent: string | null = null;
    if (typeof input.expected_current_value_json === 'string') {
      canonicalExpectedCurrent = canonicalizeJSON(
        parseJsonValue(input.expected_current_value_json)
      );
    }

    if (canonicalExpectedCurrent !== null && canonicalExpectedCurrent !== currentValueJson) {
      const token = input.reconfirm_token ?? null;
      if (!token) {
        return buildRequiresReconfirm({
          case_id: old.case_id,
          target_kind: old.target_kind,
          target_ref_json: old.target_ref_json,
          target_ref_hash_hex: targetRefHashHex,
          current_value_json: currentValueJson,
          old_value_json: input.expected_current_value_json ?? null,
          proposed_new_value_json: input.new_value_json,
          confirmed_by: input.confirmed_by,
          session_id: input.session_id ?? null,
          now,
        });
      }

      const payload = verifyReconfirmToken({
        token,
        case_id: old.case_id,
        target_kind: old.target_kind,
        target_ref_hash_hex: targetRefHashHex,
        proposed_value_hash_hex: sha256Hex(input.new_value_json),
        confirmed_by: input.confirmed_by,
        session_id: input.session_id ?? null,
        now,
      });

      if (!payload) {
        return buildRequiresReconfirm({
          case_id: old.case_id,
          target_kind: old.target_kind,
          target_ref_json: old.target_ref_json,
          target_ref_hash_hex: targetRefHashHex,
          current_value_json: currentValueJson,
          old_value_json: input.expected_current_value_json ?? null,
          proposed_new_value_json: input.new_value_json,
          confirmed_by: input.confirmed_by,
          session_id: input.session_id ?? null,
          now,
        });
      }

      newCorrectionId = deterministicCorrectionId(payload.nonce);
      if (correctionExists(correctionAdapter, newCorrectionId)) {
        return {
          kind: 'rejected',
          code: 'case.reconfirm_token_replayed',
          message: 'Reconfirm token has already been consumed.',
          case_id: old.case_id,
        };
      }

      if (payload.current_value_hash_hex !== sha256Hex(currentValueJson)) {
        return buildRequiresReconfirm({
          case_id: old.case_id,
          target_kind: old.target_kind,
          target_ref_json: old.target_ref_json,
          target_ref_hash_hex: targetRefHashHex,
          current_value_json: currentValueJson,
          old_value_json: input.expected_current_value_json ?? null,
          proposed_new_value_json: input.new_value_json,
          confirmed_by: input.confirmed_by,
          session_id: input.session_id ?? null,
          now,
        });
      }
    }

    // Drop OLD lock FIRST so the partial-unique (case_id, target_ref_hash)
    // slot is free before INSERTing the NEW active row.
    correctionAdapter
      .prepare(
        `
          UPDATE case_corrections
             SET is_lock_active = 0
           WHERE correction_id = ?
        `
      )
      .run(input.old_correction_id);

    correctionAdapter
      .prepare(
        `
          INSERT INTO case_corrections (
            correction_id, case_id, target_kind, target_ref_json, target_ref_hash,
            field_name, old_value_json, new_value_json, reason,
            applied_by, applied_at, is_lock_active, reverted_at, superseded_by
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL)
        `
      )
      .run(
        newCorrectionId,
        old.case_id,
        old.target_kind,
        old.target_ref_json,
        old.target_ref_hash,
        old.field_name,
        currentValueJson,
        input.new_value_json,
        input.reason,
        input.confirmed_by,
        now
      );

    // Populate linkage last — sole mutation of superseded_by, permitted by
    // spec §5.4 amendment-8 (2026-04-18).
    correctionAdapter
      .prepare(
        `
          UPDATE case_corrections
             SET superseded_by = ?
           WHERE correction_id = ?
        `
      )
      .run(newCorrectionId, input.old_correction_id);

    // Write the revised value to the live target (case_truth / case_memberships)
    // so the correction drawer and the case board stay consistent. wiki_section
    // targets are overlay-only and intentionally no-op here.
    applyTargetMutation({ adapter: correctionAdapter, correction: syntheticInput, now });

    insertCorrectionMemoryEvent({
      adapter: correctionAdapter,
      event_type: 'case.correction_superseded',
      correction_id: newCorrectionId,
      case_id: old.case_id,
      actor: input.confirmed_by,
      confirmation_summary: input.confirmation_summary,
      now,
      extra_refs: [old.correction_id],
    });

    return {
      kind: 'superseded',
      old_correction_id: input.old_correction_id,
      new_correction_id: newCorrectionId,
      case_id: old.case_id,
      target_ref_json: old.target_ref_json,
      canonical_hash_hex: Buffer.from(old.target_ref_hash).toString('hex'),
    };
  });
}
