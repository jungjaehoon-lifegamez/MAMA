import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { runImmediateTransaction, type ImmediateTransactionAdapter } from './sqlite-transaction.js';
import { resolveCanonicalCaseChain } from './store.js';
import type { CanonicalCaseResolution, CaseMembershipSourceType } from './types.js';

export interface CaseCompositionCasInput {
  expected_current_value_json?: string | null;
  reconfirm_token?: string | null;
  session_id?: string | null;
}

export interface PinCaseMembershipInput extends CaseCompositionCasInput {
  case_id: string;
  source_type: CaseMembershipSourceType;
  source_id: string;
  pinned_by: string;
  reason: string;
  now?: string;
}

export interface UnpinCaseMembershipInput extends CaseCompositionCasInput {
  case_id: string;
  source_type: CaseMembershipSourceType;
  source_id: string;
  unpinned_by: string;
  reason?: string | null;
  now?: string;
}

export interface PromoteCaseSourceInput extends CaseCompositionCasInput {
  case_id: string;
  source_type: 'decision' | 'event' | 'observation' | 'artifact';
  source_id: string;
  promoted_by: string;
  reason: string;
  now?: string;
}

export interface CaseCompositionRequiresReconfirmResult {
  kind: 'requires_reconfirm';
  code: 'case.correction_requires_reconfirm';
  case_id: string;
  target_kind: 'membership';
  target_ref_json: string;
  current_value_json: string;
  old_value_json: string | null;
  proposed_new_value_json: string;
  reconfirm_token: string;
  reconfirm_token_expires_at: string;
  message: string;
}

export type CaseCompositionRejectedCode =
  | 'case.precompile_gap'
  | 'case.terminal_status'
  | 'case.membership_not_found'
  | 'case.membership_stale'
  | 'case.promote_invalid_source_type'
  | 'case.promote_source_not_active'
  | 'case.reconfirm_token_replayed';

export type PinCaseMembershipResult =
  | {
      kind: 'pinned';
      case_id: string;
      terminal_case_id: string;
      resolved_via_case_id: string | null;
      chain: string[];
      membership_case_id: string;
    }
  | CaseCompositionRequiresReconfirmResult
  | { kind: 'rejected'; code: CaseCompositionRejectedCode; message: string; case_id?: string };

export type UnpinCaseMembershipResult =
  | {
      kind: 'unpinned';
      case_id: string;
      terminal_case_id: string;
      resolved_via_case_id: string | null;
      chain: string[];
      membership_case_id: string;
    }
  | CaseCompositionRequiresReconfirmResult
  | { kind: 'rejected'; code: CaseCompositionRejectedCode; message: string; case_id?: string };

export type PromoteCaseSourceResult =
  | {
      kind: 'promoted';
      case_id: string;
      terminal_case_id: string;
      resolved_via_case_id: string | null;
      chain: string[];
      membership_case_id: string;
      canonical_decision_id: string | null;
      canonical_event_id: string | null;
    }
  | CaseCompositionRequiresReconfirmResult
  | { kind: 'rejected'; code: CaseCompositionRejectedCode; message: string; case_id?: string };

type CompositionAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'> &
  Partial<Pick<ImmediateTransactionAdapter, 'exec'>>;

interface CaseGateRow {
  case_id: string;
  status: string;
  canonical_decision_id: string | null;
  canonical_event_id: string | null;
}

interface MembershipRow {
  case_id: string;
  source_type: CaseMembershipSourceType;
  source_id: string;
  status: string;
  role: string | null;
  confidence: number | null;
  reason: string | null;
  user_locked: number;
  assignment_strategy: string | null;
  assigned_at: string | null;
  updated_at: string;
}

interface ReconfirmTokenPayload {
  v: 1;
  kid: string;
  nonce: string;
  case_id: string;
  target_kind: 'membership';
  target_ref_hash_hex: string;
  current_value_hash_hex: string;
  proposed_value_hash_hex: string;
  confirmed_by: string;
  session_id: string | null;
  expires_at: string;
}

interface ReconfirmTokenEnvelope {
  kid: string;
  payload: ReconfirmTokenPayload;
  signature_hex: string;
}

interface CurrentSecret {
  kid: string;
  secret: Buffer;
}

const TERMINAL_CASE_STATUSES = new Set(['merged', 'archived', 'split']);
const RECONFIRM_TOKEN_TTL_MS = 10 * 60_000;

function normalizeNow(value?: string): string {
  return value ?? new Date().toISOString();
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function createdAtMs(value: string): number {
  return timestampMs(value);
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmacHex(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

function deterministicEventId(nonce: string): string {
  return `me_${sha256Hex(`case-composition-reconfirm:v1:${nonce}`).slice(0, 32)}`;
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

  return { kid: secretKid(secret), secret };
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
  const envelope: ReconfirmTokenEnvelope = {
    kid: payload.kid,
    payload,
    signature_hex: hmacHex(secret, payloadJson),
  };

  return Buffer.from(canonicalizeJSON(envelope), 'utf8').toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
      payload.target_kind !== 'membership' ||
      typeof payload.target_ref_hash_hex !== 'string' ||
      typeof payload.current_value_hash_hex !== 'string' ||
      typeof payload.proposed_value_hash_hex !== 'string' ||
      typeof payload.confirmed_by !== 'string' ||
      !(payload.session_id === null || typeof payload.session_id === 'string') ||
      typeof payload.expires_at !== 'string'
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
  target_ref_json: string;
  target_ref_hash_hex: string;
  current_value_json: string;
  old_value_json: string | null;
  proposed_new_value_json: string;
  confirmed_by: string;
  session_id: string | null;
  now: string;
}): CaseCompositionRequiresReconfirmResult {
  const secret = currentSecret();
  const expiresAt = new Date(timestampMs(input.now) + RECONFIRM_TOKEN_TTL_MS).toISOString();
  const payload: ReconfirmTokenPayload = {
    v: 1,
    kid: secret.kid,
    nonce: randomUUID(),
    case_id: input.case_id,
    target_kind: 'membership',
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
    target_kind: 'membership',
    target_ref_json: input.target_ref_json,
    current_value_json: input.current_value_json,
    old_value_json: input.old_value_json,
    proposed_new_value_json: input.proposed_new_value_json,
    reconfirm_token: encodeReconfirmToken(payload, secret.secret),
    reconfirm_token_expires_at: expiresAt,
    message: 'The target changed since the viewed snapshot. Reconfirm against the current value.',
  };
}

function parseJsonValue(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function canonicalExpectedJson(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return canonicalizeJSON(parseJsonValue(value));
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error('Cannot build SQL IN clause for an empty value list.');
  }
  return values.map(() => '?').join(', ');
}

function resolveChain(adapter: CompositionAdapter, caseId: string): CanonicalCaseResolution | null {
  try {
    return resolveCanonicalCaseChain(adapter, caseId);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function expandCaseChainForAssembly(
  adapter: CompositionAdapter,
  terminalCaseId: string,
  resolvedChain: string[]
): string[] {
  const rows = adapter
    .prepare(
      `
        WITH RECURSIVE merged_chain(case_id, depth) AS (
          SELECT case_id, 0
            FROM case_truth
           WHERE case_id = ?

          UNION

          SELECT ct.case_id, merged_chain.depth + 1
            FROM case_truth ct
            JOIN merged_chain ON ct.canonical_case_id = merged_chain.case_id
           WHERE merged_chain.depth < 64
        )
        SELECT case_id
          FROM merged_chain
         ORDER BY depth ASC, case_id ASC
      `
    )
    .all(terminalCaseId) as Array<{ case_id: string }>;

  const chain: string[] = [];
  for (const caseId of [...resolvedChain, ...rows.map((row) => row.case_id)]) {
    if (!chain.includes(caseId)) {
      chain.push(caseId);
    }
  }
  return chain;
}

function loadCaseGate(adapter: CompositionAdapter, caseId: string): CaseGateRow | null {
  const row = adapter
    .prepare(
      `
        SELECT case_id, status, canonical_decision_id, canonical_event_id
        FROM case_truth
        WHERE case_id = ?
      `
    )
    .get(caseId) as CaseGateRow | undefined;

  return row ?? null;
}

function findMembership(
  adapter: CompositionAdapter,
  chain: string[],
  sourceType: CaseMembershipSourceType,
  sourceId: string
): MembershipRow | null {
  const row = adapter
    .prepare(
      `
        SELECT case_id, source_type, source_id, status, role, confidence, reason,
               user_locked, assignment_strategy, added_at AS assigned_at, updated_at
        FROM case_memberships
        WHERE case_id IN (${placeholders(chain)})
          AND source_type = ?
          AND source_id = ?
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'candidate' THEN 1
            WHEN 'excluded' THEN 2
            WHEN 'removed' THEN 3
            ELSE 4
          END ASC,
          user_locked DESC,
          updated_at DESC,
          case_id ASC
        LIMIT 1
      `
    )
    .get(...chain, sourceType, sourceId) as MembershipRow | undefined;

  return row ?? null;
}

function membershipTargetRefJson(input: { source_type: string; source_id: string }): string {
  return canonicalizeJSON({
    kind: 'membership',
    source_type: input.source_type,
    source_id: input.source_id,
  });
}

function membershipSnapshot(row: MembershipRow): Record<string, unknown> {
  return {
    case_id: row.case_id,
    source_type: row.source_type,
    source_id: row.source_id,
    status: row.status,
    role: row.role,
    confidence: row.confidence,
    reason: row.reason,
    user_locked: Number(row.user_locked) === 1 ? 1 : 0,
    assignment_strategy: row.assignment_strategy,
    assigned_at: row.assigned_at,
    updated_at: row.updated_at,
  };
}

function appendReason(existing: string | null, reason: string): string {
  if (!existing || existing.trim().length === 0) {
    return reason;
  }
  const lines = existing.split('\n');
  const lastLine = lines.at(-1)?.trim() ?? '';
  const nextLine = `manual-pin: ${reason}`;
  if (lastLine === nextLine) {
    return existing;
  }
  if (lastLine.startsWith('manual-pin:')) {
    lines[lines.length - 1] = nextLine;
    return lines.join('\n');
  }
  return `${existing}\n${nextLine}`;
}

function insertMemoryEvent(input: {
  adapter: CompositionAdapter;
  event_type: 'case.membership_pinned' | 'case.membership_unpinned' | 'case.source_promoted';
  event_id?: string;
  actor: string;
  case_id: string;
  evidence_refs: unknown[];
  reason: unknown;
  now: string;
}): void {
  input.adapter
    .prepare(
      `
        INSERT INTO memory_events (
          event_id, event_type, actor, source_turn_id, memory_id, topic,
          scope_refs, evidence_refs, reason, created_at
        )
        VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.event_id ?? `me_${randomUUID()}`,
      input.event_type,
      input.actor,
      `case:${input.case_id}`,
      canonicalizeJSON([{ type: 'case', id: input.case_id }]),
      canonicalizeJSON(input.evidence_refs),
      canonicalizeJSON(input.reason),
      createdAtMs(input.now)
    );
}

function memoryEventExists(adapter: CompositionAdapter, eventId: string): boolean {
  const row = adapter
    .prepare('SELECT event_id FROM memory_events WHERE event_id = ?')
    .get(eventId) as { event_id: string } | undefined;
  return Boolean(row);
}

function casCheck(input: {
  adapter: CompositionAdapter;
  case_id: string;
  target_ref_json: string;
  current_value_json: string;
  expected_current_value_json?: string | null;
  proposed_new_value_json: string;
  actor: string;
  session_id?: string | null;
  reconfirm_token?: string | null;
  now: string;
}):
  | { kind: 'ok'; event_id?: string }
  | CaseCompositionRequiresReconfirmResult
  | { kind: 'rejected'; code: 'case.reconfirm_token_replayed'; message: string; case_id: string } {
  const canonicalExpectedCurrent = canonicalExpectedJson(input.expected_current_value_json);
  if (canonicalExpectedCurrent === null || canonicalExpectedCurrent === input.current_value_json) {
    return { kind: 'ok' };
  }

  const targetRefHashHex = sha256Hex(input.target_ref_json);
  const token = input.reconfirm_token ?? null;
  if (!token) {
    return buildRequiresReconfirm({
      case_id: input.case_id,
      target_ref_json: input.target_ref_json,
      target_ref_hash_hex: targetRefHashHex,
      current_value_json: input.current_value_json,
      old_value_json: input.expected_current_value_json ?? null,
      proposed_new_value_json: input.proposed_new_value_json,
      confirmed_by: input.actor,
      session_id: input.session_id ?? null,
      now: input.now,
    });
  }

  const payload = verifyReconfirmToken({
    token,
    case_id: input.case_id,
    target_ref_hash_hex: targetRefHashHex,
    proposed_value_hash_hex: sha256Hex(input.proposed_new_value_json),
    confirmed_by: input.actor,
    session_id: input.session_id ?? null,
    now: input.now,
  });

  if (!payload || payload.current_value_hash_hex !== sha256Hex(input.current_value_json)) {
    if (payload) {
      const replayEventId = deterministicEventId(payload.nonce);
      if (memoryEventExists(input.adapter, replayEventId)) {
        return {
          kind: 'rejected',
          code: 'case.reconfirm_token_replayed',
          message: 'Reconfirm token has already been consumed.',
          case_id: input.case_id,
        };
      }
    }
    return buildRequiresReconfirm({
      case_id: input.case_id,
      target_ref_json: input.target_ref_json,
      target_ref_hash_hex: targetRefHashHex,
      current_value_json: input.current_value_json,
      old_value_json: input.expected_current_value_json ?? null,
      proposed_new_value_json: input.proposed_new_value_json,
      confirmed_by: input.actor,
      session_id: input.session_id ?? null,
      now: input.now,
    });
  }

  const eventId = deterministicEventId(payload.nonce);
  if (memoryEventExists(input.adapter, eventId)) {
    return {
      kind: 'rejected',
      code: 'case.reconfirm_token_replayed',
      message: 'Reconfirm token has already been consumed.',
      case_id: input.case_id,
    };
  }

  return { kind: 'ok', event_id: eventId };
}

export function pinCaseMembership(
  adapter: DatabaseAdapter,
  input: PinCaseMembershipInput
): PinCaseMembershipResult {
  const compositionAdapter = adapter as unknown as CompositionAdapter;

  return runImmediateTransaction(compositionAdapter, () => {
    const now = normalizeNow(input.now);
    const resolution = resolveChain(compositionAdapter, input.case_id);
    if (!resolution) {
      return {
        kind: 'rejected',
        code: 'case.precompile_gap',
        message: `Case ${input.case_id} does not exist.`,
        case_id: input.case_id,
      };
    }

    const terminalCase = loadCaseGate(compositionAdapter, resolution.terminal_case_id);
    if (!terminalCase) {
      return {
        kind: 'rejected',
        code: 'case.precompile_gap',
        message: `Case ${resolution.terminal_case_id} does not exist.`,
        case_id: resolution.terminal_case_id,
      };
    }

    if (TERMINAL_CASE_STATUSES.has(terminalCase.status)) {
      return {
        kind: 'rejected',
        code: 'case.terminal_status',
        message: `Cannot pin membership on terminal case status ${terminalCase.status}.`,
        case_id: terminalCase.case_id,
      };
    }

    const chain = expandCaseChainForAssembly(
      compositionAdapter,
      resolution.terminal_case_id,
      resolution.chain
    );
    const membership = findMembership(
      compositionAdapter,
      chain,
      input.source_type,
      input.source_id
    );

    if (!membership) {
      return {
        kind: 'rejected',
        code: 'case.membership_not_found',
        message: 'Membership row was not found in the canonical case chain.',
        case_id: resolution.terminal_case_id,
      };
    }

    if (membership.status === 'stale') {
      return {
        kind: 'rejected',
        code: 'case.membership_stale',
        message: 'Stale memberships cannot be pinned.',
        case_id: membership.case_id,
      };
    }

    const targetRefJson = membershipTargetRefJson(input);
    const newReason = appendReason(membership.reason, input.reason);
    const currentValueJson = canonicalizeJSON(membershipSnapshot(membership));
    const proposedNewValueJson = canonicalizeJSON({
      ...membershipSnapshot(membership),
      user_locked: 1,
      assignment_strategy: 'manual-pin',
      reason: newReason,
    });
    const cas = casCheck({
      adapter: compositionAdapter,
      case_id: resolution.terminal_case_id,
      target_ref_json: targetRefJson,
      current_value_json: currentValueJson,
      expected_current_value_json: input.expected_current_value_json,
      proposed_new_value_json: proposedNewValueJson,
      actor: input.pinned_by,
      session_id: input.session_id,
      reconfirm_token: input.reconfirm_token,
      now,
    });
    if (cas.kind !== 'ok') {
      return cas;
    }

    compositionAdapter
      .prepare(
        `
          UPDATE case_memberships
          SET user_locked = 1,
              assignment_strategy = 'manual-pin',
              reason = ?,
              updated_at = ?,
              explanation_updated_at = ?
          WHERE case_id = ?
            AND source_type = ?
            AND source_id = ?
            AND status <> 'stale'
        `
      )
      .run(newReason, now, now, membership.case_id, membership.source_type, membership.source_id);

    insertMemoryEvent({
      adapter: compositionAdapter,
      event_type: 'case.membership_pinned',
      event_id: cas.event_id,
      actor: input.pinned_by,
      case_id: resolution.terminal_case_id,
      evidence_refs: [membership.source_id],
      reason: {
        source_type: membership.source_type,
        source_id: membership.source_id,
        membership_case_id: membership.case_id,
        reason: input.reason,
      },
      now,
    });

    return {
      kind: 'pinned',
      case_id: input.case_id,
      terminal_case_id: resolution.terminal_case_id,
      resolved_via_case_id: resolution.resolved_via_case_id,
      chain,
      membership_case_id: membership.case_id,
    };
  });
}

export function unpinCaseMembership(
  adapter: DatabaseAdapter,
  input: UnpinCaseMembershipInput
): UnpinCaseMembershipResult {
  const compositionAdapter = adapter as unknown as CompositionAdapter;

  return runImmediateTransaction(compositionAdapter, () => {
    const now = normalizeNow(input.now);
    const resolution = resolveChain(compositionAdapter, input.case_id);
    if (!resolution) {
      return {
        kind: 'rejected',
        code: 'case.precompile_gap',
        message: `Case ${input.case_id} does not exist.`,
        case_id: input.case_id,
      };
    }

    const terminalCase = loadCaseGate(compositionAdapter, resolution.terminal_case_id);
    if (!terminalCase) {
      return {
        kind: 'rejected',
        code: 'case.precompile_gap',
        message: `Case ${resolution.terminal_case_id} does not exist.`,
        case_id: resolution.terminal_case_id,
      };
    }

    if (TERMINAL_CASE_STATUSES.has(terminalCase.status)) {
      return {
        kind: 'rejected',
        code: 'case.terminal_status',
        message: `Cannot unpin membership on terminal case status ${terminalCase.status}.`,
        case_id: terminalCase.case_id,
      };
    }

    const chain = expandCaseChainForAssembly(
      compositionAdapter,
      resolution.terminal_case_id,
      resolution.chain
    );
    const membership = findMembership(
      compositionAdapter,
      chain,
      input.source_type,
      input.source_id
    );

    if (!membership) {
      return {
        kind: 'rejected',
        code: 'case.membership_not_found',
        message: 'Membership row was not found in the canonical case chain.',
        case_id: resolution.terminal_case_id,
      };
    }

    if (membership.status === 'stale') {
      return {
        kind: 'rejected',
        code: 'case.membership_stale',
        message: 'Stale memberships cannot be unpinned.',
        case_id: membership.case_id,
      };
    }

    const targetRefJson = membershipTargetRefJson(input);
    const currentValueJson = canonicalizeJSON(membershipSnapshot(membership));
    const proposedNewValueJson = canonicalizeJSON({
      ...membershipSnapshot(membership),
      user_locked: 0,
    });
    const cas = casCheck({
      adapter: compositionAdapter,
      case_id: resolution.terminal_case_id,
      target_ref_json: targetRefJson,
      current_value_json: currentValueJson,
      expected_current_value_json: input.expected_current_value_json,
      proposed_new_value_json: proposedNewValueJson,
      actor: input.unpinned_by,
      session_id: input.session_id,
      reconfirm_token: input.reconfirm_token,
      now,
    });
    if (cas.kind !== 'ok') {
      return cas;
    }

    compositionAdapter
      .prepare(
        `
          UPDATE case_memberships
          SET user_locked = 0,
              updated_at = ?
          WHERE case_id = ?
            AND source_type = ?
            AND source_id = ?
            AND status <> 'stale'
        `
      )
      .run(now, membership.case_id, membership.source_type, membership.source_id);

    insertMemoryEvent({
      adapter: compositionAdapter,
      event_type: 'case.membership_unpinned',
      event_id: cas.event_id,
      actor: input.unpinned_by,
      case_id: resolution.terminal_case_id,
      evidence_refs: [membership.source_id],
      reason: {
        source_type: membership.source_type,
        source_id: membership.source_id,
        membership_case_id: membership.case_id,
        reason: input.reason ?? null,
      },
      now,
    });

    return {
      kind: 'unpinned',
      case_id: input.case_id,
      terminal_case_id: resolution.terminal_case_id,
      resolved_via_case_id: resolution.resolved_via_case_id,
      chain,
      membership_case_id: membership.case_id,
    };
  });
}

export function promoteCaseSource(
  adapter: DatabaseAdapter,
  input: PromoteCaseSourceInput
): PromoteCaseSourceResult {
  const compositionAdapter = adapter as unknown as CompositionAdapter;

  return runImmediateTransaction(compositionAdapter, () => {
    const now = normalizeNow(input.now);

    if (input.source_type !== 'decision' && input.source_type !== 'event') {
      return {
        kind: 'rejected',
        code: 'case.promote_invalid_source_type',
        message: 'Only decision and event memberships can be promoted.',
        case_id: input.case_id,
      };
    }

    const resolution = resolveChain(compositionAdapter, input.case_id);
    if (!resolution) {
      return {
        kind: 'rejected',
        code: 'case.precompile_gap',
        message: `Case ${input.case_id} does not exist.`,
        case_id: input.case_id,
      };
    }

    const terminalCase = loadCaseGate(compositionAdapter, resolution.terminal_case_id);
    if (!terminalCase) {
      return {
        kind: 'rejected',
        code: 'case.precompile_gap',
        message: `Case ${resolution.terminal_case_id} does not exist.`,
        case_id: resolution.terminal_case_id,
      };
    }

    if (TERMINAL_CASE_STATUSES.has(terminalCase.status)) {
      return {
        kind: 'rejected',
        code: 'case.terminal_status',
        message: `Cannot promote source on terminal case status ${terminalCase.status}.`,
        case_id: terminalCase.case_id,
      };
    }

    const chain = expandCaseChainForAssembly(
      compositionAdapter,
      resolution.terminal_case_id,
      resolution.chain
    );
    const membership = findMembership(
      compositionAdapter,
      chain,
      input.source_type,
      input.source_id
    );

    if (!membership || membership.status !== 'active') {
      return {
        kind: 'rejected',
        code: 'case.promote_source_not_active',
        message: 'Promoted source must be an active membership in the canonical case chain.',
        case_id: resolution.terminal_case_id,
      };
    }

    const targetRefJson = membershipTargetRefJson(input);
    const currentValueJson = canonicalizeJSON({
      promotion: {
        canonical_decision_id: terminalCase.canonical_decision_id,
        canonical_event_id: terminalCase.canonical_event_id,
      },
      membership: membershipSnapshot(membership),
    });
    const proposedCanonicalDecisionId =
      input.source_type === 'decision' ? input.source_id : terminalCase.canonical_decision_id;
    const proposedCanonicalEventId =
      input.source_type === 'event' ? input.source_id : terminalCase.canonical_event_id;
    const proposedNewValueJson = canonicalizeJSON({
      promotion: {
        canonical_decision_id: proposedCanonicalDecisionId,
        canonical_event_id: proposedCanonicalEventId,
        promoted_by: input.promoted_by,
        promotion_reason: input.reason,
      },
      membership: {
        ...membershipSnapshot(membership),
        user_locked: 1,
      },
    });
    const cas = casCheck({
      adapter: compositionAdapter,
      case_id: resolution.terminal_case_id,
      target_ref_json: targetRefJson,
      current_value_json: currentValueJson,
      expected_current_value_json: input.expected_current_value_json,
      proposed_new_value_json: proposedNewValueJson,
      actor: input.promoted_by,
      session_id: input.session_id,
      reconfirm_token: input.reconfirm_token,
      now,
    });
    if (cas.kind !== 'ok') {
      return cas;
    }

    if (input.source_type === 'decision') {
      compositionAdapter
        .prepare(
          `
            UPDATE case_truth
            SET canonical_decision_id = ?,
                promoted_at = ?,
                promoted_by = ?,
                promotion_reason = ?,
                updated_at = ?
            WHERE case_id = ?
          `
        )
        .run(
          input.source_id,
          now,
          input.promoted_by,
          input.reason,
          now,
          resolution.terminal_case_id
        );
    } else {
      compositionAdapter
        .prepare(
          `
            UPDATE case_truth
            SET canonical_event_id = ?,
                promoted_at = ?,
                promoted_by = ?,
                promotion_reason = ?,
                updated_at = ?
            WHERE case_id = ?
          `
        )
        .run(
          input.source_id,
          now,
          input.promoted_by,
          input.reason,
          now,
          resolution.terminal_case_id
        );
    }

    compositionAdapter
      .prepare(
        `
          UPDATE case_memberships
          SET user_locked = 1,
              updated_at = ?
          WHERE case_id = ?
            AND source_type = ?
            AND source_id = ?
            AND status = 'active'
        `
      )
      .run(now, membership.case_id, membership.source_type, membership.source_id);

    insertMemoryEvent({
      adapter: compositionAdapter,
      event_type: 'case.source_promoted',
      event_id: cas.event_id,
      actor: input.promoted_by,
      case_id: resolution.terminal_case_id,
      evidence_refs: [membership.source_id],
      reason: {
        source_type: membership.source_type,
        source_id: membership.source_id,
        membership_case_id: membership.case_id,
        reason: input.reason,
      },
      now,
    });

    return {
      kind: 'promoted',
      case_id: input.case_id,
      terminal_case_id: resolution.terminal_case_id,
      resolved_via_case_id: resolution.resolved_via_case_id,
      chain,
      membership_case_id: membership.case_id,
      canonical_decision_id: proposedCanonicalDecisionId,
      canonical_event_id: proposedCanonicalEventId,
    };
  });
}
