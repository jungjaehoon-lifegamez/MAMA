import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { runImmediateTransaction, type ImmediateTransactionAdapter } from './sqlite-transaction.js';
import { expandCaseChainForAssembly, resolveCanonicalCaseChain } from './store.js';
import type { CanonicalCaseResolution } from './types.js';

export type CaseLinkType =
  | 'related'
  | 'supersedes-case'
  | 'subcase-of'
  | 'blocked-by'
  | 'duplicate-of';

export type CaseLinkSourceKind = 'manual' | 'wiki_compiler' | 'hitl_correction' | 'system_backfill';

export interface CaseLinkRecord {
  link_id: string;
  case_id_from: string;
  case_id_to: string;
  link_type: CaseLinkType;
  created_at: string;
  created_by: string;
  confidence: number | null;
  reason_json: string | null;
  source_kind: CaseLinkSourceKind;
  source_ref: string | null;
  source_ref_fingerprint: Buffer | null;
  source_ref_fingerprint_hex: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

export interface CaseLinkCreateInput {
  link_id?: string;
  case_id_from: string;
  case_id_to: string;
  link_type: CaseLinkType;
  created_by: string;
  confidence?: number | null;
  reason_json?: string | Record<string, unknown> | null;
  source_kind?: CaseLinkSourceKind;
  source_ref?: string | null;
  source_ref_fingerprint?: Buffer | Uint8Array | null;
  unsuppress_wiki_tombstone?: boolean;
  expected_current_value_json?: string | null;
  reconfirm_token?: string | null;
  session_id?: string | null;
  now?: string;
}

export interface CaseLinkRevokeInput {
  link_id: string;
  revoked_by: string;
  revoke_reason: string;
  expected_current_value_json?: string | null;
  reconfirm_token?: string | null;
  session_id?: string | null;
  now?: string;
}

export interface CaseLinkRequiresReconfirmResult {
  kind: 'requires_reconfirm';
  code: 'case.correction_requires_reconfirm';
  case_id: string;
  target_kind: 'case_link';
  target_ref_json: string;
  current_value_json: string;
  old_value_json: string | null;
  proposed_new_value_json: string;
  reconfirm_token: string;
  reconfirm_token_expires_at: string;
  message: string;
}

export type CaseLinkCreateResult =
  | { kind: 'created'; link_id: string; source_ref_fingerprint_hex: string }
  | CaseLinkRequiresReconfirmResult
  | {
      kind: 'rejected';
      code:
        | 'case.precompile_gap'
        | 'case.terminal_status'
        | 'case.self_link'
        | 'case.wiki_tombstone_conflict'
        | 'case.correction_active_conflict'
        | 'case.reconfirm_token_replayed';
      message: string;
      case_id?: string;
    };

export type CaseLinkRevokeResult =
  | { kind: 'revoked'; link_id: string }
  | CaseLinkRequiresReconfirmResult
  | {
      kind: 'rejected';
      code:
        | 'case.case_link_not_found'
        | 'case.wiki_tombstone_fingerprint_missing'
        | 'case.reconfirm_token_replayed';
      message: string;
      link_id?: string;
    };

export interface ListActiveCaseLinksResult {
  terminal_case_id: string;
  resolved_via_case_id: string | null;
  chain: string[];
  links: CaseLinkRecord[];
}

export interface BackfillStructuralLinksResult {
  duplicate_of_inserted: number;
  subcase_of_inserted: number;
}

type CaseLinkAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'> &
  Partial<Pick<ImmediateTransactionAdapter, 'exec'>>;

interface CaseGateRow {
  case_id: string;
  status: string;
  canonical_case_id: string | null;
  split_from_case_id: string | null;
  title: string;
  current_wiki_path: string | null;
  updated_at: string;
}

interface ReconfirmTokenPayload {
  v: 1;
  kid: string;
  nonce: string;
  case_id: string;
  target_kind: 'case_link';
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

function randomLinkId(): string {
  return `link_${randomUUID().replace(/-/g, '')}`;
}

function randomTombstoneId(): string {
  return `tomb_${randomUUID().replace(/-/g, '')}`;
}

function deterministicLinkId(nonce: string): string {
  return `link_${sha256Hex(`case-link-reconfirm:v1:${nonce}`).slice(0, 32)}`;
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmacHex(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
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
      payload.target_kind !== 'case_link' ||
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
}): CaseLinkRequiresReconfirmResult {
  const secret = currentSecret();
  const expiresAt = new Date(timestampMs(input.now) + RECONFIRM_TOKEN_TTL_MS).toISOString();
  const payload: ReconfirmTokenPayload = {
    v: 1,
    kid: secret.kid,
    nonce: randomUUID(),
    case_id: input.case_id,
    target_kind: 'case_link',
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
    target_kind: 'case_link',
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

function toBuffer(value: unknown): Buffer | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error('Expected SQLite BLOB value to be a Buffer.');
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
  return Number.isFinite(n) ? n : null;
}

function mapCaseLinkRow(row: Record<string, unknown>): CaseLinkRecord {
  const fingerprint = toBuffer(row.source_ref_fingerprint);
  return {
    link_id: String(row.link_id),
    case_id_from: String(row.case_id_from),
    case_id_to: String(row.case_id_to),
    link_type: String(row.link_type) as CaseLinkType,
    created_at: String(row.created_at),
    created_by: String(row.created_by),
    confidence: nullableNumber(row.confidence),
    reason_json: nullableString(row.reason_json),
    source_kind: String(row.source_kind) as CaseLinkSourceKind,
    source_ref: nullableString(row.source_ref),
    source_ref_fingerprint: fingerprint,
    source_ref_fingerprint_hex: fingerprint ? fingerprint.toString('hex') : null,
    revoked_at: nullableString(row.revoked_at),
    revoked_by: nullableString(row.revoked_by),
    revoke_reason: nullableString(row.revoke_reason),
  };
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error('Cannot build SQL IN clause for an empty value list.');
  }
  return values.map(() => '?').join(', ');
}

function loadCase(adapter: CaseLinkAdapter, caseId: string): CaseGateRow | null {
  const row = adapter
    .prepare(
      `
        SELECT case_id, status, canonical_case_id, split_from_case_id, title,
               current_wiki_path, updated_at
        FROM case_truth
        WHERE case_id = ?
      `
    )
    .get(caseId) as CaseGateRow | undefined;

  return row ?? null;
}

function caseSnapshot(row: CaseGateRow): Record<string, unknown> {
  return {
    case_id: row.case_id,
    status: row.status,
    canonical_case_id: row.canonical_case_id,
    split_from_case_id: row.split_from_case_id,
    title: row.title,
    current_wiki_path: row.current_wiki_path,
    updated_at: row.updated_at,
  };
}

function reasonJson(value: CaseLinkCreateInput['reason_json']): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  return canonicalizeJSON(value);
}

function caseLinkTargetRefJson(input: {
  case_id_from: string;
  case_id_to: string;
  link_type: CaseLinkType;
}): string {
  return canonicalizeJSON({
    kind: 'case_link',
    case_id_from: input.case_id_from,
    case_id_to: input.case_id_to,
    link_type: input.link_type,
  });
}

function activeLinkForTriple(
  adapter: CaseLinkAdapter,
  input: { case_id_from: string; case_id_to: string; link_type: CaseLinkType }
): CaseLinkRecord | null {
  const row = adapter
    .prepare(
      `
        SELECT *
        FROM case_links
        WHERE case_id_from = ?
          AND case_id_to = ?
          AND link_type = ?
          AND revoked_at IS NULL
        LIMIT 1
      `
    )
    .get(input.case_id_from, input.case_id_to, input.link_type) as
    | Record<string, unknown>
    | undefined;

  return row ? mapCaseLinkRow(row) : null;
}

function linkExistsById(adapter: CaseLinkAdapter, linkId: string): boolean {
  const row = adapter.prepare('SELECT link_id FROM case_links WHERE link_id = ?').get(linkId) as
    | { link_id: string }
    | undefined;
  return Boolean(row);
}

function activeTombstoneRow(
  adapter: CaseLinkAdapter,
  input: { source_case_id: string; target_case_id: string; link_type: CaseLinkType },
  fingerprint = sha256TombstoneFingerprint(input)
): { tombstone_id: string } | null {
  const row = adapter
    .prepare(
      `
        SELECT tombstone_id
        FROM case_links_revoked_wiki_tombstones
        WHERE case_id_from = ?
          AND case_id_to = ?
          AND link_type = ?
          AND source_ref_fingerprint = ?
          AND unsuppressed_at IS NULL
        LIMIT 1
      `
    )
    .get(input.source_case_id, input.target_case_id, input.link_type, fingerprint) as
    | { tombstone_id: string }
    | undefined;

  return row ?? null;
}

function unsuppressWikiTombstoneInTransaction(
  adapter: CaseLinkAdapter,
  input: {
    source_case_id: string;
    target_case_id: string;
    link_type: CaseLinkType;
    unsuppressed_by: string;
    now: string;
  },
  fingerprint = sha256TombstoneFingerprint(input)
): number {
  const result = adapter
    .prepare(
      `
        UPDATE case_links_revoked_wiki_tombstones
        SET unsuppressed_at = ?, unsuppressed_by = ?
        WHERE case_id_from = ?
          AND case_id_to = ?
          AND link_type = ?
          AND source_ref_fingerprint = ?
          AND unsuppressed_at IS NULL
      `
    )
    .run(
      input.now,
      input.unsuppressed_by,
      input.source_case_id,
      input.target_case_id,
      input.link_type,
      fingerprint
    );

  return result.changes;
}

function currentCreateValueJson(
  adapter: CaseLinkAdapter,
  input: CaseLinkCreateInput,
  sourceCase: CaseGateRow,
  targetCase: CaseGateRow
): string {
  return canonicalizeJSON({
    source_case: caseSnapshot(sourceCase),
    target_case: caseSnapshot(targetCase),
    target_ref: {
      kind: 'case_link',
      case_id_from: input.case_id_from,
      case_id_to: input.case_id_to,
      link_type: input.link_type,
    },
    active_link: activeLinkForTriple(adapter, input),
    wiki_tombstone_active: isWikiTombstoneActive(adapter, {
      source_case_id: input.case_id_from,
      target_case_id: input.case_id_to,
      link_type: input.link_type,
    }),
  });
}

function proposedCreateValueJson(input: CaseLinkCreateInput): string {
  return canonicalizeJSON({
    case_id_from: input.case_id_from,
    case_id_to: input.case_id_to,
    link_type: input.link_type,
    confidence: input.confidence ?? null,
    reason_json: reasonJson(input.reason_json),
    source_kind: input.source_kind ?? 'manual',
    source_ref: input.source_ref ?? null,
  });
}

function currentRevokeValueJson(row: CaseLinkRecord): string {
  return canonicalizeJSON({
    link_id: row.link_id,
    case_id_from: row.case_id_from,
    case_id_to: row.case_id_to,
    link_type: row.link_type,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
    revoke_reason: row.revoke_reason,
    source_kind: row.source_kind,
    source_ref_fingerprint_hex: row.source_ref_fingerprint_hex,
  });
}

function insertMemoryEvent(input: {
  adapter: CaseLinkAdapter;
  event_type: 'case.link_created' | 'case.link_revoked';
  actor: string;
  case_id: string;
  link_id: string;
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
      `me_${randomUUID()}`,
      input.event_type,
      input.actor,
      `case:${input.case_id}`,
      canonicalizeJSON([{ type: 'case', id: input.case_id }]),
      canonicalizeJSON([input.link_id]),
      canonicalizeJSON(input.reason),
      createdAtMs(input.now)
    );
}

export function sha256TombstoneFingerprint(input: {
  source_case_id: string;
  target_case_id: string;
  link_type: CaseLinkType;
}): Buffer {
  return createHash('sha256')
    .update(
      canonicalizeJSON({
        source_case_id: input.source_case_id,
        target_case_id: input.target_case_id,
        link_type: input.link_type,
      }),
      'utf8'
    )
    .digest();
}

export function createCaseLink(
  adapter: DatabaseAdapter,
  input: CaseLinkCreateInput
): CaseLinkCreateResult {
  const linkAdapter = adapter as unknown as CaseLinkAdapter;

  return runImmediateTransaction(linkAdapter, () => {
    const now = normalizeNow(input.now);
    const sourceKind = input.source_kind ?? 'manual';

    if (input.case_id_from === input.case_id_to) {
      return {
        kind: 'rejected',
        code: 'case.self_link',
        message: 'Case links cannot point to the same case.',
        case_id: input.case_id_from,
      };
    }

    const sourceCase = loadCase(linkAdapter, input.case_id_from);
    if (!sourceCase) {
      return {
        kind: 'rejected',
        code: 'case.precompile_gap',
        message: `Source case ${input.case_id_from} does not exist.`,
        case_id: input.case_id_from,
      };
    }

    const targetCase = loadCase(linkAdapter, input.case_id_to);
    if (!targetCase) {
      return {
        kind: 'rejected',
        code: 'case.precompile_gap',
        message: `Target case ${input.case_id_to} does not exist.`,
        case_id: input.case_id_to,
      };
    }

    for (const row of [sourceCase, targetCase]) {
      if (TERMINAL_CASE_STATUSES.has(row.status)) {
        return {
          kind: 'rejected',
          code: 'case.terminal_status',
          message: `Case links cannot target terminal case status ${row.status}.`,
          case_id: row.case_id,
        };
      }
    }

    const targetRefJson = caseLinkTargetRefJson(input);
    const targetRefHashHex = sha256Hex(targetRefJson);
    const currentValueJson = currentCreateValueJson(linkAdapter, input, sourceCase, targetCase);
    const canonicalExpectedCurrent = canonicalExpectedJson(input.expected_current_value_json);
    const proposedNewValueJson = proposedCreateValueJson(input);
    let linkId = input.link_id ?? randomLinkId();

    if (canonicalExpectedCurrent !== null && canonicalExpectedCurrent !== currentValueJson) {
      const token = input.reconfirm_token ?? null;
      if (!token) {
        return buildRequiresReconfirm({
          case_id: input.case_id_from,
          target_ref_json: targetRefJson,
          target_ref_hash_hex: targetRefHashHex,
          current_value_json: currentValueJson,
          old_value_json: input.expected_current_value_json ?? null,
          proposed_new_value_json: proposedNewValueJson,
          confirmed_by: input.created_by,
          session_id: input.session_id ?? null,
          now,
        });
      }

      const payload = verifyReconfirmToken({
        token,
        case_id: input.case_id_from,
        target_ref_hash_hex: targetRefHashHex,
        proposed_value_hash_hex: sha256Hex(proposedNewValueJson),
        confirmed_by: input.created_by,
        session_id: input.session_id ?? null,
        now,
      });

      if (!payload || payload.current_value_hash_hex !== sha256Hex(currentValueJson)) {
        return buildRequiresReconfirm({
          case_id: input.case_id_from,
          target_ref_json: targetRefJson,
          target_ref_hash_hex: targetRefHashHex,
          current_value_json: currentValueJson,
          old_value_json: input.expected_current_value_json ?? null,
          proposed_new_value_json: proposedNewValueJson,
          confirmed_by: input.created_by,
          session_id: input.session_id ?? null,
          now,
        });
      }

      linkId = deterministicLinkId(payload.nonce);
      if (linkExistsById(linkAdapter, linkId)) {
        return {
          kind: 'rejected',
          code: 'case.reconfirm_token_replayed',
          message: 'Reconfirm token has already been consumed.',
          case_id: input.case_id_from,
        };
      }
    }

    const fingerprint =
      toBuffer(input.source_ref_fingerprint) ??
      sha256TombstoneFingerprint({
        source_case_id: input.case_id_from,
        target_case_id: input.case_id_to,
        link_type: input.link_type,
      });

    if (sourceKind === 'manual') {
      if (activeLinkForTriple(linkAdapter, input)) {
        return {
          kind: 'rejected',
          code: 'case.correction_active_conflict',
          message: 'An active case link already exists for this relationship.',
          case_id: input.case_id_from,
        };
      }

      const tombstone = activeTombstoneRow(
        linkAdapter,
        {
          source_case_id: input.case_id_from,
          target_case_id: input.case_id_to,
          link_type: input.link_type,
        },
        fingerprint
      );

      if (tombstone && input.unsuppress_wiki_tombstone !== true) {
        return {
          kind: 'rejected',
          code: 'case.wiki_tombstone_conflict',
          message: 'A revoked wiki-emitted link tombstone exists for this relationship.',
          case_id: input.case_id_from,
        };
      }

      if (tombstone) {
        unsuppressWikiTombstoneInTransaction(
          linkAdapter,
          {
            source_case_id: input.case_id_from,
            target_case_id: input.case_id_to,
            link_type: input.link_type,
            unsuppressed_by: input.created_by,
            now,
          },
          fingerprint
        );
      }
    }

    if (activeLinkForTriple(linkAdapter, input)) {
      return {
        kind: 'rejected',
        code: 'case.correction_active_conflict',
        message: 'An active case link already exists for this relationship.',
        case_id: input.case_id_from,
      };
    }

    linkAdapter
      .prepare(
        `
          INSERT INTO case_links (
            link_id, case_id_from, case_id_to, link_type, created_at, created_by,
            confidence, reason_json, source_kind, source_ref, source_ref_fingerprint,
            revoked_at, revoked_by, revoke_reason
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        `
      )
      .run(
        linkId,
        input.case_id_from,
        input.case_id_to,
        input.link_type,
        now,
        input.created_by,
        input.confidence ?? null,
        reasonJson(input.reason_json),
        sourceKind,
        input.source_ref ?? null,
        fingerprint
      );

    insertMemoryEvent({
      adapter: linkAdapter,
      event_type: 'case.link_created',
      actor: input.created_by,
      case_id: input.case_id_from,
      link_id: linkId,
      reason: {
        case_id_from: input.case_id_from,
        case_id_to: input.case_id_to,
        link_type: input.link_type,
        source_kind: sourceKind,
      },
      now,
    });

    return {
      kind: 'created',
      link_id: linkId,
      source_ref_fingerprint_hex: fingerprint.toString('hex'),
    };
  });
}

export function revokeCaseLink(
  adapter: DatabaseAdapter,
  input: CaseLinkRevokeInput
): CaseLinkRevokeResult {
  const linkAdapter = adapter as unknown as CaseLinkAdapter;

  return runImmediateTransaction(linkAdapter, () => {
    const now = normalizeNow(input.now);
    const raw = linkAdapter
      .prepare('SELECT * FROM case_links WHERE link_id = ?')
      .get(input.link_id) as Record<string, unknown> | undefined;

    if (!raw) {
      return {
        kind: 'rejected',
        code: 'case.case_link_not_found',
        message: `Case link ${input.link_id} was not found.`,
        link_id: input.link_id,
      };
    }

    const row = mapCaseLinkRow(raw);
    if (row.revoked_at !== null) {
      return {
        kind: 'rejected',
        code: 'case.case_link_not_found',
        message: `Case link ${input.link_id} is already revoked.`,
        link_id: input.link_id,
      };
    }

    if (row.source_kind === 'wiki_compiler' && !row.source_ref_fingerprint) {
      return {
        kind: 'rejected',
        code: 'case.wiki_tombstone_fingerprint_missing',
        message: 'Cannot revoke a wiki compiler link without its stored source_ref_fingerprint.',
        link_id: input.link_id,
      };
    }

    const targetRefJson = caseLinkTargetRefJson(row);
    const targetRefHashHex = sha256Hex(targetRefJson);
    const currentValueJson = currentRevokeValueJson(row);
    const canonicalExpectedCurrent = canonicalExpectedJson(input.expected_current_value_json);
    const proposedNewValueJson = canonicalizeJSON({
      link_id: input.link_id,
      revoked_at: now,
      revoked_by: input.revoked_by,
      revoke_reason: input.revoke_reason,
    });

    if (canonicalExpectedCurrent !== null && canonicalExpectedCurrent !== currentValueJson) {
      const token = input.reconfirm_token ?? null;
      if (!token) {
        return buildRequiresReconfirm({
          case_id: row.case_id_from,
          target_ref_json: targetRefJson,
          target_ref_hash_hex: targetRefHashHex,
          current_value_json: currentValueJson,
          old_value_json: input.expected_current_value_json ?? null,
          proposed_new_value_json: proposedNewValueJson,
          confirmed_by: input.revoked_by,
          session_id: input.session_id ?? null,
          now,
        });
      }

      const payload = verifyReconfirmToken({
        token,
        case_id: row.case_id_from,
        target_ref_hash_hex: targetRefHashHex,
        proposed_value_hash_hex: sha256Hex(proposedNewValueJson),
        confirmed_by: input.revoked_by,
        session_id: input.session_id ?? null,
        now,
      });

      if (!payload || payload.current_value_hash_hex !== sha256Hex(currentValueJson)) {
        return buildRequiresReconfirm({
          case_id: row.case_id_from,
          target_ref_json: targetRefJson,
          target_ref_hash_hex: targetRefHashHex,
          current_value_json: currentValueJson,
          old_value_json: input.expected_current_value_json ?? null,
          proposed_new_value_json: proposedNewValueJson,
          confirmed_by: input.revoked_by,
          session_id: input.session_id ?? null,
          now,
        });
      }
    }

    linkAdapter
      .prepare(
        `
          UPDATE case_links
          SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
          WHERE link_id = ?
            AND revoked_at IS NULL
        `
      )
      .run(now, input.revoked_by, input.revoke_reason, input.link_id);

    if (row.source_kind === 'wiki_compiler' && row.source_ref_fingerprint) {
      linkAdapter
        .prepare(
          `
            INSERT OR IGNORE INTO case_links_revoked_wiki_tombstones (
              tombstone_id, case_id_from, case_id_to, link_type, source_ref_fingerprint,
              source_ref, created_at, created_by, revoke_reason, unsuppressed_at,
              unsuppressed_by
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
          `
        )
        .run(
          randomTombstoneId(),
          row.case_id_from,
          row.case_id_to,
          row.link_type,
          row.source_ref_fingerprint,
          row.source_ref ?? `case_link:${row.link_id}`,
          now,
          input.revoked_by,
          input.revoke_reason
        );
    }

    insertMemoryEvent({
      adapter: linkAdapter,
      event_type: 'case.link_revoked',
      actor: input.revoked_by,
      case_id: row.case_id_from,
      link_id: input.link_id,
      reason: {
        case_id_from: row.case_id_from,
        case_id_to: row.case_id_to,
        link_type: row.link_type,
        revoke_reason: input.revoke_reason,
        tombstone_written: row.source_kind === 'wiki_compiler',
      },
      now,
    });

    return { kind: 'revoked', link_id: input.link_id };
  });
}

export function listActiveCaseLinks(
  adapter: DatabaseAdapter,
  caseId: string
): ListActiveCaseLinksResult {
  const linkAdapter = adapter as unknown as CaseLinkAdapter;
  const resolution: CanonicalCaseResolution = resolveCanonicalCaseChain(linkAdapter, caseId);
  const chain = expandCaseChainForAssembly(
    linkAdapter,
    resolution.terminal_case_id,
    resolution.chain
  );
  if (chain.length === 0) {
    return {
      terminal_case_id: resolution.terminal_case_id,
      resolved_via_case_id: resolution.resolved_via_case_id,
      chain,
      links: [],
    };
  }

  const rows = linkAdapter
    .prepare(
      `
        SELECT *
        FROM case_links
        WHERE revoked_at IS NULL
          AND (
            case_id_from IN (${placeholders(chain)})
            OR case_id_to IN (${placeholders(chain)})
          )
        ORDER BY created_at DESC, link_id ASC
      `
    )
    .all(...chain, ...chain) as Array<Record<string, unknown>>;

  return {
    terminal_case_id: resolution.terminal_case_id,
    resolved_via_case_id: resolution.resolved_via_case_id,
    chain,
    links: rows.map(mapCaseLinkRow),
  };
}

export function isWikiTombstoneActive(
  adapter: DatabaseAdapter | CaseLinkAdapter,
  input: { source_case_id: string; target_case_id: string; link_type: CaseLinkType }
): boolean {
  return Boolean(activeTombstoneRow(adapter as unknown as CaseLinkAdapter, input));
}

export function unsuppressWikiTombstone(
  adapter: DatabaseAdapter,
  input: {
    source_case_id: string;
    target_case_id: string;
    link_type: CaseLinkType;
    unsuppressed_by: string;
    now?: string;
  }
): { kind: 'unsuppressed'; unsuppressed_count: number } {
  const linkAdapter = adapter as unknown as CaseLinkAdapter;

  return runImmediateTransaction(linkAdapter, () => ({
    kind: 'unsuppressed',
    unsuppressed_count: unsuppressWikiTombstoneInTransaction(linkAdapter, {
      source_case_id: input.source_case_id,
      target_case_id: input.target_case_id,
      link_type: input.link_type,
      unsuppressed_by: input.unsuppressed_by,
      now: normalizeNow(input.now),
    }),
  }));
}

export function backfillStructuralLinks(adapter: DatabaseAdapter): BackfillStructuralLinksResult {
  const linkAdapter = adapter as unknown as CaseLinkAdapter;

  return runImmediateTransaction(linkAdapter, () => {
    const duplicateResult = linkAdapter
      .prepare(
        `
          INSERT OR IGNORE INTO case_links (
            link_id, case_id_from, case_id_to, link_type, created_at, created_by,
            confidence, reason_json, source_kind, source_ref, source_ref_fingerprint,
            revoked_at, revoked_by, revoke_reason
          )
          SELECT
            'backfill:canonical:' || case_id,
            case_id,
            canonical_case_id,
            'duplicate-of',
            updated_at,
            'system',
            NULL,
            '{"authority":"case_truth.canonical_case_id"}',
            'system_backfill',
            'case_truth.canonical_case_id',
            NULL,
            NULL,
            NULL,
            NULL
          FROM case_truth
          WHERE canonical_case_id IS NOT NULL
            AND canonical_case_id <> case_id
        `
      )
      .run();

    const splitResult = linkAdapter
      .prepare(
        `
          INSERT OR IGNORE INTO case_links (
            link_id, case_id_from, case_id_to, link_type, created_at, created_by,
            confidence, reason_json, source_kind, source_ref, source_ref_fingerprint,
            revoked_at, revoked_by, revoke_reason
          )
          SELECT
            'backfill:split:' || case_id,
            case_id,
            split_from_case_id,
            'subcase-of',
            updated_at,
            'system',
            NULL,
            '{"authority":"case_truth.split_from_case_id"}',
            'system_backfill',
            'case_truth.split_from_case_id',
            NULL,
            NULL,
            NULL,
            NULL
          FROM case_truth
          WHERE split_from_case_id IS NOT NULL
            AND split_from_case_id <> case_id
        `
      )
      .run();

    return {
      duplicate_of_inserted: duplicateResult.changes,
      subcase_of_inserted: splitResult.changes,
    };
  });
}
