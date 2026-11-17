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

async function fixture(options: { idLength?: number; failSend?: boolean } = {}) {
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
  const registrations: ActionRegistration[] = [target, uncarded, plain];
  const catalog = createCatalog(registrations);
  const own = approvalActionRegistrations({
    store,
    catalog,
    ownerPrincipalId: 'owner',
    cards: {
      'fixture.write': {
        title: 'Fixture: write',
        render: (input) => [`Text: ${(input as { text: string }).text}`],
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
    actions?: string[]
  ) =>
    dispatch(
      { action: 'approval.propose', input },
      { access: access(principalId, actions), session }
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

  it('stores, sends the card to the common channel for the common session and to the DM for a DM session', async () => {
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
    await propose({ ...call, requestKey: 'k2' }, 'principal_member');
    expect(sent[1]!.principalId).toBe('principal_member');
    expect(store.get('p2')).toMatchObject({ principalId: 'principal_member', chatId: '42' });
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
});
