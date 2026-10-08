import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { coreActionRegistrations, createCatalog } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge, ingestSource } from '../../src/knowledge/index.js';
import { correctIdentity } from '../../src/knowledge/identity.js';
import {
  appendJudgment,
  boundScopeIdsFor,
  type JudgmentAccess,
} from '../../src/knowledge/judgments.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';
import { appendIdentityCorrection } from '../../src/registry/corrections.js';
import { createNode, currentIdentityRevision } from '../../src/registry/store.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

const DEFAULTS: MemoryScopeRef[] = [
  { kind: 'global', id: 'default-fixture' },
  { kind: 'user', id: 'principal-fixture' },
];
const PARTITION: MemoryScopeRef = { kind: 'project', id: 'partition-fixture' };
const READ_ONLY: MemoryScopeRef = { kind: 'project', id: 'read-only-fixture' };
const ACCESS: JudgmentAccess = {
  principalId: 'principal-fixture',
  agentId: 'agent-fixture',
  scopes: [...DEFAULTS, PARTITION],
  defaultScopes: DEFAULTS,
  readScopes: [READ_ONLY],
  actions: ['graph.node.put'],
};
const CASES = [
  { mode: 'omitted', scopes: undefined, expected: DEFAULTS },
  { mode: 'explicit', scopes: [...DEFAULTS, PARTITION], expected: [...DEFAULTS, PARTITION] },
];

function nodeScopes(id: string): MemoryScopeRef[] {
  return getAdapter()
    .prepare(
      `SELECT scope_kind AS kind, scope_id AS id FROM registry_scope_bindings
       WHERE node_id = ? ORDER BY scope_kind, scope_id`
    )
    .all(id) as MemoryScopeRef[];
}

function sorted(scopes: readonly MemoryScopeRef[]): MemoryScopeRef[] {
  return [...scopes].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

describe('P2a write defaults stay separate from partition authority', () => {
  let dbPath: string;

  beforeAll(async () => {
    dbPath = await initTestDB('write-default-scopes');
  });
  afterAll(async () => cleanupTestDB(dbPath));

  it('resolves omitted binding scopes to defaults rather than all write scopes', () => {
    expect(boundScopeIdsFor(ACCESS, {})).toEqual([
      'scope_global_ZGVmYXVsdC1maXh0dXJl',
      'scope_user_cHJpbmNpcGFsLWZpeHR1cmU',
    ]);
  });

  it.each(CASES)('source ingest binds $mode scopes exactly', async ({ mode, scopes, expected }) => {
    const receipt = await ingestSource(
      {
        commandId: `source-default-${mode}`,
        source: { connector: 'fixture', id: `source-${mode}` },
        body: 'Original fixture evidence',
        ...(scopes === undefined ? {} : { scopes }),
      },
      ACCESS,
      { adapter: getAdapter() }
    );
    const row = getAdapter()
      .prepare('SELECT scope_json FROM observation_versions WHERE observation_id = ?')
      .get(receipt.observationId) as { scope_json: string };
    const stored = JSON.parse(row.scope_json) as {
      scopes: Array<{ kind: string; externalId: string }>;
    };
    expect(stored.scopes.map(({ kind, externalId }) => ({ kind, id: externalId }))).toEqual(
      expected
    );
    expect(
      await ingestSource(
        {
          commandId: `source-default-${mode}`,
          source: { connector: 'fixture', id: `source-${mode}` },
          body: 'Original fixture evidence',
          ...(scopes === undefined ? {} : { scopes }),
        },
        ACCESS,
        { adapter: getAdapter() }
      )
    ).toEqual(receipt);
  });

  it('replays an omitted source command written before defaultScopes was supplied', async () => {
    const command = {
      commandId: 'source-default-replay',
      source: { connector: 'fixture', id: 'source-replay' },
      body: 'Existing fixture evidence',
    };
    const legacyAccess = { ...ACCESS, scopes: DEFAULTS, defaultScopes: undefined };
    const first = await ingestSource(command, legacyAccess, { adapter: getAdapter() });
    expect(await ingestSource(command, legacyAccess, { adapter: getAdapter() })).toEqual(first);
    expect(await ingestSource(command, ACCESS, { adapter: getAdapter() })).toEqual(first);
    expect(
      await ingestSource({ ...command, scopes: DEFAULTS }, ACCESS, { adapter: getAdapter() })
    ).toEqual(first);
    expect(
      getAdapter()
        .prepare('SELECT COUNT(*) AS n FROM source_commands WHERE command_id = ?')
        .get(command.commandId)
    ).toEqual({ n: 1 });
  });

  it.each(CASES.filter(({ mode }) => mode === 'omitted'))(
    'graph.node.put binds the caller defaults on parent and children ($mode)',
    async ({ mode, scopes, expected }) => {
      const adapter = getAdapter();
      const dispatch = createDispatcher(
        createCatalog(
          coreActionRegistrations(createKnowledge({ adapter, embedder: null }), adapter)
        )
      );
      const result = await dispatch(
        {
          action: 'graph.node.put',
          input: {
            kind: 'item',
            name: `node-default-${mode}`,
            parent_of: [
              { name: `node-default-${mode}-first` },
              { name: `node-default-${mode}-second` },
            ],
            ...(scopes === undefined ? {} : { scopes }),
          },
        },
        { access: ACCESS }
      );
      expect(result.status, JSON.stringify(result)).toBe('completed');
      if (result.status !== 'completed') throw new Error('Node put failed');
      const nodes = result.data as { id: string; children: string[] };
      for (const id of [nodes.id, ...nodes.children]) {
        expect(nodeScopes(id)).toEqual(sorted(expected));
      }
    }
  );

  it.each(['knowledge', 'registry'] as const)(
    '%s identity split uses defaults and accepts explicitly granted partitions',
    (entry) => {
      for (const { mode, scopes, expected } of CASES) {
        const adapter = getAdapter();
        const parentId = createNode(adapter, {
          kind: 'item',
          name: `split-default-${entry}-${mode}`,
          scopes: DEFAULTS,
        });
        const command = {
          commandId: `split-default-${entry}-${mode}`,
          expectedRevision: currentIdentityRevision(adapter),
          operation: 'split' as const,
          parentId,
          reason: 'Two distinct fixture items',
          children: [
            { name: `split-default-${entry}-${mode}-first` },
            { name: `split-default-${entry}-${mode}-second` },
          ],
          assignments: [],
          ...(scopes === undefined ? {} : { scopes }),
        };
        const receipt =
          entry === 'knowledge'
            ? correctIdentity(command, ACCESS, { adapter })
            : appendIdentityCorrection(adapter, command, { ...ACCESS, connectors: [] });
        expect(receipt.children).toHaveLength(2);
        for (const child of receipt.children) {
          expect(nodeScopes(child.ref.id)).toEqual(sorted(expected));
        }
      }
    }
  );

  it.each(CASES)(
    'judgment append binds $mode scopes exactly',
    async ({ mode, scopes, expected }) => {
      const receipt = await appendJudgment(
        {
          commandId: `judgment-default-${mode}`,
          topic: 'fixture-topic',
          summary: 'Fixture judgment',
          recordKind: 'judgment',
          ...(scopes === undefined ? {} : { scopes }),
        },
        ACCESS,
        { adapter: getAdapter(), embedder: null }
      );
      const bindings = getAdapter()
        .prepare(
          `SELECT s.kind, s.external_id AS id FROM memory_scope_bindings b
       JOIN memory_scopes s ON s.id = b.scope_id WHERE b.memory_id = ? ORDER BY s.kind, s.external_id`
        )
        .all(receipt.recordId);
      expect(bindings).toEqual(sorted(expected));
    }
  );

  it.each([
    {
      mode: 'invalid-default',
      scopes: undefined,
      access: { ...ACCESS, defaultScopes: [READ_ONLY] },
    },
    {
      mode: 'no-scope',
      scopes: undefined,
      access: { ...ACCESS, scopes: [], defaultScopes: undefined },
    },
  ])('graph.node.put refuses $mode authority before writing', async ({ mode, scopes, access }) => {
    const adapter = getAdapter();
    const before = adapter.prepare('SELECT COUNT(*) AS n FROM registry_nodes').get();
    const dispatch = createDispatcher(
      createCatalog(coreActionRegistrations(createKnowledge({ adapter, embedder: null }), adapter))
    );
    const result = await dispatch(
      {
        action: 'graph.node.put',
        input: {
          kind: 'item',
          name: `node-denied-${mode}`,
          ...(scopes === undefined ? {} : { scopes }),
        },
      },
      { access }
    );
    expect(result.status).toBe('failed');
    expect(adapter.prepare('SELECT COUNT(*) AS n FROM registry_nodes').get()).toEqual(before);
  });
});
