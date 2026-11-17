import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActionCall, ActionContext, ActionResult } from '@jungjaehoon/mama-core';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createApprovalStore, type Proposal } from '../../src/runtime/approval-store.js';
import { createApprovalRuntime } from '../../src/runtime/approval-runtime.js';

const homes: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const DAY = 86_400_000;

async function fixture(options: { result?: ActionResult; slow?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mama-approval-runtime-'));
  homes.push(home);
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  databases.push(db);
  const clock = { now: 1_000_000 };
  const store = createApprovalStore(db.adapter, {
    now: () => clock.now,
    nonce: () => 'nonce-fixture',
  });
  const calls: Array<{ call: ActionCall; context: ActionContext }> = [];
  let release: () => void = () => {};
  const dispatch = vi.fn(
    async (call: ActionCall, context: ActionContext): Promise<ActionResult> => {
      calls.push({ call, context });
      if (options.slow) await new Promise<void>((resolve) => (release = resolve));
      return options.result ?? { status: 'completed', data: { id: 'event-1' } };
    }
  );
  const recorded: Array<{ id: string; line: string }> = [];
  const edits: Array<{ id: string; card: string }> = [];
  const owners = new Set(['owner-a', 'owner-b']);
  const runtime = createApprovalRuntime({
    store,
    dispatch,
    accessFor: (principalId) => ({
      principalId: principalId ?? 'owner',
      agentId: 'agent',
      scopes: [],
      actions: ['google.calendar.write'],
    }),
    deciderFor: (_chatId, userId) =>
      ({ u1: 'owner-a', u2: 'owner-b', u3: 'member-c' })[userId] ?? null,
    mayDecide: (proposal, decider) =>
      proposal.principalId === null ? owners.has(decider) : decider === proposal.principalId,
    cardFor: (proposal) => `card ${proposal.id}`,
    record: (proposal, line) => recorded.push({ id: proposal.id, line }),
    editCard: async (proposal, card) => void edits.push({ id: proposal.id, card }),
    now: () => clock.now,
  });
  const input = { op: 'create', event: { summary: 'Fixture', start: {}, end: {} } };
  const propose = (principalId: string | null = null, requestKey = 'k1') =>
    store.propose({
      action: 'google.calendar.write',
      input,
      principalId,
      modelRunId: 'run-1',
      requestKey,
    }).proposal;
  const press = (proposal: Proposal, decision: 'a' | 'r' = 'a', userId = 'u1') =>
    runtime.press({
      data: `apv:${decision}:${proposal.id}:nonce-fixture`,
      chatId: '-100',
      userId,
      messageId: 7,
    });
  return {
    store,
    runtime,
    dispatch,
    calls,
    recorded,
    edits,
    clock,
    input,
    propose,
    press,
    release: () => release(),
    db,
  };
}

describe('approval runtime', () => {
  it('approves, runs the stored input byte-equal, and edits the card with the result', async () => {
    const f = await fixture();
    const proposal = f.propose();
    const result = await f.press(proposal);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.call).toEqual({
      action: 'google.calendar.write',
      input: f.input,
      operationId: proposal.id,
    });
    expect(JSON.stringify(f.calls[0]!.call.input)).toBe(JSON.stringify(f.input));
    expect(f.calls[0]!.context.session?.approvedProposalId).toBe(proposal.id);
    expect(f.store.get(proposal.id)).toMatchObject({ status: 'done', decidedBy: 'owner-a' });
    expect(result.answer).toBe('Approved');
    expect(result.card).toContain(`card ${proposal.id}`);
    expect(result.card).toContain('Done');
  });

  it('runs once when approve is pressed twice at once', async () => {
    const f = await fixture();
    const proposal = f.propose();
    const [first, second] = await Promise.all([f.press(proposal), f.press(proposal, 'a', 'u2')]);
    expect(f.calls).toHaveLength(1);
    expect([first.answer, second.answer].sort()).toEqual(['Already approved', 'Approved']);
  });

  it('runs an approved row after a restart, but not one that was executing', async () => {
    const f = await fixture();
    const approved = f.propose(null, 'k1');
    const executing = f.propose(null, 'k2');
    f.store.decide(approved.id, 'approve', {
      nonce: 'nonce-fixture',
      deciderPrincipalId: 'owner-a',
    });
    f.store.decide(executing.id, 'approve', {
      nonce: 'nonce-fixture',
      deciderPrincipalId: 'owner-a',
    });
    f.store.beginExecution(executing.id);
    await f.runtime.recover();
    expect(f.calls.map(({ call }) => call.operationId)).toEqual([approved.id]);
    expect(f.store.get(executing.id)!.status).toBe('unknown');
    expect(f.edits.find((edit) => edit.id === executing.id)!.card).toContain('not known');
  });

  it('refuses a decider who may not decide and leaves the row', async () => {
    const f = await fixture();
    const common = f.propose(null, 'k1');
    expect((await f.press(common, 'a', 'u3')).answer).toContain('may not decide');
    expect((await f.press(common, 'a', 'u9')).answer).toContain('may not decide');
    const dm = f.propose('owner-b', 'k2');
    expect((await f.press(dm, 'a', 'u1')).answer).toContain('may not decide');
    expect(f.store.get(common.id)!.status).toBe('proposed');
    expect(f.store.get(dm.id)!.status).toBe('proposed');
    expect(f.calls).toEqual([]);
  });

  it('records rejection, expiry and the result through record', async () => {
    const f = await fixture();
    const rejected = f.propose(null, 'k1');
    expect((await f.press(rejected, 'r')).answer).toBe('Rejected');
    const done = f.propose(null, 'k2');
    await f.press(done);
    const late = f.propose(null, 'k3');
    f.clock.now += DAY;
    await f.runtime.sweep();
    expect(f.recorded.map(({ id, line }) => [id, line.split(':')[0]])).toEqual([
      [rejected.id, 'Rejected'],
      [done.id, 'Done'],
      [late.id, 'Expired'],
    ]);
    expect(f.calls).toHaveLength(1);
  });

  it('marks failed and shows the error when the action fails', async () => {
    const f = await fixture({
      result: {
        status: 'failed',
        error: { code: 'denied', message: 'calendar refused' },
      } as ActionResult,
    });
    const proposal = f.propose();
    const result = await f.press(proposal);
    expect(f.store.get(proposal.id)!.status).toBe('failed');
    expect(result.card).toContain('calendar refused');
  });

  it('sweep expires due proposals and edits each card once', async () => {
    const f = await fixture();
    const proposal = f.propose();
    f.clock.now += DAY;
    await f.runtime.sweep();
    await f.runtime.sweep();
    expect(f.edits.filter((edit) => edit.id === proposal.id)).toHaveLength(1);
    expect((await f.press(proposal)).answer).toBe('Already expired');
  });
});
