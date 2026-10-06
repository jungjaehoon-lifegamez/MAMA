import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge, type Knowledge } from '../../src/knowledge/index.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';
import { createCatalog, coreActionRegistrations } from '../../src/api/catalog.js';
import { createDispatcher, type ActionDispatcher } from '../../src/api/dispatch.js';
import { createNode, currentIdentityRevision, resolveAlias } from '../../src/registry/store.js';
import type { IdentityCorrectionReceipt } from '../../src/memory/judgment-types.js';

const SCOPE = { kind: 'project' as const, id: 'scope-identity' };
const ACCESS = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [SCOPE] as MemoryScopeRef[],
  connectors: ['slack'],
  // The grant this test stands on: exactly the actions it calls.
  actions: ['graph.identity.correct', 'graph.node.put'],
};

describe('Story R2: graph.identity.correct through the action surface', () => {
  let dbPath = '';
  let knowledge: Knowledge;
  let dispatch: ActionDispatcher;

  beforeAll(async () => {
    dbPath = await initTestDB('identity-actions');
    knowledge = createKnowledge({ adapter: getAdapter(), embedder: null });
    dispatch = createDispatcher(createCatalog(coreActionRegistrations(knowledge, getAdapter())));
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM registry_ref_assignments').run();
    db.prepare('DELETE FROM registry_corrections').run();
    db.prepare('DELETE FROM registry_aliases').run();
    db.prepare('DELETE FROM registry_scope_bindings').run();
    db.prepare('DELETE FROM registry_nodes').run();
    db.prepare('UPDATE registry_identity_state SET revision=0 WHERE singleton=1').run();
    db.prepare('DELETE FROM twin_edges').run();
    db.prepare('DELETE FROM command_bindings').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('an add_alias correction lands in the registry transaction', async () => {
    const nodeId = createNode(getAdapter(), {
      kind: 'item',
      name: 'original label',
      scopes: [SCOPE],
    });
    const result = await dispatch(
      {
        action: 'graph.identity.correct',
        operationId: 'op-correct-1',
        input: {
          expectedRevision: currentIdentityRevision(getAdapter()),
          reason: 'the owner calls it this',
          operation: 'add_alias',
          nodeId,
          alias: 'corrected label',
          scopes: [SCOPE],
        },
      },
      { access: ACCESS }
    );
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const receipt = result.data as IdentityCorrectionReceipt;
    expect(receipt.commandId).toBe('op-correct-1');
    expect(receipt.identityRevision).toBe(1);
    expect(resolveAlias(getAdapter(), 'corrected label', 'item', [SCOPE])?.id).toBe(nodeId);
  });

  it('replays a retried correction to the same receipt', async () => {
    const nodeId = createNode(getAdapter(), {
      kind: 'item',
      name: 'retry target',
      scopes: [SCOPE],
    });
    const input = {
      expectedRevision: 0,
      reason: 'same call twice',
      operation: 'add_alias' as const,
      nodeId,
      alias: 'retry alias',
      scopes: [SCOPE],
    };
    const first = await dispatch(
      { action: 'graph.identity.correct', operationId: 'op-correct-retry', input },
      { access: ACCESS }
    );
    const retry = await dispatch(
      { action: 'graph.identity.correct', operationId: 'op-correct-retry', input },
      { access: ACCESS }
    );
    expect(first.status).toBe('completed');
    expect(retry.status).toBe('completed');
    if (first.status !== 'completed' || retry.status !== 'completed') return;
    expect(retry.data).toEqual(first.data);
    const rows = getAdapter()
      .prepare('SELECT COUNT(*) AS n FROM registry_corrections WHERE command_id = ?')
      .get('op-correct-retry') as { n: number };
    expect(rows.n).toBe(1);
  });

  it('a retry with a different payload is a conflict, not a second write', async () => {
    const nodeId = createNode(getAdapter(), {
      kind: 'item',
      name: 'conflict target',
      scopes: [SCOPE],
    });
    const base = {
      expectedRevision: 0,
      reason: 'first shape',
      operation: 'add_alias' as const,
      nodeId,
      alias: 'first alias',
      scopes: [SCOPE],
    };
    await dispatch(
      { action: 'graph.identity.correct', operationId: 'op-correct-conflict', input: base },
      { access: ACCESS }
    );
    const conflict = await dispatch(
      {
        action: 'graph.identity.correct',
        operationId: 'op-correct-conflict',
        input: { ...base, alias: 'a different alias', reason: 'changed shape' },
      },
      { access: ACCESS }
    );
    expect(conflict.status).toBe('failed');
    if (conflict.status === 'failed') {
      expect(conflict.error.code).toBe('COMMAND_CONFLICT');
    }
  });

  it('rejects an explicitly empty scopes array before the transaction opens', async () => {
    // Omitting scopes means "use the authority's". Sending [] means something
    // else, and it is not a thing a correction can do. The store refuses it too
    // ('At least one effective scope is required'); the contract's minItems
    // refuses it first, which is what the deleted tool schema did.
    const result = await dispatch(
      {
        action: 'graph.identity.correct',
        operationId: 'op-empty-scopes',
        input: {
          expectedRevision: currentIdentityRevision(getAdapter()),
          reason: 'empty scopes is not an authority',
          operation: 'add_alias',
          nodeId: 'reg_whatever',
          alias: 'must not be written',
          scopes: [],
        },
      },
      { access: ACCESS }
    );

    // The refusal is invalid_input, which is the claim. The specific message
    // does not survive: identityCorrectSchema is a oneOf, so a variant that
    // fails any constraint reports only that no shape matched.
    expect(result.error).toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects malformed input before the registry is touched', async () => {
    const bad = await dispatch(
      {
        action: 'graph.identity.correct',
        operationId: 'op-correct-bad',
        input: {
          expectedRevision: 0,
          reason: 'merge needs its own fields',
          operation: 'merge',
          survivorId: 'item_x',
        },
      },
      { access: ACCESS }
    );
    expect(bad.status).toBe('failed');
    if (bad.status === 'failed') {
      expect(bad.error.kind).toBe('invalid_input');
    }
  });

  it('scopes outside the caller authority are denied, not written', async () => {
    const nodeId = createNode(getAdapter(), {
      kind: 'item',
      name: 'scope guard target',
      scopes: [SCOPE],
    });
    const denied = await dispatch(
      {
        action: 'graph.identity.correct',
        operationId: 'op-correct-scope',
        input: {
          expectedRevision: 0,
          reason: 'must not widen beyond the caller',
          operation: 'add_alias',
          nodeId,
          alias: 'widened',
          scopes: [{ kind: 'project', id: 'scope-not-mine' }],
        },
      },
      { access: ACCESS }
    );
    expect(denied.status).toBe('failed');
    if (denied.status === 'failed') {
      expect(denied.error.code).toBe('scope_denied');
    }
    expect(resolveAlias(getAdapter(), 'widened', 'item', [SCOPE])).toBeNull();
  });
});

describe('Story R3: graph.node.put through the action surface', () => {
  let dbPath = '';
  let knowledge: Knowledge;
  let dispatch: ActionDispatcher;

  beforeAll(async () => {
    dbPath = await initTestDB('node-put-actions');
    knowledge = createKnowledge({ adapter: getAdapter(), embedder: null });
    dispatch = createDispatcher(createCatalog(coreActionRegistrations(knowledge, getAdapter())));
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM registry_aliases').run();
    db.prepare('DELETE FROM registry_scope_bindings').run();
    db.prepare('DELETE FROM registry_nodes').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('creates a node bound to the caller authority scopes', async () => {
    const result = await dispatch(
      {
        action: 'graph.node.put',
        operationId: 'op-put-1',
        input: { kind: 'item', name: 'alpha item', aliases: ['a_0001'] },
      },
      { access: ACCESS }
    );

    expect(result.status).toBe('completed');
    const data = result.data as { id: string; created: boolean };
    expect(data.created).toBe(true);
    expect(resolveAlias(getAdapter(), 'a_0001', 'item', [SCOPE])?.id).toBe(data.id);
    // The node answers to the authority's scope, not to a scope-free lookup.
    expect(resolveAlias(getAdapter(), 'a_0001', 'item', [])).toBeNull();
  });

  it('refuses a put whose authority states no scope', async () => {
    // The node would be bound to nothing. Whether that then reads as invisible
    // or as unfiltered is the reader's accident, so the put is refused rather
    // than left to it. The host tool case that used to call this action said
    // the same thing one layer out ('registry_scope_denied'), which left a
    // caller reaching the action directly with no such rule at all.
    const result = await dispatch(
      {
        action: 'graph.node.put',
        operationId: 'op-put-unscoped',
        input: { kind: 'item', name: 'unscoped item', aliases: ['unscoped-alias'] },
      },
      { access: { ...ACCESS, scopes: [] } }
    );

    expect(result.error).toMatchObject({ code: 'INVALID_SCOPE' });
    expect(resolveAlias(getAdapter(), 'unscoped-alias', 'item', [SCOPE])).toBeNull();
  });

  it('a retried put resolves to the same node — alias idempotency, not a command receipt', async () => {
    const first = await dispatch(
      {
        action: 'graph.node.put',
        operationId: 'op-put-retry-1',
        input: { kind: 'item', name: 'same name', aliases: ['retry-alias'] },
      },
      { access: ACCESS }
    );
    const retry = await dispatch(
      {
        action: 'graph.node.put',
        operationId: 'op-put-retry-2',
        input: { kind: 'item', name: 'same name', aliases: ['retry-alias', 'second-alias'] },
      },
      { access: ACCESS }
    );

    expect(first.status).toBe('completed');
    expect(retry.status).toBe('completed');
    const firstData = (first as { data: { id: string; created: boolean } }).data;
    const retryData = (retry as { data: { id: string; created: boolean } }).data;
    expect(firstData.created).toBe(true);
    expect(retryData.created).toBe(false);
    expect(retryData.id).toBe(firstData.id);
    expect(resolveAlias(getAdapter(), 'second-alias', 'item', [SCOPE])?.id).toBe(firstData.id);
  });

  it('refuses an alias another node already holds instead of reassigning it', async () => {
    // Two nodes claiming one spelling is an identity question, and the answer
    // is a merge correction someone decides on - never a silent reassignment
    // by whichever put ran second. This was pinned against a MOCKED dispatch in
    // the host tool test that is now deleted, which only ever proved the
    // deleted layer forwarded the code. Here it is the store answering.
    const first = await dispatch(
      {
        action: 'graph.node.put',
        operationId: 'op-alias-owner',
        input: { kind: 'item', name: 'alias owner', aliases: ['contested-alias'] },
      },
      { access: ACCESS }
    );
    expect(first.status).toBe('completed');

    const second = await dispatch(
      {
        action: 'graph.node.put',
        operationId: 'op-alias-claimant',
        input: { kind: 'item', name: 'alias claimant', aliases: ['contested-alias'] },
      },
      { access: ACCESS }
    );
    expect(second.error).toMatchObject({ code: 'alias_taken' });
    // The spelling still answers to the node that held it.
    expect(resolveAlias(getAdapter(), 'contested-alias', 'item', [SCOPE])?.id).toBe(
      (first as { data: { id: string } }).data.id
    );
  });

  it.each([[''], ['valid', ''], ['   \t']])(
    'rejects a blank alias in %j before the registry is touched',
    async (...aliases) => {
      const result = await dispatch(
        {
          action: 'graph.node.put',
          operationId: 'op-blank-alias',
          input: { kind: 'item', name: 'blank alias item', aliases },
        },
        { access: ACCESS }
      );

      expect(result.error?.kind).toBe('invalid_input');
      expect(resolveAlias(getAdapter(), 'valid', 'item', [SCOPE])).toBeNull();
    }
  );

  it('rejects a payload that tries to carry its own scopes', async () => {
    const result = await dispatch(
      {
        action: 'graph.node.put',
        operationId: 'op-put-scope',
        input: { kind: 'item', name: 'x', scopes: [{ kind: 'project', id: 'not-mine' }] },
      },
      { access: ACCESS }
    );

    expect(result.status).toBe('failed');
    expect((result as { error: { kind: string } }).error.kind).toBe('invalid_input');
  });

  it('fails honestly for a missing kind or name', async () => {
    const result = await dispatch(
      { action: 'graph.node.put', operationId: 'op-put-bad', input: { kind: 'item' } },
      { access: ACCESS }
    );

    expect(result.status).toBe('failed');
  });
});
