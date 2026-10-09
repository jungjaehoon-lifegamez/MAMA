import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledge, type CommitmentPage } from '@jungjaehoon/mama-core/knowledge';
import type { WorkGraphPage } from '@jungjaehoon/mama-core';
import Database from 'better-sqlite3';
import {
  GraphModule,
  RELATION_LABELS,
  composeFilterGraph,
} from '../../public/viewer/src/modules/graph.js';
import {
  mapArchiveGraphNode,
  readViewerMemoryStats,
  shapeGraphPage,
  shapeSavedTimeline,
  shapeArchiveGraph,
  shapeMemorySearch,
  shapeOperatorTasks,
  shapeTaskDetail,
  shapeTaskList,
  type RevisionGraphRead,
} from '../../src/api/viewer-data.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

const page = (items: CommitmentPage['items']): CommitmentPage => ({
  items,
  nextCursor: null,
  coverage: { returned: items.length, total: items.length, complete: true, reasons: [] },
});

describe('viewer data shaping', () => {
  it.each(['memory', 'observation', 'raw'] as const)(
    'maps an erased %s to an id-only erased stub',
    (kind) => {
      const node: WorkGraphPage['nodes'][number] = {
        ref: { kind, id: 'erased-record' },
        label: 'private label',
        data: {
          kind,
          id: 'erased-record',
          scopes: [{ kind: 'user', id: 'test-principal' }],
          state: 'erased',
        },
      };
      expect(mapArchiveGraphNode(node, 'UTC')).toEqual({
        id: `${kind}:erased-record`,
        kind,
        state: 'erased',
        label: 'Erased',
        decision_preview: 'Erased',
      });
    }
  );

  it('lists and counts erased timeline records without inventing content or a date', () => {
    const erased = {
      id: 'erased-record',
      scopes: [{ kind: 'user', id: 'test-principal' }],
      state: 'erased' as const,
    };
    const window = { from: '2026-10-01', to: '2026-10-08', timeZone: 'UTC' };
    const result = shapeSavedTimeline([erased], window, { query: null, groups: null }, new Set());
    expect(result.total).toBe(1);
    expect(result.counts.erased).toBe(1);
    expect(result.days).toEqual([
      {
        day: null,
        total: 1,
        groups: [
          {
            group: 'erased',
            count: 1,
            records: [
              {
                id: 'memory:erased-record',
                kind: null,
                status: 'erased',
                topic: 'erased-record',
                summary: 'Erased',
                time: '',
                via: null,
              },
            ],
          },
        ],
      },
    ]);
    expect(
      shapeSavedTimeline([erased], window, { query: 'private content', groups: null }, new Set())
        .total
    ).toBe(0);
    expect(
      shapeSavedTimeline([erased], window, { query: null, groups: new Set(['fact']) }, new Set())
    ).toMatchObject({ total: 0, counts: { erased: 1 }, days: [] });
  });

  it('groups only authenticated owner rules as owner rules despite identical chat refs', () => {
    const rows = ['fixture-owner-rule', 'fixture-member-rule', 'fixture-historical-rule'].map(
      (id) => ({
        id,
        kind: 'lesson',
        status: 'active',
        topic: id,
        summary: 'Fixture rule.',
        createdAt: Date.parse('2026-10-08T00:00:00Z'),
        sourceMessageRef: 'telegram:fixture-dm:fixture-message',
        commitmentId: null,
        revision: null,
        operation: null,
        itemTitle: null,
      })
    );
    const result = shapeSavedTimeline(
      rows,
      { from: '2026-10-08', to: '2026-10-08', timeZone: 'UTC' },
      { query: null, groups: null },
      new Set(['fixture-owner-rule'])
    );
    expect(result.counts).toMatchObject({ owner_rule: 1, learned: 2 });
    expect(result.days[0]?.groups).toMatchObject([
      { group: 'owner_rule', records: [{ id: 'memory:fixture-owner-rule' }] },
      {
        group: 'learned',
        records: [{ id: 'memory:fixture-member-rule' }, { id: 'memory:fixture-historical-rule' }],
      },
    ]);
  });

  it('draws the links the agent stated and no host edge between revisions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-viewer-graph-data-'));
    const handle = await openCoreDatabase({ path: join(root, 'memory.db') });
    try {
      const knowledge = createKnowledge({ adapter: handle.adapter, embedder: null });
      const access = {
        principalId: 'principal-viewer',
        agentId: 'agent-viewer',
        scopes: [{ kind: 'global' as const, id: 'system' }],
      };
      const created = await knowledge.createWork(
        {
          commandId: 'viewer-data-create',
          topic: 'viewer-work-topic',
          summary: 'created work',
          set: { title: 'Feedback history' },
          scopes: access.scopes,
        },
        access
      );
      await knowledge.reviseWork(
        {
          commandId: 'viewer-data-revise-one',
          commitmentId: created.commitmentId,
          expectedRevision: 1,
          summary: 'first feedback',
          set: { feedback: 'first' },
          scopes: access.scopes,
        },
        access
      );
      const revisedAgain = await knowledge.reviseWork(
        {
          commandId: 'viewer-data-revise-two',
          commitmentId: created.commitmentId,
          expectedRevision: 2,
          summary: 'second feedback',
          set: { feedback: 'second' },
          scopes: access.scopes,
        },
        access
      );

      const earlier = await knowledge.createWork(
        {
          commandId: 'viewer-data-earlier',
          topic: 'viewer-earlier-topic',
          summary: 'an earlier case',
          set: { title: 'Earlier case' },
          scopes: access.scopes,
        },
        access
      );
      const link = knowledge.appendLink(
        {
          commandId: 'viewer-data-link',
          from: revisedAgain.recordRef as { kind: 'memory'; id: string },
          to: earlier.recordRef,
          relation: 'builds_on',
          reason: 'the same kind of feedback',
        },
        { ...access, actions: [] }
      );

      const page = knowledge.queryGraph({ view: 'browse', history: 'all', limit: 10 }, access);
      const graph = shapeArchiveGraph(page, 0, ['memory'], 'UTC');
      expect(graph.edges.filter((edge) => edge.relationship === 'builds_on')).toEqual([
        expect.objectContaining({
          from: `memory:${revisedAgain.recordRef.id}`,
          to: `memory:${earlier.recordRef.id}`,
        }),
      ]);
      expect(link.replayed).toBe(false);
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names every drawn group and relationship in plain words, with counts', () => {
    const graph = new GraphModule();
    const node = (id: string, group: string, outside = false) => ({
      id,
      group,
      kind: null,
      label: id,
      detailId: id,
      updates: 0,
      outside,
    });
    graph.graph = {
      nodes: [
        node('a', 'owner_rule'),
        node('b', 'owner_rule'),
        node('c', 'work'),
        node('d', 'outside', true),
      ],
      edges: [
        { from: 'a', to: 'c', relation: 'builds_on' },
        { from: 'b', to: 'c', relation: 'builds_on' },
        { from: 'c', to: 'd', relation: 'supersedes' },
      ],
      recordNode: {},
    };
    expect(Object.keys(RELATION_LABELS)).toHaveLength(13);
    expect(graph.getLegendEntries()).toEqual({
      nodes: [
        { group: 'owner_rule', label: 'Owner rules', count: 2, color: expect.any(String) },
        { group: 'work', label: 'Work updates', count: 1, color: expect.any(String) },
        {
          group: 'outside',
          label: 'Linked, outside this filter',
          count: 1,
          color: expect.any(String),
        },
      ],
      edges: [
        { relationship: 'builds_on', label: 'builds on', count: 2, ...graph.edgeStyles.builds_on },
        { relationship: 'supersedes', label: 'replaces', count: 1, ...graph.edgeStyles.supersedes },
      ],
    });
    graph.graph = { nodes: [], edges: [], recordNode: {} };
    expect(graph.getLegendEntries()).toEqual({ nodes: [], edges: [] });
  });

  // The graph draws what the filters select: one dot per record, one per work item for its
  // updates, and the records they link to outside the filter, faded.
  it('composes the filtered records, their items and the records they link to', () => {
    const record = (id: string, topic: string) => ({
      id: `memory:${id}`,
      kind: null,
      status: 'active',
      topic,
      summary: `summary ${id}`,
      time: '10:00',
      via: null,
    });
    const revision = (id: string) => ({
      id: `memory:${id}`,
      revision: 1,
      operation: 'revise',
      status: 'active',
      summary: `summary ${id}`,
      time: '09:00',
    });
    const timeline = {
      from: '2026-10-03',
      to: '2026-10-04',
      timeZone: 'UTC',
      total: 5,
      counts: { owner_rule: 1, fact: 1, work: 3 },
      days: [
        {
          day: '2026-10-04',
          total: 3,
          groups: [
            { group: 'owner_rule', count: 1, records: [record('r1', 'rule topic')] },
            {
              group: 'work',
              count: 2,
              items: [
                {
                  commitmentId: 'c1',
                  title: 'Item one',
                  topic: 'work/one',
                  revisions: [revision('v2'), revision('v1')],
                },
              ],
            },
          ],
        },
        {
          day: '2026-10-03',
          total: 2,
          groups: [
            { group: 'fact', count: 1, records: [record('f1', 'fact topic')] },
            {
              group: 'work',
              count: 1,
              items: [
                {
                  commitmentId: 'c1',
                  title: 'Item one',
                  topic: 'work/one',
                  revisions: [revision('v0')],
                },
              ],
            },
          ],
        },
      ],
    };
    const links = {
      edges: [
        { from: 'memory:r1', to: 'memory:v1', relation: 'builds_on' },
        { from: 'memory:r1', to: 'memory:v1', relation: 'builds_on' },
        { from: 'memory:v2', to: 'memory:v0', relation: 'builds_on' },
        { from: 'memory:f1', to: 'memory:x9', relation: 'supersedes' },
        { from: 'memory:r1', to: 'memory:w7', relation: 'contradicts' },
        { from: 'memory:y5', to: 'memory:z6', relation: 'amends' },
      ],
      // Browse names both ends of every edge.
      nodes: {
        'memory:r1': { kind: 'workflow', label: 'rule', commitmentId: null },
        'memory:v0': { kind: 'commitment', label: 'update 0', commitmentId: 'c1' },
        'memory:v1': { kind: 'commitment', label: 'update 1', commitmentId: 'c1' },
        'memory:v2': { kind: 'commitment', label: 'update 2', commitmentId: 'c1' },
        'memory:f1': { kind: 'fact', label: 'fact', commitmentId: null },
        'memory:x9': { kind: 'fact', label: 'replaced fact', commitmentId: null },
        'memory:w7': { kind: 'commitment', label: 'other item update', commitmentId: 'c9' },
        'memory:y5': { kind: 'lesson', label: 'unrelated', commitmentId: null },
        'memory:z6': { kind: 'lesson', label: 'unrelated', commitmentId: null },
      },
    };

    const graph = composeFilterGraph(timeline, links);

    expect(graph.nodes).toEqual([
      expect.objectContaining({
        id: 'memory:r1',
        group: 'owner_rule',
        label: 'rule topic',
        detailId: 'memory:r1',
        outside: false,
      }),
      expect.objectContaining({
        id: 'item:c1',
        group: 'work',
        label: 'Item one',
        detailId: 'memory:v2',
        updates: 3,
        outside: false,
      }),
      expect.objectContaining({ id: 'memory:f1', group: 'fact', outside: false }),
      expect.objectContaining({
        id: 'memory:x9',
        group: 'outside',
        label: 'replaced fact',
        detailId: 'memory:x9',
        outside: true,
      }),
      expect.objectContaining({
        id: 'item:c9',
        group: 'outside',
        label: 'other item update',
        detailId: 'memory:w7',
        outside: true,
      }),
    ]);
    expect(graph.edges).toEqual([
      { from: 'memory:r1', to: 'item:c1', relation: 'builds_on' },
      { from: 'memory:f1', to: 'memory:x9', relation: 'supersedes' },
      { from: 'memory:r1', to: 'item:c9', relation: 'contradicts' },
    ]);
    expect(graph.recordNode).toMatchObject({
      'memory:r1': 'memory:r1',
      'memory:v2': 'item:c1',
      'memory:v0': 'item:c1',
    });
  });

  it('counts all stored memories and creation times in the last seven days, including replaced records', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        'CREATE TABLE decisions (id TEXT, created_at INTEGER, updated_at INTEGER, status TEXT); CREATE TABLE memory_scope_bindings (memory_id TEXT, scope_id TEXT); CREATE TABLE memory_scopes (id TEXT, kind TEXT, external_id TEXT)'
      );
      const now = 1_800_000_000_000;
      const cutoff = now - 7 * 24 * 60 * 60 * 1_000;
      expect(readViewerMemoryStats(db, now, { scopes: [] })).toEqual({ total: 0, thisWeek: 0 });
      const insert = db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?)');
      insert.run('old', cutoff - 1, now, 'active');
      insert.run('boundary', cutoff, cutoff, 'superseded');
      insert.run('recent', now, now, 'active');
      insert.run('future', now + 1, now + 1, 'active');
      expect(readViewerMemoryStats(db, now, { scopes: [] })).toEqual({ total: 4, thisWeek: 2 });
      insert.run('new', now - 1, now - 1, 'active');
      expect(readViewerMemoryStats(db, now, { scopes: [] })).toEqual({ total: 5, thisWeek: 3 });
    } finally {
      db.close();
    }
  });

  it.each(['decision', 'preference', 'constraint', 'lesson', 'fact'])(
    'preserves %s for display and uses commitment for work records',
    (memoryKind) => {
      const node: WorkGraphPage['nodes'][number] = {
        ref: { kind: 'memory', id: 'memory-1' },
        resolvedRef: { kind: 'memory', id: 'memory-1' },
        label: 'stored record',
        data: {
          kind: 'memory',
          recordKind: 'judgment',
          memoryKind,
          topic: 'topic',
          summary: 'summary',
          recordedAt: 1,
          appliesFrom: null,
          appliesUntil: null,
          stateAtSnapshot: 'current',
          replaces: [],
          payload: {},
          work: null,
          content: { complete: true, nextRead: null },
        },
      };
      expect(mapArchiveGraphNode(node, 'UTC')).toMatchObject({
        id: 'memory:memory-1',
        kind: memoryKind,
      });
      if (node.data.kind === 'memory') node.data.recordKind = 'commitment';
      expect(mapArchiveGraphNode(node, 'UTC')).toMatchObject({
        id: 'memory:memory-1',
        kind: 'commitment',
      });
    }
  );

  it('keeps observations separate from stored memory kinds', () => {
    expect(
      mapArchiveGraphNode(
        {
          ref: { kind: 'observation', id: 'source-1' },
          resolvedRef: { kind: 'observation', id: 'source-1' },
          label: 'source',
          data: {
            kind: 'observation',
            connector: 'connector',
            sourceId: 'source-1',
            observedAt: 1,
            sourceAt: null,
            contentHash: null,
          },
        },
        'UTC'
      )
    ).toMatchObject({ id: 'observation:source-1', kind: 'observation' });
  });

  it('labels observation times with the configured timezone', () => {
    const label = mapArchiveGraphNode(
      {
        ref: { kind: 'observation', id: 'source-1' },
        resolvedRef: { kind: 'observation', id: 'source-1' },
        label: 'source',
        data: {
          kind: 'observation',
          connector: 'connector',
          sourceId: 'source-1',
          observedAt: 1,
          sourceAt: Date.parse('2026-09-27T06:30:00Z'),
          contentHash: null,
        },
      },
      'America/Los_Angeles'
    );
    expect(label.label).toContain('(America/Los_Angeles)');
    expect(label.label).not.toContain('KST');
  });

  it('projects the task list fields without inventing values for missing task fields', () => {
    const result = shapeTaskList(
      page([
        {
          commitmentId: 'commitment-1',
          rowId: 1,
          revision: 2,
          latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
          values: {
            title: 'work title',
            project: 'project-ref',
            stage: 'review',
            assignee: 'person-ref',
            lastEventTime: 1_700_000_000_000,
          },
          withdrawn: false,
          basis: [],
          createdAt: 1_699_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
        {
          commitmentId: 'commitment-2',
          rowId: 2,
          revision: 1,
          latestJudgmentRef: { kind: 'memory', id: 'memory-3' },
          values: { title: 'another work' },
          withdrawn: false,
          basis: [],
          createdAt: 1_699_000_000_000,
          updatedAt: 1_699_000_000_000,
        },
      ])
    );

    expect(result.tasks).toEqual([
      {
        commitmentId: 'commitment-1',
        rowId: 1,
        revision: 2,
        title: 'work title',
        project: 'project-ref',
        stage: 'review',
        assignee: 'person-ref',
        lastEventTime: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        withdrawn: false,
      },
      {
        commitmentId: 'commitment-2',
        rowId: 2,
        revision: 1,
        title: 'another work',
        project: null,
        stage: null,
        assignee: null,
        lastEventTime: null,
        updatedAt: 1_699_000_000_000,
        withdrawn: false,
      },
    ]);
  });

  it('sorts revision history by event time and carries record, patch, roles, files, and evidence', () => {
    const work = page([
      {
        commitmentId: 'commitment-1',
        rowId: 1,
        revision: 2,
        latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
        values: { title: 'work title' },
        withdrawn: false,
        basis: [
          { kind: 'memory', id: 'memory-1' },
          { kind: 'memory', id: 'memory-2' },
        ],
        createdAt: 1_700_000_000_200,
        updatedAt: 1_700_000_000_200,
        history: [
          {
            revision: 2,
            operation: 'revise',
            recordRef: { kind: 'memory', id: 'memory-2' },
            set: {
              feedback: 'feedback text',
              roles: [{ personRef: 'person-ref', role: 'reviewer', confirmed: false }],
              files: [{ locator: 'file-ref', version: 'v2', hash: 'hash-v2' }],
            },
            clear: [],
            eventDatetime: 1_700_000_000_200,
            createdAt: 1_700_000_000_201,
          },
          {
            revision: 1,
            operation: 'create',
            recordRef: { kind: 'memory', id: 'memory-1' },
            set: { title: 'work title' },
            clear: [],
            eventDatetime: 1_700_000_000_100,
            createdAt: 1_700_000_000_101,
          },
        ],
      },
    ]);
    const reads = new Map<string, RevisionGraphRead>([
      [
        'memory:memory-1',
        {
          record: {
            ref: { kind: 'memory', id: 'memory-1' },
            resolvedRef: { kind: 'memory', id: 'memory-1' },
            label: 'topic',
            data: {
              kind: 'memory',
              recordKind: 'commitment',
              topic: 'topic',
              summary: 'created the work',
              recordedAt: 1_700_000_000_101,
              appliesFrom: 1_700_000_000_100,
              appliesUntil: null,
              stateAtSnapshot: 'current',
              replaces: [],
              payload: { reasoning: 'reason for create' },
              work: {
                commitmentId: 'commitment-1',
                rowId: 1,
                revision: 1,
                latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
              },
              content: { complete: true, nextRead: null },
            },
          } as WorkGraphPage['nodes'][number],
          evidence: [],
        },
      ],
      [
        'memory:memory-2',
        {
          record: {
            ref: { kind: 'memory', id: 'memory-2' },
            resolvedRef: { kind: 'memory', id: 'memory-2' },
            label: 'topic',
            data: {
              kind: 'memory',
              recordKind: 'commitment',
              topic: 'topic',
              summary: 'review changed the work',
              recordedAt: 1_700_000_000_201,
              appliesFrom: 1_700_000_000_200,
              appliesUntil: null,
              stateAtSnapshot: 'current',
              replaces: [],
              payload: { reasoning: 'reason for revision' },
              work: {
                commitmentId: 'commitment-1',
                rowId: 1,
                revision: 2,
                latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
              },
              content: { complete: true, nextRead: null },
            },
          } as WorkGraphPage['nodes'][number],
          evidence: [
            {
              observationRef: 'observation-1',
              source: 'connector',
              channel: 'channel-1',
              content: 'preserved evidence',
              sourceAt: 1_700_000_000_150,
              observedAt: 1_700_000_000_160,
            },
          ],
        },
      ],
    ]);

    const result = shapeTaskDetail(work, reads);

    expect(result.revisions.map((revision) => revision.revision)).toEqual([1, 2]);
    expect(result.createdAt).toBe(1_700_000_000_100);
    expect(result.updatedAt).toBe(1_700_000_000_200);
    expect(result.revisions[0]).toMatchObject({
      summary: 'created the work',
      reasoning: 'reason for create',
      feedback: null,
      roles: null,
      files: null,
    });
    expect(result.revisions[1]).toMatchObject({
      summary: 'review changed the work',
      feedback: 'feedback text',
      roles: [{ personRef: 'person-ref', role: 'reviewer', confirmed: false }],
      files: [{ locator: 'file-ref', version: 'v2', hash: 'hash-v2' }],
      evidence: [
        {
          observationRef: 'observation-1',
          channel: 'channel-1',
          content: 'preserved evidence',
        },
      ],
    });
  });

  it('adds the commitment id and event-time bounds to the archive operator task shape', () => {
    const result = shapeOperatorTasks(
      page([
        {
          commitmentId: 'commitment-1',
          rowId: 7,
          revision: 2,
          latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
          values: { title: 'work title' },
          withdrawn: false,
          basis: [],
          createdAt: 10,
          updatedAt: 20,
          history: [
            {
              revision: 2,
              operation: 'revise',
              recordRef: { kind: 'memory', id: 'memory-2' },
              set: {},
              clear: [],
              eventDatetime: 300,
              createdAt: 301,
            },
            {
              revision: 1,
              operation: 'create',
              recordRef: { kind: 'memory', id: 'memory-1' },
              set: { title: 'work title' },
              clear: [],
              eventDatetime: 100,
              createdAt: 101,
            },
          ],
        },
      ])
    );

    expect(result.tasks[0]).toMatchObject({
      commitment_id: 'commitment-1',
      created_at: 100,
      updated_at: 300,
    });
  });

  it('filters graph nodes and keeps only edges whose endpoints remain visible', () => {
    const graph: WorkGraphPage = {
      nodes: [
        {
          ref: { kind: 'memory', id: 'memory-1' },
          resolvedRef: { kind: 'memory', id: 'memory-1' },
          label: 'memory',
          data: {
            kind: 'memory',
            recordKind: 'commitment',
            topic: 'topic',
            summary: 'summary',
            recordedAt: 1,
            appliesFrom: null,
            appliesUntil: null,
            stateAtSnapshot: 'current',
            replaces: [],
            payload: {},
            work: null,
            content: { complete: true, nextRead: null },
          },
        },
        {
          ref: { kind: 'observation', id: 'observation-1' },
          resolvedRef: { kind: 'observation', id: 'observation-1' },
          label: 'observation',
          data: {
            kind: 'observation',
            connector: 'connector',
            sourceId: 'source-1',
            sourceAt: 1,
            observedAt: 2,
            contentHash: 'hash',
          },
        },
      ],
      edges: [
        {
          id: 'edge-1',
          relation: 'derived_from',
          from: { kind: 'memory', id: 'memory-1' },
          to: { kind: 'observation', id: 'observation-1' },
          resolvedFrom: { kind: 'memory', id: 'memory-1' },
          resolvedTo: { kind: 'observation', id: 'observation-1' },
          attrs: null,
        },
      ],
      coverage: { returned: 2, total: null, complete: true, reasons: [] },
      snapshot: { judgmentWatermark: 1, identityRevision: 1, asOf: 2 },
      nextCursor: null,
    };

    const filtered = shapeGraphPage(graph, ['memory']);

    expect(filtered.nodes.map((node) => node.ref.kind)).toEqual(['memory']);
    expect(filtered.edges).toEqual([]);
    expect(filtered.coverage).toEqual(graph.coverage);
  });

  it('keeps memory search result fields and count', () => {
    expect(
      shapeMemorySearch({
        success: true,
        count: 1,
        results: [
          {
            id: 'memory-1',
            topic: 'topic',
            decision: 'decision',
            reasoning: 'reasoning',
            created_at: 1,
          },
        ],
      })
    ).toEqual({
      count: 1,
      results: [
        {
          id: 'memory-1',
          topic: 'topic',
          decision: 'decision',
          reasoning: 'reasoning',
          created_at: 1,
        },
      ],
    });
  });
});
