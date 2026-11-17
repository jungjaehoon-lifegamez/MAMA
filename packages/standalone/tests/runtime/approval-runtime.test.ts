import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActionCall, ActionContext, ActionResult } from '@jungjaehoon/mama-core';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createApprovalStore, type Proposal } from '../../src/runtime/approval-store.js';
import { createApprovalRuntime, OUTCOME_UNKNOWN } from '../../src/runtime/approval-runtime.js';

const homes: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const DAY = 86_400_000;

async function fixture(
  options: {
    result?: ActionResult;
    slow?: boolean;
    editFails?: Set<string>;
    recordFails?: Set<string>;
  } = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'mama-approval-runtime-'));
  homes.push(home);
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  databases.push(db);
  const clock = { now: 1_000_000 };
  let nextId = 0;
  const store = createApprovalStore(db.adapter, {
    id: () => `proposal-${++nextId}`,
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
  const logged: string[] = [];
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
    record: (proposal, line) => {
      if (options.recordFails?.has(proposal.id)) throw new Error('database is locked');
      recorded.push({ id: proposal.id, line });
    },
    editCard: async (proposal, card) => {
      if (options.editFails?.has(proposal.id)) throw new Error('message to edit not found');
      edits.push({ id: proposal.id, card });
    },
    log: (line) => logged.push(line),
    nameOf: (principalId) => ({ 'owner-a': 'Owner A' })[principalId] ?? principalId,
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
    logged,
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

  it('runs nothing at a restart: an executing row is unknown, an approved one is not run', async () => {
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
    expect(f.calls).toEqual([]);
    expect(f.store.get(executing.id)!.status).toBe('unknown');
    expect(f.store.get(approved.id)!.status).toBe('failed');
    expect(f.edits.find((edit) => edit.id === approved.id)!.card).toMatch(/propose it again/i);
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

  it('escapes the result and the failure it shows on the card', async () => {
    const f = await fixture({
      result: { status: 'completed', data: { summary: 'Review <draft> & Q' } },
    });
    const done = await f.press(f.propose(null, 'k1'));
    expect(done.card).toContain('Review &lt;draft&gt; &amp; Q');
    expect(done.card).not.toContain('<draft>');
    const g = await fixture({
      result: { status: 'failed', error: { code: 'x', message: 'bad <tag>' } } as ActionResult,
    });
    const failed = await g.press(g.propose(null, 'k1'));
    expect(failed.card).toContain('bad &lt;tag&gt;');
  });

  it('keeps recovering and sweeping when one card cannot be edited', async () => {
    const g = await fixture({ editFails: new Set(['proposal-1']) });
    const a = g.propose(null, 'k1');
    const b = g.propose(null, 'k2');
    g.clock.now += DAY;
    await g.runtime.sweep();
    expect(g.edits.map((edit) => edit.id)).toEqual([b.id]);
    expect(g.logged.join('\n')).toContain(a.id);
  });

  it('repairs a stale card from the stored outcome on a later press', async () => {
    const f = await fixture();
    const proposal = f.propose();
    await f.press(proposal);
    const again = await f.press(proposal, 'a', 'u2');
    expect(again.answer).toBe('Already approved');
    expect(again.card).toContain('Done');
    expect(f.calls).toHaveLength(1);
  });

  it('keeps an unknown outcome unknown, never failed', async () => {
    const f = await fixture({
      result: {
        status: 'unknown',
        error: { code: 'timeout', message: 'no answer from Google' },
      } as ActionResult,
    });
    const proposal = f.propose();
    const result = await f.press(proposal);
    expect(f.store.get(proposal.id)!.status).toBe('unknown');
    expect(result.card).toContain('Unknown');
    expect(result.card).toContain('no answer from Google');
  });

  it('keeps sweeping when recording one outcome fails', async () => {
    const f = await fixture({ recordFails: new Set(['proposal-1']) });
    const a = f.propose(null, 'k1');
    const b = f.propose(null, 'k2');
    f.clock.now += DAY;
    await f.runtime.sweep();
    // The note failed; the card is still edited, and the next one too.
    expect(f.edits.map((edit) => edit.id)).toEqual([a.id, b.id]);
    expect(f.logged.join('\n')).toContain(a.id);
  });

  it('still edits the card when recording an approved or rejected outcome fails', async () => {
    const f = await fixture({ recordFails: new Set(['proposal-1', 'proposal-2']) });
    const approved = await f.press(f.propose(null, 'k1'));
    expect(approved.answer).toBe('Approved');
    expect(approved.card).toContain('Done');
    const rejected = await f.press(f.propose(null, 'k2'), 'r');
    expect(rejected.answer).toBe('Rejected');
    expect(rejected.card).toContain('Rejected');
    expect(f.logged.join('\n')).toContain('proposal-1 outcome note failed');
    expect(f.logged.join('\n')).toContain('proposal-2 outcome note failed');
  });

  it('names the decider on the card and in the note, and keeps the id on the row', async () => {
    const f = await fixture();
    const approved = await f.press(f.propose(null, 'k1'));
    expect(approved.card).toContain('Done: approved by Owner A.');
    const rejected = await f.press(f.propose(null, 'k2'), 'r');
    expect(rejected.card).toContain('Rejected: by Owner A.');
    expect(f.recorded.map((entry) => entry.line)).toEqual([
      expect.stringContaining('approved by Owner A'),
      'Rejected: by Owner A.',
    ]);
    expect(f.store.get('proposal-1')!.decidedBy).toBe('owner-a');
    // A person with no name is shown by id; a repaired card names the decider too.
    const again = await f.press(f.propose(null, 'k3'), 'a', 'u2');
    expect(again.card).toContain('approved by owner-b');
    expect((await f.press(f.store.get('proposal-1')!, 'a', 'u2')).card).toContain(
      'approved by Owner A'
    );
  });

  it('settles the row before naming the decider', async () => {
    const f = await fixture();
    const proposal = f.propose();
    const names = vi.fn(() => {
      throw new Error('principal read failed');
    });
    const runtime = createApprovalRuntime({
      store: f.store,
      dispatch: f.dispatch,
      accessFor: () => ({ principalId: 'owner', agentId: 'agent', scopes: [], actions: [] }),
      deciderFor: () => 'owner-a',
      mayDecide: () => true,
      cardFor: () => 'card',
      record: () => {},
      editCard: async () => {},
      log: () => {},
      nameOf: names,
    });
    await expect(
      runtime.press({
        data: `apv:a:${proposal.id}:nonce-fixture`,
        chatId: '-100',
        userId: 'u1',
        messageId: 7,
      })
    ).rejects.toThrow('principal read failed');
    expect(f.store.get(proposal.id)!.status).toBe('done');
    expect(f.calls).toHaveLength(1);
  });

  it('names the decider when it repairs an unknown card', async () => {
    const f = await fixture({
      result: {
        status: 'unknown',
        error: { code: 'timeout', message: 'no answer' },
      } as ActionResult,
    });
    const proposal = f.propose();
    await f.press(proposal);
    const again = await f.press(proposal, 'a', 'u2');
    expect(again.card).toContain('Unknown: approved by Owner A;');
  });

  it('reports unknown, never failed, when the call throws after it may have written', async () => {
    const f = await fixture();
    f.dispatch.mockImplementationOnce(async () => {
      throw new Error('operation receipt could not be written');
    });
    const proposal = f.propose();
    const result = await f.press(proposal);
    expect(f.store.get(proposal.id)!.status).toBe('unknown');
    expect(result.card).toContain('Unknown');
  });

  it('stores unknown when the action says its write may have happened', async () => {
    const f = await fixture({
      result: {
        status: 'failed',
        error: {
          kind: 'internal',
          code: OUTCOME_UNKNOWN,
          message: 'Chatwork did not answer; the message may have been posted',
        },
      } as ActionResult,
    });
    const proposal = f.propose();
    const result = await f.press(proposal);
    expect(f.store.get(proposal.id)!.status).toBe('unknown');
    expect(result.card).toContain('Unknown');
    expect(result.card).toContain('may have been posted');
  });
});
