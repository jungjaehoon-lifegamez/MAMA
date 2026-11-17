import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCatalog,
  createDispatcher,
  type ActionContext,
  type ActionRegistration,
} from '@jungjaehoon/mama-core';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createApprovalStore } from '../../src/runtime/approval-store.js';
import { approvalActionRegistrations } from '../../src/api/approval-actions.js';

const homes: string[] = [];
let contextReads = 0;
let contextFails = false;
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const target: ActionRegistration = {
  contract: {
    name: 'fixture.write',
    summary: 'fixture write',
    approval: 'always',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
  },
  exec: () => ({ ok: true }),
};
const uncarded: ActionRegistration = {
  contract: { ...target.contract, name: 'fixture.uncarded' },
  exec: () => ({}),
};
const plain: ActionRegistration = {
  contract: { ...target.contract, name: 'fixture.plain', approval: undefined },
  exec: () => ({}),
};

async function fixture(
  options: {
    idLength?: number;
    failSend?: boolean;
    readsConnector?: string;
    /** The card takes DM proposals and names an account (P1). */
    personal?: (proposer: string | null) => Promise<{ id: string; line: string }>;
  } = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'mama-propose-'));
  homes.push(home);
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  databases.push(db);
  let id = 0;
  const store = createApprovalStore(db.adapter, {
    id: () => `p${++id}`.padEnd(options.idLength ?? 2, 'x'),
    nonce: () => 'nonce-fixture',
  });
  const sent: Array<{ principalId: string | null; html: string; buttons: unknown }> = [];
  const registrations: ActionRegistration[] = [
    options.readsConnector === undefined
      ? target
      : {
          ...target,
          contract: { ...target.contract, readsConnector: { fixed: options.readsConnector } },
        },
    uncarded,
    plain,
  ];
  const catalog = createCatalog(registrations);
  const own = approvalActionRegistrations({
    store,
    catalog,
    ownerPrincipalId: 'owner',
    cards: {
      'fixture.write': {
        title: 'Fixture: write',
        render: (input) => [`Text: ${(input as { text: string }).text}`],
        context: async (input) => {
          contextReads += 1;
          if ((input as { text: string }).text === 'missing' || contextFails)
            throw new Error('no such event');
          return ['Current: the event as it is now'];
        },
        ...(options.personal === undefined ? {} : { personal: true, account: options.personal }),
      },
    },
    sendCard: async (targetSession, html, buttons) => {
      if (options.failSend) throw new Error('telegram down');
      sent.push({ principalId: targetSession.principalId, html, buttons });
      return { chatId: targetSession.principalId === null ? '-100' : '42', messageId: 7 };
    },
    timeZone: () => 'Asia/Seoul',
  });
  const dispatch = createDispatcher(createCatalog([...registrations, ...own]));
  const access = (
    principalId: string,
    actions = ['approval.propose', 'fixture.write', 'fixture.uncarded', 'fixture.plain']
  ) => ({
    principalId,
    agentId: 'agent',
    scopes: [],
    actions,
  });
  const propose = (
    input: Record<string, unknown>,
    principalId = 'owner',
    session: ActionContext['session'] = { modelRunId: 'run-1' },
    actions?: string[],
    connectors?: string[]
  ) =>
    dispatch(
      { action: 'approval.propose', input },
      {
        access: { ...access(principalId, actions), ...(connectors ? { connectors } : {}) },
        session,
      }
    );
  return { store, sent, propose };
}

const call = { action: 'fixture.write', input: { text: 'hello' }, requestKey: 'k1' };

describe('approval.propose', () => {
  it('refuses an action without approval or without a card', async () => {
    const { propose, sent } = await fixture();
    expect(await propose({ ...call, action: 'fixture.plain' })).toMatchObject({ status: 'failed' });
    expect(await propose({ ...call, action: 'fixture.uncarded' })).toMatchObject({
      status: 'failed',
    });
    expect(sent).toEqual([]);
  });

  it('refuses an action the proposer is not granted', async () => {
    const { propose, sent } = await fixture();
    const result = await propose(call, 'owner', { modelRunId: 'run-1' }, ['approval.propose']);
    expect(result).toMatchObject({ status: 'failed' });
    expect(sent).toEqual([]);
  });

  it('refuses input the action schema refuses, before any row or card', async () => {
    const { propose, sent, store } = await fixture();
    const result = await propose({ ...call, input: { text: 3 } });
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('text') },
    });
    expect(sent).toEqual([]);
    expect(store.get('p1')).toBeNull();
  });

  it('refuses in a replay', async () => {
    const { propose, sent } = await fixture();
    expect(
      await propose(call, 'owner', { modelRunId: 'run-1', replaySourceEndMs: 1 })
    ).toMatchObject({
      status: 'failed',
    });
    expect(sent).toEqual([]);
  });

  it('stores and sends the card to the common channel for the common session', async () => {
    const { propose, sent, store } = await fixture();
    expect(await propose({ ...call, reason: 'asked in a source' })).toMatchObject({
      status: 'completed',
      data: { proposalId: 'p1', state: 'sent', repeated: false },
    });
    expect(sent[0]!.principalId).toBeNull();
    expect(sent[0]!.html).toContain('Fixture: write');
    expect(sent[0]!.html).toContain('Text: hello');
    expect(sent[0]!.html).toContain('Proposed from: asked in a source');
    expect(sent[0]!.buttons).toEqual({
      approve: 'apv:a:p1:nonce-fixture',
      reject: 'apv:r:p1:nonce-fixture',
    });
    expect(store.get('p1')).toMatchObject({ chatId: '-100', messageId: 7, principalId: null });
  });

  it('returns the same receipt for a repeated request key and sends no second card', async () => {
    const { propose, sent } = await fixture();
    await propose(call);
    expect(await propose(call)).toMatchObject({ data: { proposalId: 'p1', repeated: true } });
    expect(sent).toHaveLength(1);
  });

  it('marks the proposal unknown-sent when the card send throws, and says so', async () => {
    const { propose } = await fixture({ failSend: true });
    expect(await propose(call)).toMatchObject({
      status: 'completed',
      data: { proposalId: 'p1', state: 'unknown' },
    });
  });

  it('refuses callback data over 64 bytes', async () => {
    const { propose, sent } = await fixture({ idLength: 60 });
    expect(await propose(call)).toMatchObject({ status: 'failed' });
    expect(sent).toEqual([]);
  });

  it('adds what the write would change, read when proposed, and stores the card as sent', async () => {
    const { propose, sent, store } = await fixture();
    await propose(call);
    expect(sent[0]!.html).toContain('Current: the event as it is now');
    expect(store.get('p1')!.cardHtml).toBe(sent[0]!.html);
    expect(await propose({ ...call, requestKey: 'k2', input: { text: 'missing' } })).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('no such event') },
    });
    expect(sent).toHaveLength(1);
  });

  it('refuses a DM proposal for an action that cannot run on a person’s account (G1)', async () => {
    const { propose, sent } = await fixture();
    expect(await propose(call, 'principal_member')).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('common group') },
    });
    expect(sent).toEqual([]);
  });

  it('returns a repeated proposal before reading the target again', async () => {
    const { propose } = await fixture();
    await propose(call);
    expect(await propose({ ...call })).toMatchObject({ data: { repeated: true } });
    // The target is gone now; the repeat still answers from the stored proposal.
    expect(await propose({ ...call, input: { text: 'missing' }, requestKey: 'k1' })).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('request key') },
    });
  });

  it('refuses a target its connector grant does not cover, before reading it', async () => {
    const { propose, sent } = await fixture({ readsConnector: 'calendar' });
    const reads = contextReads;
    const result = await propose(call, 'owner', { modelRunId: 'run-1' }, undefined, ['slack']);
    // The same refusal a direct call gets.
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'connector_out_of_scope', message: expect.stringContaining('calendar') },
    });
    expect(sent).toEqual([]);
    expect(contextReads).toBe(reads);
    // With the grant, the same proposal reads its target and is sent.
    expect(
      await propose({ ...call, requestKey: 'k2' }, 'owner', { modelRunId: 'run-1' }, undefined, [
        'calendar',
      ])
    ).toMatchObject({ status: 'completed', data: { state: 'sent' } });
    expect(contextReads).toBe(reads + 1);
  });

  it('answers an identical repeat from the store even when the target can no longer be read', async () => {
    const { propose } = await fixture();
    contextFails = false;
    await propose(call);
    const reads = contextReads;
    contextFails = true;
    expect(await propose(call)).toMatchObject({ status: 'completed', data: { repeated: true } });
    expect(contextReads).toBe(reads);
    contextFails = false;
  });

  it('refuses a card Telegram could not show, before any row or card (S1, S2)', async () => {
    const { propose, sent, store } = await fixture();
    const result = await propose({ ...call, input: { text: '<&>'.repeat(1300) } });
    expect(result).toMatchObject({
      status: 'failed',
      error: {
        kind: 'invalid_input',
        message: expect.stringMatching(/card would be \d+ characters.*at most 3596/),
      },
    });
    expect(sent).toEqual([]);
    expect(store.get('p1')).toBeNull();
    // Escaping does not count: Telegram counts the text it shows.
    const fits = await propose({ ...call, requestKey: 'k2', input: { text: '<&>'.repeat(1100) } });
    expect(fits).toMatchObject({ status: 'completed' });
  });

  it('sends a DM proposal to that DM, naming and storing the person’s account (A5, P1)', async () => {
    const { propose, sent, store } = await fixture({
      personal: async (proposer) => ({ id: `acct-${String(proposer)}`, line: 'Posts as: you' }),
    });
    expect(await propose(call, 'principal_member')).toMatchObject({ status: 'completed' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.principalId).toBe('principal_member');
    expect(sent[0]!.html).toContain('Posts as: you');
    expect(store.get('p1')).toMatchObject({
      principalId: 'principal_member',
      accountId: 'acct-principal_member',
    });
  });

  it('refuses a proposal whose account is not connected, before any row or card', async () => {
    const { propose, sent, store } = await fixture({
      personal: async () => {
        throw Object.assign(new Error('Your Fixture account is not connected'), {
          name: 'account_not_connected',
        });
      },
    });
    expect(await propose(call, 'principal_member')).toMatchObject({
      status: 'failed',
      error: { kind: 'denied', message: expect.stringContaining('not connected') },
    });
    expect(sent).toEqual([]);
    expect(store.get('p1')).toBeNull();
  });
});
