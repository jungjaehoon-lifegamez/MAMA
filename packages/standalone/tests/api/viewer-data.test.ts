import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledge, type CommitmentPage } from '@jungjaehoon/mama-core/knowledge';
import type { WorkGraphPage } from '@jungjaehoon/mama-core';
import Database from 'better-sqlite3';
import { GraphModule } from '../../public/viewer/src/modules/graph.js';
import {
  mapArchiveGraphNode,
  readViewerMemoryStats,
  shapeGraphPage,
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
  it('draws the links the agent stated and no host edge between revisions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-viewer-graph-data-'));
    const handle = await openCoreDatabase({ path: join(root, 'memory.db') });
    try {
      const knowledge = createKnowledge({ adapter: handle.adapter });
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

  it('keeps fixed kind colours and counts only visible kinds and relationships in the legend', () => {
    const graph = new GraphModule();
    graph.graphData = {
      nodes: [
        { id: 'a', kind: 'lesson' },
        { id: 'b', kind: 'lesson' },
        { id: 'c', kind: 'observation' },
        { id: 'd', kind: 'commitment' },
      ],
      edges: [
        { from: 'a', to: 'c', relationship: 'derived_from' },
        { from: 'b', to: 'c', relationship: 'derived_from' },
        { from: 'a', to: 'b', relationship: 'amends' },
        { from: 'd', to: 'a', relationship: 'refines' },
      ],
    };
    const kinds = [
      'decision',
      'preference',
      'constraint',
      'lesson',
      'fact',
      'commitment',
      'observation',
    ];
    expect(new Set(kinds.map((kind) => graph.getNodeColor(kind))).size).toBe(kinds.length);
    expect([...kinds].reverse().map((kind) => new GraphModule().getNodeColor(kind))).toEqual(
      kinds.map((kind) => graph.getNodeColor(kind)).reverse()
    );
    expect(graph.getLegendEntries()).toEqual({
      nodes: [
        { kind: 'commitment', count: 1, color: graph.getNodeColor('commitment') },
        { kind: 'lesson', count: 2, color: graph.getNodeColor('lesson') },
        { kind: 'observation', count: 1, color: graph.getNodeColor('observation') },
      ],
      edges: ['amends', 'derived_from', 'refines'].map((relationship) => ({
        relationship,
        count: relationship === 'derived_from' ? 2 : 1,
        ...graph.edgeStyles[relationship],
      })),
    });
    graph.network = {
      body: {
        data: {
          nodes: {
            get: () => [
              { id: 'a' },
              { id: 'b' },
              { id: 'c', hidden: true },
              { id: 'd', hidden: true },
            ],
          },
        },
      },
    } as never;
    expect(graph.getLegendEntries()).toEqual({
      nodes: [{ kind: 'lesson', count: 2, color: graph.getNodeColor('lesson') }],
      edges: [{ relationship: 'amends', count: 1, ...graph.edgeStyles.amends }],
    });
    graph.graphData = { nodes: [], edges: [] };
    expect(graph.getLegendEntries()).toEqual({ nodes: [], edges: [] });
  });

  it('counts all stored memories and creation times in the last seven days, including replaced records', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        'CREATE TABLE decisions (id TEXT, created_at INTEGER, updated_at INTEGER, status TEXT)'
      );
      const now = 1_800_000_000_000;
      const cutoff = now - 7 * 24 * 60 * 60 * 1_000;
      expect(readViewerMemoryStats(db, now)).toEqual({ total: 0, thisWeek: 0 });
      const insert = db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?)');
      insert.run('old', cutoff - 1, now, 'active');
      insert.run('boundary', cutoff, cutoff, 'superseded');
      insert.run('recent', now, now, 'active');
      insert.run('future', now + 1, now + 1, 'active');
      expect(readViewerMemoryStats(db, now)).toEqual({ total: 4, thisWeek: 2 });
      insert.run('new', now - 1, now - 1, 'active');
      expect(readViewerMemoryStats(db, now)).toEqual({ total: 5, thisWeek: 3 });
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
