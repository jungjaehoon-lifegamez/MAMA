import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  ApprovalConflictError,
  ApprovalRefusedError,
  createApprovalStore,
} from '../../src/runtime/approval-store.js';

const homes: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];

afterEach(async () => {
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function database() {
  const home = mkdtempSync(join(tmpdir(), 'mama-approvals-'));
  homes.push(home);
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  databases.push(db);
  return db.adapter;
}

const DAY = 86_400_000;

async function store(clock = { now: 1_000_000 }) {
  let id = 0;
  let nonce = 0;
  const adapter = await database();
  return {
    adapter,
    clock,
    store: createApprovalStore(adapter, {
      now: () => clock.now,
      id: () => `proposal-${++id}`,
      nonce: () => `nonce-value-${++nonce}`,
    }),
  };
}

const proposal = {
  action: 'google.calendar.write',
  input: { op: 'create', event: { summary: 'Fixture', start: {}, end: {} } },
  principalId: null,
  modelRunId: 'run-1',
  requestKey: 'book-1',
};

describe('approval store', () => {
  it('stores a proposal with a 24-hour expiry and a fingerprint of action and input', async () => {
    const { store: s } = await store();
    const { proposal: stored, nonce, repeated } = s.propose(proposal);
    expect(repeated).toBe(false);
    expect(nonce).toBe('nonce-value-1');
    expect(stored).toMatchObject({ id: 'proposal-1', status: 'proposed', principalId: null });
    expect(stored.expiresAt).toBe(1_000_000 + DAY);
    const other = s.propose({
      ...proposal,
      requestKey: 'book-2',
      input: { event: { end: {}, start: {}, summary: 'Fixture' }, op: 'create' },
    });
    expect(other.proposal.fingerprint).toBe(stored.fingerprint);
  });

  it('returns the same row for a repeated request key and refuses a changed one', async () => {
    const { store: s } = await store();
    const first = s.propose(proposal);
    const again = s.propose(proposal);
    expect(again.repeated).toBe(true);
    expect(again.proposal.id).toBe(first.proposal.id);
    expect(() => s.propose({ ...proposal, input: { op: 'delete', eventId: 'x' } })).toThrow(
      ApprovalConflictError
    );
  });

  it('moves each status once, only from its predecessor', async () => {
    const { store: s } = await store();
    const { proposal: p, nonce } = s.propose(proposal);
    expect(() => s.beginExecution(p.id)).toThrow();
    s.decide(p.id, 'approve', { nonce, deciderPrincipalId: 'owner-a' });
    expect(() => s.decide(p.id, 'approve', { nonce, deciderPrincipalId: 'owner-b' })).toThrow(
      expect.objectContaining({ reason: 'already_approved' })
    );
    expect(() => s.decide(p.id, 'reject', { nonce, deciderPrincipalId: 'owner-b' })).toThrow(
      expect.objectContaining({ reason: 'already_approved' })
    );
    expect(s.get(p.id)).toMatchObject({ decidedBy: 'owner-a', status: 'approved' });
    expect(s.beginExecution(p.id).status).toBe('executing');
    expect(() => s.beginExecution(p.id)).toThrow();
    expect(s.finish(p.id, { ok: true, result: { id: 'event' } })).toMatchObject({
      status: 'done',
      result: { id: 'event' },
    });
    expect(() => s.finish(p.id, { ok: false, error: 'late' })).toThrow();
  });

  it('refuses a wrong nonce, timing-safe, and an expired proposal', async () => {
    const { store: s, clock } = await store();
    const { proposal: p, nonce } = s.propose(proposal);
    expect(() =>
      s.decide(p.id, 'approve', { nonce: 'nonce-value-9', deciderPrincipalId: 'o' })
    ).toThrow(expect.objectContaining({ reason: 'wrong_nonce' }));
    expect(() => s.decide('missing', 'approve', { nonce, deciderPrincipalId: 'o' })).toThrow(
      ApprovalRefusedError
    );
    clock.now += DAY;
    expect(() => s.decide(p.id, 'approve', { nonce, deciderPrincipalId: 'o' })).toThrow(
      expect.objectContaining({ reason: 'expired' })
    );
    expect(s.get(p.id)!.status).toBe('proposed');
  });

  it('marks executing rows unknown at open and never returns them to approved', async () => {
    const { store: s, adapter } = await store();
    const { proposal: p, nonce } = s.propose(proposal);
    s.decide(p.id, 'approve', { nonce, deciderPrincipalId: 'o' });
    s.beginExecution(p.id);
    const reopened = createApprovalStore(adapter, { now: () => 2_000_000 });
    expect(reopened.markInterrupted().map((row) => row.id)).toEqual([p.id]);
    expect(reopened.get(p.id)!.status).toBe('unknown');
    expect(() => reopened.beginExecution(p.id)).toThrow();
    expect(reopened.markInterrupted()).toEqual([]);
  });

  it('expires due proposals once', async () => {
    const { store: s, clock } = await store();
    const { proposal: p } = s.propose(proposal);
    expect(s.expireDue()).toEqual([]);
    clock.now += DAY;
    expect(s.expireDue().map((row) => row.id)).toEqual([p.id]);
    expect(s.get(p.id)!.status).toBe('expired');
    expect(s.expireDue()).toEqual([]);
  });
});
