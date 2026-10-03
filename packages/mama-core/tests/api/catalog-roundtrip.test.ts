import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureMemoryScope, getAdapter } from '../../src/db-manager.js';
import { createKnowledge, type Knowledge } from '../../src/knowledge/index.js';
import { createNode } from '../../src/registry/store.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';
import {
  createCatalog,
  coreActionRegistrations,
  UnknownActionError,
  type ActionRegistration,
} from '../../src/api/catalog.js';
import { createDispatcher, validateInput } from '../../src/api/dispatch.js';
import type { WorkGraphPage } from '../../src/memory/judgment-types.js';

const ACCESS = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [{ kind: 'project' as const, id: 'scope-test' }] as MemoryScopeRef[],
  // The grant this test stands on: exactly the actions it calls.
  actions: [
    'graph.identity.correct',
    'graph.node.put',
    'graph.query',
    'memory.checkpoint.load',
    'memory.checkpoint.save',
    'memory.read:experience',
    'memory.read:provenance',
    'memory.read:topic',
    'memory.save',
    'memory.search',
    'memory.update',
    'operation.get',
    'source.ingest',
    'work.changes',
    'work.list',
    'work.show',
  ],
};

describe('Story R2: action catalog and dispatch roundtrip', () => {
  let dbPath = '';
  let knowledge: Knowledge;

  beforeAll(async () => {
    dbPath = await initTestDB('catalog-roundtrip');
    knowledge = createKnowledge({ adapter: getAdapter() });
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM commitment_assignments').run();
    db.prepare('DELETE FROM commitments').run();
    db.prepare('DELETE FROM judgment_commands').run();
    db.prepare('DELETE FROM command_bindings').run();
    db.prepare('DELETE FROM twin_edges').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM memory_scope_bindings').run();
    db.prepare('DELETE FROM memory_scopes').run();
    db.prepare('DELETE FROM embeddings').run();
    db.prepare('DELETE FROM decisions').run();
    db.prepare('DELETE FROM record_actors').run();
    db.prepare('DELETE FROM registry_ref_assignments').run();
    db.prepare('DELETE FROM registry_scope_bindings').run();
    db.prepare('DELETE FROM registry_aliases').run();
    db.prepare('DELETE FROM registry_nodes').run();
    db.prepare('DELETE FROM observation_versions').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('lists and describes only the actions that are implemented', () => {
    const catalog = createCatalog(coreActionRegistrations(knowledge, getAdapter()));
    const names = catalog.list().map((contract) => contract.name);
    expect(names).toEqual([
      'graph.query',
      'graph.node.put',
      'graph.identity.correct',
      'memory.save',
      'memory.update',
      'memory.checkpoint.save',
      'memory.search',
      'memory.checkpoint.load',
      'memory.checkpoint.list',
      'memory.read:listing',
      'memory.read:timeline',
      'memory.read:projects',
      'memory.read:graph',
      'memory.read:stats',
      'memory.read:topic',
      'memory.read:provenance',
      'memory.read:record',
      'memory.retire',
      'memory.read:experience',
      'source.ingest',
      'work.list',
      'work.show',
      'operation.get',
    ]);

    const contract = catalog.describe('graph.query');
    expect(contract.inputSchema.required).toEqual(['view']);
    expect(contract.examples?.length).toBeGreaterThan(0);
    expect(() => catalog.describe('memory.read.topic')).toThrow(UnknownActionError);
  });

  it('explains memory.save scope kinds and its omitted-scope default', () => {
    const catalog = createCatalog(coreActionRegistrations(knowledge, getAdapter()));
    const contract = catalog.describe('memory.save');
    expect(contract.summary).toContain(
      "Scopes are global, user, channel, or project; omitted scopes use the caller's admitted scopes."
    );
    expect(contract.inputSchema.properties?.scopes).toMatchObject({
      description:
        "Visibility scopes are global, user, channel, or project; omit to use the caller's admitted scopes.",
    });
  });

  it('defaults work.show to the compact revision chain', async () => {
    const created = await knowledge.appendJudgment(
      {
        commandId: 'cmd-show-create',
        topic: 'topic-show',
        summary: 'show create',
        recordKind: 'commitment',
        work: { operation: 'create', set: { title: 'Show work', status: 'pending' } },
        scopes: ACCESS.scopes,
      },
      ACCESS
    );
    await knowledge.appendJudgment(
      {
        commandId: 'cmd-show-revise',
        topic: 'topic-show',
        summary: 'show revise',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId: created.work!.commitmentId,
          expectedRevision: 1,
          set: { status: 'done' },
        },
        scopes: ACCESS.scopes,
      },
      ACCESS
    );

    const catalog = createCatalog(coreActionRegistrations(knowledge, getAdapter()));
    const result = await createDispatcher(catalog)(
      {
        action: 'work.show',
        operationId: 'op-show-default',
        input: { commitmentId: created.work!.commitmentId },
      },
      { access: ACCESS }
    );

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      const item = (result.data as { items: Array<Record<string, unknown>> }).items[0]!;
      expect(item.history).toBeUndefined();
      expect(item.chain).toEqual([
        {
          revision: 1,
          operation: 'create',
          eventDatetime: null,
          appliesUntil: null,
          createdAt: expect.any(Number),
          status: 'pending',
          stage: null,
          summary: 'show create',
        },
        {
          revision: 2,
          operation: 'revise',
          eventDatetime: null,
          appliesUntil: null,
          createdAt: expect.any(Number),
          status: 'done',
          stage: null,
          summary: 'show revise',
        },
      ]);
    }
    expect(catalog.describe('work.show').summary).toContain('revision chain by default');
  });

  it('describes every memory, work, and graph query input field', () => {
    const catalog = createCatalog(coreActionRegistrations(knowledge, getAdapter()));
    const visit = (schema: unknown, path: string): void => {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
      const value = schema as {
        properties?: Record<string, unknown>;
        items?: unknown;
        oneOf?: unknown[];
      };
      for (const [name, property] of Object.entries(value.properties ?? {})) {
        const field = property as { description?: unknown };
        expect(field.description, `${path}.${name}`).toEqual(expect.any(String));
        expect(String(field.description).trim(), `${path}.${name}`).not.toBe('');
        visit(property, `${path}.${name}`);
      }
      visit(value.items, `${path}[]`);
      for (const [index, branch] of (value.oneOf ?? []).entries()) {
        visit(branch, `${path}.oneOf[${index}]`);
      }
    };

    for (const contract of catalog.list()) {
      if (
        contract.name === 'graph.query' ||
        contract.name.startsWith('memory.') ||
        contract.name.startsWith('work.')
      ) {
        visit(contract.inputSchema, contract.name);
      }
    }
  });

  it('keeps memory listing navigable while full reasoning stays available on demand', async () => {
    const adapter = getAdapter();
    const scopeId = ensureMemoryScope(adapter, 'project', 'scope-test');
    const reasoning = 'Evidence and unresolved context. '.repeat(80);
    adapter
      .prepare(
        `INSERT INTO decisions
         (id, topic, decision, reasoning, status, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 0.8, ?, ?)`
      )
      .run('mem_listing_1', 'work/current', 'The current work remains open.', reasoning, 1, 2);
    adapter
      .prepare('INSERT INTO memory_scope_bindings (memory_id, scope_id) VALUES (?, ?)')
      .run('mem_listing_1', scopeId);
    const dispatch = createDispatcher(createCatalog(coreActionRegistrations(knowledge, adapter)));
    const access = { ...ACCESS, actions: [...ACCESS.actions, 'memory.read:listing'] };

    const compact = await dispatch(
      { action: 'memory.read:listing', input: { order: 'recent' } },
      { access }
    );
    expect(compact).toMatchObject({
      status: 'completed',
      data: {
        count: 1,
        decisions: [
          {
            id: 'mem_listing_1',
            decision: 'The current work remains open.',
            reasoningPreview: expect.any(String),
            reasoningTruncated: true,
          },
        ],
      },
    });
    if (compact.status !== 'completed') throw new Error('Listing did not complete');
    const compactRow = (compact.data as { decisions: Array<Record<string, unknown>> }).decisions[0];
    expect(compactRow).not.toHaveProperty('reasoning');
    expect(String(compactRow.reasoningPreview).length).toBeLessThan(reasoning.length);

    const full = await dispatch(
      { action: 'memory.read:listing', input: { detail: 'full' } },
      { access }
    );
    expect(full).toMatchObject({
      status: 'completed',
      data: { decisions: [{ id: 'mem_listing_1', reasoning }] },
    });
    const other = await dispatch(
      { action: 'memory.read:listing', input: { detail: 'full' } },
      { access: { ...access, scopes: [{ kind: 'project', id: 'other-project' }] } }
    );
    expect(other).toMatchObject({ status: 'completed', data: { count: 0, decisions: [] } });
  });

  it('registers work.changes only when the host injects the effects ledger port', async () => {
    // The list above proves the absent-port case: no port, no action. With the
    // port the action exists and the dispatch round trip serves the projection.
    const effects = {
      listChanges: () => [
        {
          id: 1,
          runId: 'mr_1',
          channelId: 'chat:C001',
          causeState: 'unattributed' as const,
          causeKind: 'clock' as const,
          sourceEventIds: [],
          kind: 'memory_write' as const,
          targetType: 'memory' as const,
          targetId: 'judgment_x',
          payloadHash: 'h',
          atMs: 1750000000000,
        },
      ],
      changeCoverage: () => ({ attributed: 1, unattributed: 2 }),
      listTurnInputs: (runId: string, principalId: string) => {
        expect(runId).toBe('mr_1');
        expect(principalId).toBe('principal-test');
        return {
          runStatus: 'running' as const,
          items: [
            {
              inputId: 7,
              stimulusId: 'telegram:owner:message-1',
              kind: 'owner_message',
              principalId,
              channelKey: 'telegram:owner',
              occurredAt: 1750000000000,
              status: 'acked',
              nativeState: 'accepted',
            },
          ],
          nextCursor: null,
        };
      },
    };
    const dispatch = createDispatcher(
      createCatalog(coreActionRegistrations(knowledge, getAdapter(), { effects }))
    );
    expect(dispatch).toBeDefined();

    const result = await dispatch(
      { action: 'work.changes', input: {}, operationId: 'op_changes_1' },
      { access: ACCESS }
    );
    expect(result.status).toBe('completed');
    expect(result.data).toMatchObject({
      success: true,
      coverage: { attributed: 1, unattributed: 2 },
      total: 3,
      returned: 1,
      changes: [
        {
          effect_id: 1,
          kind: 'memory_write',
          target_type: 'memory',
          cause_state: 'unattributed',
          cause_kind: 'clock',
          source_event_ids: [],
        },
      ],
    });

    const turnInputs = await dispatch(
      {
        action: 'work.changes',
        input: { view: 'turn_inputs', effect_id: 1, limit: 1 },
        operationId: 'op_changes_turn_inputs',
      },
      { access: ACCESS }
    );
    expect(turnInputs.status).toBe('completed');
    expect(turnInputs.data).toMatchObject({
      success: true,
      view: 'turn_inputs',
      effect_id: 1,
      relation: 'shared_native_turn_context',
      direct_cause_event_ids: [],
      run_status: 'running',
      items: [{ stimulusId: 'telegram:owner:message-1' }],
      next_cursor: null,
    });
    for (const [index, input] of [
      { view: 'turn_inputs' },
      { view: 'changes', effect_id: 1 },
      { view: 'turn_inputs', effect_id: 1, since: '7d' },
    ].entries()) {
      const invalid = await dispatch(
        { action: 'work.changes', input, operationId: `op_changes_invalid_${index}` },
        { access: ACCESS }
      );
      expect(invalid.status).toBe('failed');
      expect(invalid.error?.message).toMatch(/turn_inputs|effect_id/i);
    }

    const rejected = await dispatch(
      { action: 'work.changes', input: { cause_state: 'bogus' }, operationId: 'op_changes_2' },
      { access: ACCESS }
    );
    expect(rejected.status).toBe('failed');
    expect(rejected.error?.kind).toBe('invalid_input');
  });

  it('resolves a legacy name through the one alias table', () => {
    const echo: ActionRegistration = {
      contract: {
        name: 'graph.query',
        summary: 'test double',
        inputSchema: { type: 'object' },
      },
      exec: (input) => input,
    };
    const catalog = createCatalog([echo], { registry_lookup: 'graph.query' });
    expect(catalog.describe('registry_lookup').name).toBe('graph.query');
    expect(catalog.list().map((contract) => contract.name)).toEqual(['graph.query']);
  });

  it('dispatches a valid graph.query call to a real WorkGraphPage', async () => {
    const itemId = createNode(getAdapter(), {
      kind: 'item',
      name: 'Catalog Item',
      scopes: ACCESS.scopes,
    });
    await knowledge.appendJudgment(
      {
        commandId: 'cmd-catalog-1',
        topic: 'catalog-topic',
        summary: 'catalog judgment',
        recordKind: 'judgment',
        links: [{ relation: 'mentions', target: { kind: 'registry', id: itemId } }],
        scopes: ACCESS.scopes,
      },
      ACCESS
    );

    const dispatch = createDispatcher(
      createCatalog(coreActionRegistrations(knowledge, getAdapter()))
    );
    const result = await dispatch(
      {
        action: 'graph.query',
        operationId: 'op-catalog-1',
        input: {
          view: 'timeline',
          seeds: [{ kind: 'registry', id: itemId }],
          history: 'all',
        },
      },
      { access: ACCESS }
    );

    expect(result.status).toBe('completed');
    expect(result.operationId).toBe('op-catalog-1');
    if (result.status === 'completed') {
      const page = result.data as WorkGraphPage;
      expect(page.nodes.some((node) => node.ref.id === itemId)).toBe(true);
      expect(page.snapshot.judgmentWatermark).toBeGreaterThan(0);
    }
  });

  it('fails invalid input before exec is reached', async () => {
    const dispatch = createDispatcher(
      createCatalog(coreActionRegistrations(knowledge, getAdapter()))
    );

    const missingView = await dispatch(
      { action: 'graph.query', input: { seeds: [] } },
      { access: ACCESS }
    );
    expect(missingView.status).toBe('failed');
    if (missingView.status === 'failed') {
      expect(missingView.error.kind).toBe('invalid_input');
      expect(missingView.error.message).toContain('view');
    }

    const badView = await dispatch(
      { action: 'graph.query', input: { view: 'bogus' } },
      { access: ACCESS }
    );
    if (badView.status === 'failed') {
      expect(badView.error.kind).toBe('invalid_input');
    } else {
      expect.unreachable('bad view enum must fail validation');
    }

    const unknownKey = await dispatch(
      { action: 'graph.query', input: { view: 'overview', bogus: 1 } },
      { access: ACCESS }
    );
    if (unknownKey.status === 'failed') {
      expect(unknownKey.error.kind).toBe('invalid_input');
    } else {
      expect.unreachable('unknown property must fail validation');
    }
  });

  it('returns unknown_action without touching exec', async () => {
    let execCalls = 0;
    const registration: ActionRegistration = {
      contract: { name: 'noop.ping', summary: 'counts calls', inputSchema: { type: 'object' } },
      exec: () => {
        execCalls += 1;
        return {};
      },
    };
    const dispatch = createDispatcher(createCatalog([registration]));

    const result = await dispatch({ action: 'noop.missing', input: {} }, { access: ACCESS });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('unknown_action');
    }
    expect(execCalls).toBe(0);
  });

  it('marks a visibility denial denied, not failed', async () => {
    const hidden = createNode(getAdapter(), {
      kind: 'item',
      name: 'Hidden Item',
      scopes: [{ kind: 'project', id: 'scope-other' }],
    });
    const dispatch = createDispatcher(
      createCatalog(coreActionRegistrations(knowledge, getAdapter()))
    );

    const result = await dispatch(
      {
        action: 'graph.query',
        input: { view: 'detail', seeds: [{ kind: 'registry', id: hidden }] },
      },
      { access: ACCESS }
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('denied');
    }
  });

  it('validateInput enforces the schema subset dispatch relies on', () => {
    const schema = {
      type: 'object' as const,
      required: ['a'],
      additionalProperties: false,
      properties: {
        a: { type: 'string' as const, minLength: 2 },
        n: { type: 'integer' as const, minimum: 0 },
        tag: { type: 'string' as const, enum: ['x', 'y'] },
      },
    };
    expect(validateInput(schema, { a: 'ok', n: 1, tag: 'x' }, 'input')).toBeNull();
    expect(validateInput(schema, { n: 1 }, 'input')).toContain('required');
    expect(validateInput(schema, { a: 'ok', extra: 1 }, 'input')).toContain('not an allowed');
    expect(validateInput(schema, { a: 'ok', n: 1.5 }, 'input')).toContain('integer');
    expect(validateInput(schema, { a: 'ok', n: -1 }, 'input')).toContain('>=');
    expect(validateInput(schema, { a: 'ok', tag: 'z' }, 'input')).toContain('one of');
  });

  it('a refused oneOf names the allowed shapes and the field description', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        at: {
          description: 'Event time as epoch milliseconds, e.g. 1760000000000.',
          oneOf: [{ type: 'number' as const }, { type: 'null' as const }],
        },
        mode: { oneOf: [{ const: 'fast' }, { enum: ['slow', 'off'] }] },
      },
    };
    expect(validateInput(schema, { at: '2026-01-01T00:00:00+09:00' }, 'input')).toBe(
      'input.at must match exactly one of: number, null (0 matched). Event time as epoch milliseconds, e.g. 1760000000000.'
    );
    expect(validateInput(schema, { mode: 'up' }, 'input')).toBe(
      'input.mode must match exactly one of: "fast", "slow" | "off" (0 matched).'
    );
  });
});
