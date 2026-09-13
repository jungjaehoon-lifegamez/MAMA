import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  appendIdentityCorrection,
  readIdentityAssignments,
} from '../../src/registry/corrections.js';
import {
  createNode,
  currentIdentityRevision,
  rebuildRegistryProjections,
  resolveAliasCandidates,
} from '../../src/registry/store.js';
import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { appendObservationVersion } from '../../src/connectors/observation-versions.js';

describe('atomic identity corrections', () => {
  let dbPath: string;
  const scope = { kind: 'project' as const, id: 'project:t4' };
  const trusted = {
    principalId: 'owner:t4',
    agentId: 'agent:t4',
    scopes: [scope],
    connectors: ['slack', 'telegram'],
  };

  beforeAll(async () => {
    dbPath = await initTestDB('registry-corrections');
  });
  afterAll(async () => {
    await cleanupTestDB(dbPath);
  });
  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM connector_event_index').run();
    if (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation_versions'")
        .get()
    ) {
      db.prepare('DELETE FROM observation_versions').run();
    }
    db.prepare('DELETE FROM registry_ref_assignments').run();
    db.prepare('DELETE FROM registry_corrections').run();
    db.prepare('DELETE FROM registry_aliases').run();
    db.prepare('DELETE FROM registry_scope_bindings').run();
    db.prepare('DELETE FROM registry_nodes').run();
    db.prepare('UPDATE registry_identity_state SET revision=0 WHERE singleton=1').run();
    db.prepare('DELETE FROM twin_edges').run();
  });

  function edge(id = 'edge:t4'): { from: string; to: string } {
    const from = createNode({ kind: 'item', name: `${id} from`, scopes: [scope] });
    const to = createNode({ kind: 'item', name: `${id} to`, scopes: [scope] });
    getAdapter()
      .prepare(
        `INSERT INTO twin_edges
      (edge_id,edge_type,subject_kind,subject_id,object_kind,object_id,confidence,source,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(id, 'mentions', 'registry', from, 'registry', to, 1, 'human', Buffer.alloc(32), 1);
    return { from, to };
  }

  it('replays an authorized receipt before stale CAS and rejects changed payload without writes', () => {
    const node = createNode({ kind: 'item', name: 'alpha', scopes: [scope] });
    const command = {
      commandId: 'cmd:add',
      expectedRevision: currentIdentityRevision(),
      reason: 'known alias',
      operation: 'add_alias' as const,
      nodeId: node,
      alias: 'a-1',
      scopes: [scope],
    };
    const receipt = appendIdentityCorrection(command, trusted);
    expect(appendIdentityCorrection(command, trusted)).toEqual(receipt);
    expect(() => appendIdentityCorrection({ ...command, alias: 'changed' }, trusted)).toThrowError(
      /different authority or payload/
    );
    expect(
      getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_corrections').get()
    ).toEqual({ count: 1 });
  });

  it('denies same-principal receipt replay after its trusted scopes are revoked', () => {
    const node = createNode({ kind: 'item', name: 'revoked replay', scopes: [scope] });
    const command = {
      commandId: 'cmd:revoked',
      expectedRevision: currentIdentityRevision(),
      reason: 'first allowed',
      operation: 'add_alias' as const,
      nodeId: node,
      alias: 'revoked alias',
    };
    appendIdentityCorrection(command, trusted);
    expect(() =>
      appendIdentityCorrection(command, {
        principalId: trusted.principalId,
        agentId: trusted.agentId,
        scopes: [],
      })
    ).toThrowError(/scope|visible/i);
    expect(
      getAdapter()
        .prepare('SELECT COUNT(*) AS count FROM registry_corrections WHERE command_id=?')
        .get(command.commandId)
    ).toEqual({ count: 1 });
  });

  it('rejects a merge unless current authority covers every binding', () => {
    const otherScope = { kind: 'project' as const, id: 'project:other' };
    const survivor = createNode({
      kind: 'person',
      name: 'merge survivor',
      scopes: [scope],
    });
    const member = createNode({
      kind: 'person',
      name: 'merge member',
      scopes: [scope, otherScope],
    });
    const revision = currentIdentityRevision();
    expect(() =>
      appendIdentityCorrection(
        {
          commandId: 'cmd:merge-denied',
          expectedRevision: revision,
          reason: 'same person',
          operation: 'merge',
          survivorId: survivor,
          memberIds: [member],
          scopes: [scope],
        },
        { principalId: 'owner:t4', agentId: 'agent:t4', scopes: [scope, otherScope] }
      )
    ).toThrowError(/Registry target is unavailable/);
    expect(currentIdentityRevision()).toBe(revision);
    expect(
      appendIdentityCorrection(
        {
          commandId: 'cmd:merge-full',
          expectedRevision: revision,
          reason: 'same person',
          operation: 'merge',
          survivorId: survivor,
          memberIds: [member],
          scopes: [scope, otherScope],
        },
        { principalId: 'owner:t4', agentId: 'agent:t4', scopes: [scope, otherScope] }
      ).commandId
    ).toBe('cmd:merge-full');
    expect(
      resolveAliasCandidates('merge member', { kind: 'person', scopes: [otherScope] })
    ).toMatchObject([{ id: survivor, name: 'merge member' }]);
    expect(
      resolveAliasCandidates('merge survivor', { kind: 'person', scopes: [otherScope] })
    ).toEqual([]);
    const projection = getAdapter()
      .prepare('SELECT node_id,kind,alias,scope_kind,scope_id FROM registry_aliases ORDER BY alias')
      .all();
    rebuildRegistryProjections();
    expect(
      getAdapter()
        .prepare(
          'SELECT node_id,kind,alias,scope_kind,scope_id FROM registry_aliases ORDER BY alias'
        )
        .all()
    ).toEqual(projection);
  });

  it('rejects a hidden edge assignment without advancing revision or blocking a visible one', () => {
    const hiddenScope = { kind: 'project' as const, id: 'project:hidden' };
    const hiddenFrom = createNode({ kind: 'item', name: 'hidden from', scopes: [hiddenScope] });
    const hiddenTo = createNode({ kind: 'item', name: 'hidden to', scopes: [hiddenScope] });
    getAdapter()
      .prepare(
        `INSERT INTO twin_edges
      (edge_id,edge_type,subject_kind,subject_id,object_kind,object_id,confidence,source,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'edge:hidden',
        'mentions',
        'registry',
        hiddenFrom,
        'registry',
        hiddenTo,
        1,
        'human',
        Buffer.alloc(32),
        1
      );
    const parent = createNode({ kind: 'item', name: 'visible assignment parent', scopes: [scope] });
    const target = createNode({ kind: 'item', name: 'visible assignment target', scopes: [scope] });
    const revision = currentIdentityRevision();
    expect(() =>
      appendIdentityCorrection(
        {
          commandId: 'cmd:hidden-edge',
          expectedRevision: revision,
          reason: 'must not reach',
          operation: 'assign_refs',
          parentId: parent,
          assignments: [{ edgeId: 'edge:hidden', endpoint: 'from', targetNodeId: target }],
          scopes: [scope],
        },
        trusted
      )
    ).toThrowError(/Registry target is unavailable/);
    expect(currentIdentityRevision()).toBe(revision);
    const visible = edge('edge:visible');
    appendIdentityCorrection(
      {
        commandId: 'cmd:visible-edge',
        expectedRevision: currentIdentityRevision(),
        reason: 'allowed edge',
        operation: 'assign_refs',
        parentId: parent,
        assignments: [{ edgeId: 'edge:visible', endpoint: 'from', targetNodeId: target }],
        scopes: [scope],
      },
      trusted
    );
    expect(readIdentityAssignments('edge:visible')[0].originalRef.id).toBe(visible.from);
  });

  it('rejects duplicate edge endpoint assignments before revision or history changes', () => {
    edge('edge:duplicate-slot');
    const parent = createNode({ kind: 'item', name: 'duplicate parent', scopes: [scope] });
    const target = createNode({ kind: 'item', name: 'duplicate target', scopes: [scope] });
    const revision = currentIdentityRevision();
    expect(() =>
      appendIdentityCorrection(
        {
          commandId: 'cmd:duplicate-slot',
          expectedRevision: revision,
          reason: 'duplicate slot must fail',
          operation: 'assign_refs',
          parentId: parent,
          assignments: [
            { edgeId: 'edge:duplicate-slot', endpoint: 'from', targetNodeId: target },
            { edgeId: 'edge:duplicate-slot', endpoint: 'from', targetNodeId: null },
          ],
          scopes: [scope],
        },
        trusted
      )
    ).toThrowError(/same edge endpoint/i);
    expect(currentIdentityRevision()).toBe(revision);
    expect(
      getAdapter()
        .prepare('SELECT COUNT(*) AS count FROM registry_corrections WHERE command_id = ?')
        .get('cmd:duplicate-slot')
    ).toEqual({ count: 0 });
  });

  it('returns the same target error for hidden and unknown nodes without leaking identifiers', () => {
    const hiddenScope = { kind: 'project' as const, id: 'project:hidden-node' };
    const hidden = createNode({ kind: 'item', name: 'hidden label', scopes: [hiddenScope] });
    const errors = [hidden, 'reg_unknown_synthetic'].map((nodeId, index) => {
      try {
        appendIdentityCorrection(
          {
            commandId: `cmd:opaque:${index}`,
            expectedRevision: currentIdentityRevision(),
            reason: 'opaque target check',
            operation: 'add_alias',
            nodeId,
            alias: 'candidate',
            scopes: [scope],
          },
          trusted
        );
        throw new Error('expected target denial');
      } catch (error) {
        return error as { code?: string; message?: string };
      }
    });
    expect(errors.map((error) => [error.code, error.message])).toEqual([
      ['registry_target_unavailable', 'Registry target is unavailable'],
      ['registry_target_unavailable', 'Registry target is unavailable'],
    ]);
    expect(JSON.stringify(errors)).not.toContain('hidden label');
    expect(JSON.stringify(errors)).not.toContain(hidden);
  });

  it('requires principal, agent, and a nonempty signed scope set', () => {
    const node = createNode({ kind: 'item', name: 'trusted context', scopes: [scope] });
    const command = {
      commandId: 'cmd:missing-authority',
      expectedRevision: currentIdentityRevision(),
      reason: 'authority must be complete',
      operation: 'add_alias' as const,
      nodeId: node,
      alias: 'authority alias',
      scopes: [scope],
    };
    expect(() => appendIdentityCorrection(command, { ...trusted, principalId: '' })).toThrowError(
      /principal/i
    );
    expect(() => appendIdentityCorrection(command, { ...trusted, agentId: '' })).toThrowError(
      /agent/i
    );
    expect(() => appendIdentityCorrection(command, { ...trusted, scopes: [] })).toThrowError(
      /scope/i
    );
  });

  it('revalidates a non-null assignment target before replaying its receipt', () => {
    edge('edge:replay-target');
    const parent = createNode({ kind: 'item', name: 'replay parent', scopes: [scope] });
    const target = createNode({ kind: 'item', name: 'replay target', scopes: [scope] });
    const command = {
      commandId: 'cmd:target-replay',
      expectedRevision: currentIdentityRevision(),
      reason: 'target known',
      operation: 'assign_refs' as const,
      parentId: parent,
      assignments: [
        { edgeId: 'edge:replay-target', endpoint: 'to' as const, targetNodeId: target },
      ],
      scopes: [scope],
    };
    const receipt = appendIdentityCorrection(command, trusted);
    expect(appendIdentityCorrection(command, trusted)).toEqual(receipt);
    getAdapter().prepare('DELETE FROM registry_scope_bindings WHERE node_id=?').run(target);
    expect(() => appendIdentityCorrection(command, trusted)).toThrowError(
      /Registry target is unavailable/
    );
  });

  it('keeps original edge endpoints while assigning A then B then unresolved at one clock tick', () => {
    vi.spyOn(Date, 'now').mockReturnValue(77);
    const original = edge();
    const parent = createNode({ kind: 'item', name: 'parent', scopes: [scope] });
    const first = createNode({ kind: 'item', name: 'first', scopes: [scope] });
    const second = createNode({ kind: 'item', name: 'second', scopes: [scope] });
    for (const [index, target] of [first, second, null].entries()) {
      appendIdentityCorrection(
        {
          commandId: `cmd:${index}`,
          expectedRevision: currentIdentityRevision(),
          reason: `assignment ${index}`,
          operation: 'assign_refs',
          parentId: parent,
          assignments: [{ edgeId: 'edge:t4', endpoint: 'from', targetNodeId: target }],
          scopes: [scope],
        },
        trusted
      );
    }
    expect(readIdentityAssignments('edge:t4')).toMatchObject([
      {
        originalRef: { kind: 'registry', id: original.from },
        resolvedRef: null,
        commandId: 'cmd:2',
      },
    ]);
    expect(
      getAdapter()
        .prepare('SELECT subject_id, object_id FROM twin_edges WHERE edge_id=?')
        .get('edge:t4')
    ).toEqual({ subject_id: original.from, object_id: original.to });
    vi.restoreAllMocks();
  });

  it('rejects zero and one-child splits without mutation', () => {
    edge();
    const parent = createNode({ kind: 'item', name: 'umbrella', scopes: [scope] });
    const revision = currentIdentityRevision();
    const nodeCount = getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_nodes').get();
    for (const [index, children] of [[], [{ clientKey: 'only', name: 'only child' }]].entries()) {
      expect(() =>
        appendIdentityCorrection(
          {
            commandId: `cmd:invalid-split:${index}`,
            expectedRevision: revision,
            reason: 'invalid partition',
            operation: 'split',
            parentId: parent,
            children,
            assignments: [],
            scopes: [scope],
          },
          trusted
        )
      ).toThrowError(/split/i);
    }
    expect(currentIdentityRevision()).toBe(revision);
    expect(getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_nodes').get()).toEqual(
      nodeCount
    );
    expect(
      getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_corrections').get()
    ).toEqual({ count: 0 });
  });

  it('assigns split endpoints to newly created client keys in the same transaction', () => {
    const original = edge('edge:split-client');
    const parent = createNode({ kind: 'item', name: 'split parent', scopes: [scope] });
    const receipt = appendIdentityCorrection(
      {
        commandId: 'cmd:split-client',
        expectedRevision: currentIdentityRevision(),
        reason: 'explicit partition',
        operation: 'split',
        parentId: parent,
        children: [
          { clientKey: 'alpha', name: 'child alpha' },
          { clientKey: 'beta', name: 'child beta' },
        ],
        assignments: [
          { edgeId: 'edge:split-client', endpoint: 'from', targetClientKey: 'alpha' },
          { edgeId: 'edge:split-client', endpoint: 'to', targetClientKey: 'beta' },
        ],
        scopes: [scope],
      },
      trusted
    );
    const children = Object.fromEntries(
      receipt.children.map((child) => [child.clientKey, child.ref.id])
    );
    expect(readIdentityAssignments('edge:split-client')).toMatchObject([
      { endpoint: 'from', originalRef: { id: original.from }, resolvedRef: { id: children.alpha } },
      { endpoint: 'to', originalRef: { id: original.to }, resolvedRef: { id: children.beta } },
    ]);
  });

  it('rolls back duplicate or unknown split client keys', () => {
    edge('edge:split-invalid');
    const parent = createNode({ kind: 'item', name: 'split invalid parent', scopes: [scope] });
    const revision = currentIdentityRevision();
    const before = getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_nodes').get();
    for (const [index, input] of [
      {
        children: [
          { clientKey: 'same', name: 'child one' },
          { clientKey: 'same', name: 'child two' },
        ],
        assignments: [],
      },
      {
        children: [
          { clientKey: 'one', name: 'child one' },
          { clientKey: 'two', name: 'child two' },
        ],
        assignments: [
          { edgeId: 'edge:split-invalid', endpoint: 'from' as const, targetClientKey: 'missing' },
        ],
      },
    ].entries()) {
      expect(() =>
        appendIdentityCorrection(
          {
            commandId: `cmd:split-invalid:${index}`,
            expectedRevision: revision,
            reason: 'invalid client key',
            operation: 'split',
            parentId: parent,
            ...input,
            scopes: [scope],
          },
          trusted
        )
      ).toThrowError(/client key/i);
    }
    expect(currentIdentityRevision()).toBe(revision);
    expect(getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_nodes').get()).toEqual(
      before
    );
    expect(
      getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_corrections').get()
    ).toEqual({ count: 0 });
  });

  it('hides foreign observation evidence and still accepts a later visible action', () => {
    const node = createNode({ kind: 'item', name: 'scoped evidence node', scopes: [scope] });
    const foreign = upsertConnectorEventIndex(getAdapter(), {
      source_connector: 'slack',
      source_type: 'message',
      source_id: 'message:foreign',
      content: 'foreign',
      source_timestamp_ms: 1,
      project_id: 'project:foreign',
      memory_scope_kind: 'project',
      memory_scope_id: 'project:foreign',
      observation: { observed_at: 1 },
    });
    expect(() =>
      appendIdentityCorrection(
        {
          commandId: 'cmd:foreign',
          expectedRevision: currentIdentityRevision(),
          reason: 'wrong scope',
          operation: 'add_alias',
          nodeId: node,
          alias: 'blocked',
          scopes: [scope],
          evidence: [{ kind: 'observation', id: foreign.current_observation_id! }],
        },
        trusted
      )
    ).toThrowError(/Correction evidence is unavailable/);
    expect(
      appendIdentityCorrection(
        {
          commandId: 'cmd:valid',
          expectedRevision: currentIdentityRevision(),
          reason: 'independent',
          operation: 'add_alias',
          nodeId: node,
          alias: 'accepted',
          scopes: [scope],
        },
        trusted
      ).commandId
    ).toBe('cmd:valid');
  });

  it('accepts current T3 observation evidence in the trusted project scope', () => {
    const node = createNode({ kind: 'item', name: 'evidence-backed node', scopes: [scope] });
    const captured = upsertConnectorEventIndex(getAdapter(), {
      source_connector: 'slack',
      source_type: 'message',
      source_id: 'message:visible',
      content: 'visible',
      source_timestamp_ms: 2,
      project_id: scope.id,
      memory_scope_kind: scope.kind,
      memory_scope_id: scope.id,
      observation: { observed_at: 2 },
    });
    upsertConnectorEventIndex(getAdapter(), {
      source_connector: 'slack',
      source_type: 'message',
      source_id: 'message:visible',
      content: 'visible replacement',
      source_timestamp_ms: 3,
      project_id: scope.id,
      memory_scope_kind: scope.kind,
      memory_scope_id: scope.id,
      observation: { observed_at: 3 },
    });
    const receipt = appendIdentityCorrection(
      {
        commandId: 'cmd:visible-evidence',
        expectedRevision: currentIdentityRevision(),
        reason: 'source confirms alias',
        operation: 'add_alias',
        nodeId: node,
        alias: 'evidence alias',
        scopes: [scope],
        evidence: [{ kind: 'observation', id: captured.current_observation_id! }],
      },
      trusted
    );
    expect(receipt.commandId).toBe('cmd:visible-evidence');
  });

  it('denies correction evidence from another channel in the same project', () => {
    const node = createNode({ kind: 'item', name: 'channel evidence node', scopes: [scope] });
    const captured = upsertConnectorEventIndex(getAdapter(), {
      source_connector: 'slack',
      source_type: 'message',
      source_id: 'message:other-channel',
      channel: 'channel-b',
      content: 'same project, denied channel',
      source_timestamp_ms: 4,
      project_id: scope.id,
      memory_scope_kind: scope.kind,
      memory_scope_id: scope.id,
      observation: { observed_at: 4 },
    });
    expect(() =>
      appendIdentityCorrection(
        {
          commandId: 'cmd:channel-evidence-denied',
          expectedRevision: currentIdentityRevision(),
          reason: 'must stay in channel authority',
          operation: 'add_alias',
          nodeId: node,
          alias: 'must not bind',
          scopes: [scope],
          evidence: [{ kind: 'observation', id: captured.current_observation_id! }],
        },
        { ...trusted, channels: { slack: ['channel-a'] } }
      )
    ).toThrowError(/Correction evidence is unavailable/);
  });

  it('accepts owner-inline evidence only for its trusted principal and agent', () => {
    const node = createNode({ kind: 'item', name: 'owner evidence node', scopes: [scope] });
    const ownerObservation = appendObservationVersion(getAdapter(), {
      sourceConnector: 'owner-message:telegram',
      sourceId: 'owner-message:1',
      body: 'owner correction',
      observedAt: 3,
      contentHash: 'owner-hash',
      scope: {
        visibility: 'owner',
        agentId: 'agent:t4',
        channel: 'telegram:1',
        principalId: 'owner:t4',
      },
    });
    expect(() =>
      appendIdentityCorrection(
        {
          commandId: 'cmd:wrong-owner',
          expectedRevision: currentIdentityRevision(),
          reason: 'not mine',
          operation: 'add_alias',
          nodeId: node,
          alias: 'wrong owner alias',
          scopes: [scope],
          evidence: [{ kind: 'observation', id: ownerObservation.observationId }],
        },
        { ...trusted, principalId: 'owner:foreign' }
      )
    ).toThrowError(/Correction evidence is unavailable/);
    expect(
      appendIdentityCorrection(
        {
          commandId: 'cmd:owner',
          expectedRevision: currentIdentityRevision(),
          reason: 'owner supplied',
          operation: 'add_alias',
          nodeId: node,
          alias: 'owner alias',
          scopes: [scope],
          evidence: [{ kind: 'observation', id: ownerObservation.observationId }],
        },
        { ...trusted, agentId: 'agent:t4' }
      ).commandId
    ).toBe('cmd:owner');
  });

  it('fails supplied evidence when the required observation schema is absent', () => {
    const node = createNode({ kind: 'item', name: 'alpha', scopes: [scope] });
    getAdapter().prepare('DROP TABLE observation_versions').run();
    expect(() =>
      appendIdentityCorrection(
        {
          commandId: 'cmd:evidence',
          expectedRevision: currentIdentityRevision(),
          reason: 'observed',
          operation: 'add_alias',
          nodeId: node,
          alias: 'a',
          scopes: [scope],
          evidence: [{ kind: 'observation', id: 'obs:missing' }],
        },
        trusted
      )
    ).toThrowError(/observation_versions is required/);
    expect(createNode({ kind: 'person', name: 'independent', scopes: [scope] })).toMatch(/^reg_/);
    getAdapter().exec(`CREATE TABLE observation_versions (
      observation_id TEXT PRIMARY KEY, source_connector TEXT NOT NULL, source_id TEXT NOT NULL,
      producer_version_id TEXT, body TEXT, body_location_json TEXT, author TEXT, source_at INTEGER,
      observed_at INTEGER NOT NULL, content_hash TEXT NOT NULL, metadata_json TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      CHECK ((body IS NOT NULL AND body_location_json IS NULL) OR
             (body IS NULL AND body_location_json IS NOT NULL))
    )`);
  });

  it('preserves a missing edge schema failure and rolls back only that correction', () => {
    const parent = createNode({ kind: 'item', name: 'schema failure parent', scopes: [scope] });
    const target = createNode({ kind: 'item', name: 'schema failure target', scopes: [scope] });
    const revision = currentIdentityRevision();
    getAdapter().prepare('DROP TABLE twin_edges').run();
    let failure: unknown;
    try {
      appendIdentityCorrection(
        {
          commandId: 'cmd:missing-edge-schema',
          expectedRevision: revision,
          reason: 'must expose schema failure',
          operation: 'assign_refs',
          parentId: parent,
          assignments: [{ edgeId: 'edge:missing-schema', endpoint: 'from', targetNodeId: target }],
          scopes: [scope],
        },
        trusted
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).not.toBe('unknown_edge');
    expect(String(failure)).toMatch(/no such table: twin_edges/i);
    expect(currentIdentityRevision()).toBe(revision);
    expect(
      getAdapter()
        .prepare('SELECT COUNT(*) AS count FROM registry_corrections WHERE command_id=?')
        .get('cmd:missing-edge-schema')
    ).toEqual({ count: 0 });
    expect(
      appendIdentityCorrection(
        {
          commandId: 'cmd:after-schema-failure',
          expectedRevision: revision,
          reason: 'independent alias correction',
          operation: 'add_alias',
          nodeId: parent,
          alias: 'still usable',
          scopes: [scope],
        },
        trusted
      ).commandId
    ).toBe('cmd:after-schema-failure');
  });
});
