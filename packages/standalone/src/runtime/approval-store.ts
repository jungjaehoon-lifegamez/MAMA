/**
 * Proposals for writes the agent may not run alone (docs/development/work/approvals.md, A1). The
 * agent proposes; an owner decides in Telegram; the host runs the stored input once. Each status
 * moves once, from its predecessor only, in one guarded UPDATE. A row left executing when the
 * store opens is unknown: whether the write happened is not known, so it is never run again.
 * The mechanism is nh's order approval: a fingerprint of what runs and a one-time nonce on the
 * button, compared timing-safe.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';

export type ProposalStatus =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executing'
  | 'done'
  | 'failed'
  | 'unknown';

export interface Proposal {
  id: string;
  action: string;
  input: unknown;
  fingerprint: string;
  status: ProposalStatus;
  /** The proposing DM session's person; null for the common session. */
  principalId: string | null;
  modelRunId: string | null;
  requestKey: string;
  reason: string | null;
  sourceRefs: string[];
  /** The card as the owner was shown it. */
  cardHtml: string | null;
  chatId: string | null;
  messageId: number | null;
  createdAt: number;
  expiresAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  result: unknown;
}

export interface ProposalInput {
  action: string;
  input: unknown;
  principalId: string | null;
  modelRunId: string | null;
  requestKey: string;
  reason?: string;
  sourceRefs?: readonly string[];
}

export type ApprovalRefusal = 'wrong_nonce' | 'expired' | 'unknown_proposal' | `already_${string}`;

export class ApprovalRefusedError extends Error {
  constructor(readonly reason: ApprovalRefusal) {
    super(`approval refused: ${reason}`);
    this.name = 'ApprovalRefusedError';
  }
}

export class ApprovalConflictError extends Error {
  constructor(requestKey: string) {
    super(`request key ${requestKey} was already used for a different proposal in this run`);
    this.name = 'ApprovalConflictError';
  }
}

export const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function proposalFingerprint(action: string, input: unknown): string {
  return createHash('sha256').update(canonical({ action, input })).digest('hex');
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

interface Row {
  id: string;
  action: string;
  input_json: string;
  fingerprint: string;
  nonce_hash: string;
  status: ProposalStatus;
  principal_id: string | null;
  model_run_id: string | null;
  request_key: string;
  reason: string | null;
  source_refs_json: string;
  card_html: string | null;
  chat_id: string | null;
  message_id: number | null;
  created_at: number;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  result_json: string | null;
}

function toProposal(row: Row): Proposal {
  return {
    id: row.id,
    action: row.action,
    input: JSON.parse(row.input_json),
    fingerprint: row.fingerprint,
    status: row.status,
    principalId: row.principal_id,
    modelRunId: row.model_run_id,
    requestKey: row.request_key,
    reason: row.reason,
    sourceRefs: JSON.parse(row.source_refs_json) as string[],
    cardHtml: row.card_html,
    chatId: row.chat_id,
    messageId: row.message_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
  };
}

export interface ApprovalStore {
  propose(input: ProposalInput): { proposal: Proposal; nonce: string; repeated: boolean };
  setCardHtml(id: string, html: string): void;
  setCard(id: string, chatId: string, messageId: number): void;
  get(id: string): Proposal | null;
  /** The proposal this run already made under this request key, if any. */
  find(modelRunId: string | null, requestKey: string): Proposal | null;
  decide(
    id: string,
    decision: 'approve' | 'reject',
    proof: { nonce: string; deciderPrincipalId: string }
  ): Proposal;
  beginExecution(id: string): Proposal;
  finish(
    id: string,
    outcome: { ok: true; result: unknown } | { ok: false; error: string }
  ): Proposal;
  /** Approved rows whose execution never began: run them, once. */
  approvedNotStarted(): Proposal[];
  expireDue(): Proposal[];
  markInterrupted(): Proposal[];
}

export function createApprovalStore(
  adapter: DatabaseAdapter,
  options: { now?: () => number; id?: () => string; nonce?: () => string } = {}
): ApprovalStore {
  const now = options.now ?? Date.now;
  const newId = options.id ?? randomUUID;
  const newNonce = options.nonce ?? (() => randomBytes(9).toString('base64url'));
  const row = (id: string) =>
    adapter.prepare('SELECT * FROM approval_proposals WHERE id = ?').get(id) as Row | undefined;
  const must = (id: string): Proposal => {
    const found = row(id);
    if (!found) throw new ApprovalRefusedError('unknown_proposal');
    return toProposal(found);
  };
  /** One guarded transition: it changes the row only from `from`, or throws. */
  const move = (id: string, from: ProposalStatus, set: string, values: unknown[]): Proposal => {
    const changed = adapter
      .prepare(`UPDATE approval_proposals SET ${set} WHERE id = ? AND status = ?`)
      .run(...values, id, from);
    if (Number(changed.changes) !== 1)
      throw new Error(`proposal ${id} is ${row(id)?.status ?? 'missing'}, not ${from}`);
    return must(id);
  };

  return {
    propose(input) {
      const fingerprint = proposalFingerprint(input.action, input.input);
      const existing = adapter
        .prepare('SELECT * FROM approval_proposals WHERE model_run_id IS ? AND request_key = ?')
        .get(input.modelRunId, input.requestKey) as Row | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ApprovalConflictError(input.requestKey);
        // The nonce is only ever known at proposal; a repeat gets the same card, not a new nonce.
        return { proposal: toProposal(existing), nonce: '', repeated: true };
      }
      const id = newId();
      const nonce = newNonce();
      const at = now();
      adapter
        .prepare(
          `INSERT INTO approval_proposals (id, action, input_json, fingerprint, nonce_hash, status,
             principal_id, model_run_id, request_key, reason, source_refs_json, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.action,
          JSON.stringify(input.input),
          fingerprint,
          hash(nonce).toString('hex'),
          input.principalId,
          input.modelRunId,
          input.requestKey,
          input.reason ?? null,
          JSON.stringify(input.sourceRefs ?? []),
          at,
          at + APPROVAL_EXPIRY_MS
        );
      return { proposal: must(id), nonce, repeated: false };
    },
    setCardHtml(id, html) {
      adapter.prepare('UPDATE approval_proposals SET card_html = ? WHERE id = ?').run(html, id);
    },
    setCard(id, chatId, messageId) {
      adapter
        .prepare('UPDATE approval_proposals SET chat_id = ?, message_id = ? WHERE id = ?')
        .run(chatId, messageId, id);
    },
    get(id) {
      const found = row(id);
      return found ? toProposal(found) : null;
    },
    find(modelRunId, requestKey) {
      const found = adapter
        .prepare('SELECT * FROM approval_proposals WHERE model_run_id IS ? AND request_key = ?')
        .get(modelRunId, requestKey) as Row | undefined;
      return found ? toProposal(found) : null;
    },
    decide(id, decision, proof) {
      const found = row(id);
      if (!found) throw new ApprovalRefusedError('unknown_proposal');
      if (!timingSafeEqual(Buffer.from(found.nonce_hash, 'hex'), hash(proof.nonce)))
        throw new ApprovalRefusedError('wrong_nonce');
      if (found.status !== 'proposed') throw new ApprovalRefusedError(`already_${found.status}`);
      if (now() >= found.expires_at) throw new ApprovalRefusedError('expired');
      const changed = adapter
        .prepare(
          `UPDATE approval_proposals SET status = ?, decided_by = ?, decided_at = ?
            WHERE id = ? AND status = 'proposed'`
        )
        .run(decision === 'approve' ? 'approved' : 'rejected', proof.deciderPrincipalId, now(), id);
      // Another press won the race between the read and this write.
      if (Number(changed.changes) !== 1)
        throw new ApprovalRefusedError(`already_${row(id)!.status}`);
      return must(id);
    },
    beginExecution(id) {
      return move(id, 'approved', 'status = ?', ['executing']);
    },
    finish(id, outcome) {
      return move(id, 'executing', 'status = ?, result_json = ?', [
        outcome.ok ? 'done' : 'failed',
        JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
      ]);
    },
    approvedNotStarted() {
      return (
        adapter
          .prepare("SELECT * FROM approval_proposals WHERE status = 'approved' ORDER BY created_at")
          .all() as Row[]
      ).map(toProposal);
    },
    expireDue() {
      const due = adapter
        .prepare(
          "SELECT id FROM approval_proposals WHERE status = 'proposed' AND expires_at <= ? ORDER BY created_at"
        )
        .all(now()) as Array<{ id: string }>;
      return due.flatMap(({ id }) => {
        try {
          return [move(id, 'proposed', 'status = ?', ['expired'])];
        } catch {
          return []; // decided between the read and the write
        }
      });
    },
    markInterrupted() {
      const interrupted = adapter
        .prepare("SELECT id FROM approval_proposals WHERE status = 'executing'")
        .all() as Array<{ id: string }>;
      return interrupted.map(({ id }) =>
        move(id, 'executing', 'status = ?, result_json = ?', [
          'unknown',
          JSON.stringify({
            error: 'the daemon restarted while this ran; whether it happened is not known',
          }),
        ])
      );
    },
  };
}
