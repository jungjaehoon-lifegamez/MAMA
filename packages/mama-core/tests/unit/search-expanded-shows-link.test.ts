/**
 * A record search expansion added says, in the default results, which hit it came from and the
 * link it followed, with the link's reason and any correction; without that it reads as a direct
 * hit and the reader cannot weigh the link.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

// A fixed query vector makes "which record is the direct hit" a statement about the seeded rows.
vi.mock('../../src/embedding/embedder.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/embedding/embedder.js')>(
    '../../src/embedding/embedder.js'
  );
  return { ...actual, generateEmbedding: vi.fn(async () => unitVector(1)) };
});

function unitVector(cosine: number): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = cosine;
  vector[1] = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return vector;
}

let testDbPath = '';

async function adapter() {
  const { getAdapter } = await import('../../src/db-manager.js');
  return getAdapter();
}

async function insertDecision(id: string, topic: string, decision: string, cosine: number) {
  const db = await adapter();
  const now = Date.now();
  db.prepare(
    `INSERT INTO decisions (id, topic, decision, reasoning, confidence, created_at, updated_at,
       kind, status, summary, event_datetime)
     VALUES (?, ?, ?, '', 0.8, ?, ?, 'decision', 'active', ?, ?)`
  ).run(id, topic, decision, now, now, decision, now);
  const row = db.prepare('SELECT rowid FROM decisions WHERE id = ?').get(id) as { rowid: number };
  db.insertEmbedding(row.rowid, unitVector(cosine));
  db.prepare("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')").run();
}

async function bind(memoryId: string, project: string) {
  const { ensureMemoryScope } = await import('../../src/db-manager.js');
  const db = await adapter();
  const scopeId = await ensureMemoryScope(db, 'project', project);
  db.prepare(
    'INSERT INTO memory_scope_bindings (memory_id, scope_id, is_primary) VALUES (?, ?, 1)'
  ).run(memoryId, scopeId);
}

describe('search results show the link an expanded record came through', () => {
  beforeAll(async () => {
    testDbPath = await initTestDB('search-expanded-shows-link');
  });

  afterAll(async () => cleanupTestDB(testDbPath));

  it('names the hit, the relation, the reason and the correction without diagnostics', async () => {
    await insertDecision('decision_rollout_hit', 'rollout_window', 'Roll out on Tuesdays', 0.99);
    await insertDecision('decision_freeze_linked', 'release_freeze', 'Freeze before holidays', 0);
    const { default: mama } = (await import('../../src/mama-api.js')) as unknown as {
      default: {
        link: (input: Record<string, unknown>) => Promise<{ edgeId: string }>;
      };
    };
    const link = await mama.link({
      from: 'decision_rollout_hit',
      to: 'decision_freeze_linked',
      relation: 'builds_on',
      reason: 'the rollout day follows the freeze calendar',
    });
    await mama.link({
      from: 'decision_rollout_hit',
      to: link.edgeId,
      relation: 'contradicts',
      reason: 'the calendar changed; the freeze no longer sets the day',
    });

    const { suggestInAdapter } = await import('../../src/memory/api.js');
    const result = (await suggestInAdapter(await adapter(), 'Roll out on Tuesdays', {
      limit: 5,
    })) as { results: Array<Record<string, unknown>> };

    expect(result.results.find((row) => row.id === 'decision_rollout_hit')).toMatchObject({
      graph_source: 'primary',
      related_to: null,
    });
    // At a limit the direct hits fill, the linked record still comes along on its hit.
    const hitOnly = (
      (await suggestInAdapter(await adapter(), 'Roll out on Tuesdays', { limit: 1 })) as {
        results: Array<Record<string, unknown>>;
      }
    ).results;
    expect(hitOnly.map((row) => row.id)).toEqual(['decision_rollout_hit']);
    expect(hitOnly[0]!.links).toEqual([
      expect.objectContaining({
        id: 'decision_freeze_linked',
        relation: 'builds_on',
        reason: 'the rollout day follows the freeze calendar',
        corrected_by: [
          expect.objectContaining({
            reason: 'the calendar changed; the freeze no longer sets the day',
          }),
        ],
      }),
    ]);
    expect(result.results.find((row) => row.id === 'decision_freeze_linked')).toMatchObject({
      graph_source: 'builds_on',
      related_to: 'decision_rollout_hit',
      edge_reason: 'the rollout day follows the freeze calendar',
      edge_corrected_by: [
        expect.objectContaining({
          reason: 'the calendar changed; the freeze no longer sets the day',
        }),
      ],
    });
  });

  it('names a link between two hits on both, with its correction and the replaced record', async () => {
    await insertDecision(
      'decision_pair_a',
      'pair_delivery',
      'Send large files through Drive',
      0.99
    );
    await insertDecision('decision_pair_b', 'pair_indexing', 'Send the Drive folder index', 0.98);
    const { default: mama } = (await import('../../src/mama-api.js')) as unknown as {
      default: { link: (input: Record<string, unknown>) => Promise<{ edgeId: string }> };
    };
    const link = await mama.link({
      from: 'decision_pair_a',
      to: 'decision_pair_b',
      relation: 'builds_on',
      reason: 'delivery sits on the index',
    });
    await mama.link({
      from: 'decision_pair_a',
      to: link.edgeId,
      relation: 'contradicts',
      reason: 'unrelated: delivery came from failed attachments',
    });

    const { suggestInAdapter } = await import('../../src/memory/api.js');
    const rows = (
      (await suggestInAdapter(await adapter(), 'Send large files through Drive', { limit: 2 })) as {
        results: Array<Record<string, unknown>>;
      }
    ).results;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('decision_pair_a')!.links).toEqual([
      expect.objectContaining({
        id: 'decision_pair_b',
        relation: 'builds_on',
        reason: 'delivery sits on the index',
        corrected_by: [
          expect.objectContaining({ reason: 'unrelated: delivery came from failed attachments' }),
        ],
      }),
    ]);
    expect(byId.get('decision_pair_b')!.links).toEqual([
      expect.objectContaining({ id: 'decision_pair_a', relation: 'built_on_by' }),
    ]);
  });

  it('says which revision of a work item a hit is, and the item head', async () => {
    const { createKnowledge } = await import('../../src/knowledge/index.js');
    const knowledge = createKnowledge({ adapter: await adapter() });
    const access = {
      principalId: 'principal-search',
      agentId: 'agent-search',
      scopes: [{ kind: 'global' as const, id: 'system' }],
      actions: [],
    };
    const created = await knowledge.createWork(
      {
        commandId: 'estimate-create',
        topic: 'estimate/outfit',
        summary: 'Client says outfit sway barely changes; the scope may shrink',
        set: { title: 'Outfit estimate' },
        scopes: access.scopes,
      },
      access
    );
    await knowledge.reviseWork(
      {
        commandId: 'estimate-revise',
        commitmentId: created.commitmentId,
        summary: 'Client corrected: outfit parameters drive the motion; the scope stays',
        set: { title: 'Outfit estimate (scope stays)' },
      },
      access
    );

    const { suggestInAdapter } = await import('../../src/memory/api.js');
    const rows = (
      (await suggestInAdapter(await adapter(), 'outfit sway scope shrink', { limit: 10 })) as {
        results: Array<Record<string, unknown>>;
      }
    ).results.filter((row) => row.topic === 'estimate/outfit');
    expect(
      rows
        .map((row) => row.work_item)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    ).toEqual([
      { commitment_id: created.commitmentId, revision: 1, head_revision: 2 },
      { commitment_id: created.commitmentId, revision: 2, head_revision: 2 },
    ]);
  });

  it('shows a correction only to a reader who may see the record that states it', async () => {
    await insertDecision('decision_backup_hit', 'backup_window', 'Back up at night', 0.99);
    await insertDecision('decision_backup_linked', 'disk_budget', 'Keep two weeks of disk', 0);
    await insertDecision('decision_other_team', 'other_team_note', 'Another team note', 0);
    await bind('decision_backup_hit', '/team/a');
    await bind('decision_backup_linked', '/team/a');
    await bind('decision_other_team', '/team/b');
    const { default: mama } = (await import('../../src/mama-api.js')) as unknown as {
      default: { link: (input: Record<string, unknown>) => Promise<{ edgeId: string }> };
    };
    const link = await mama.link({
      from: 'decision_backup_hit',
      to: 'decision_backup_linked',
      relation: 'builds_on',
      reason: 'the backup size follows the disk budget',
    });
    await mama.link({
      from: 'decision_other_team',
      to: link.edgeId,
      relation: 'contradicts',
      reason: 'a note only the other team may read',
    });

    const { suggestInAdapter } = await import('../../src/memory/api.js');
    const search = async (projects: string[]) =>
      (
        (await suggestInAdapter(await adapter(), 'Back up at night', {
          limit: 5,
          scopes: projects.map((id) => ({ kind: 'project' as const, id })),
        })) as { results: Array<Record<string, unknown>> }
      ).results.find((row) => row.id === 'decision_backup_linked');

    const narrow = await search(['/team/a']);
    const hitOnly = (
      (await suggestInAdapter(await adapter(), 'Back up at night', {
        limit: 1,
        scopes: [{ kind: 'project' as const, id: '/team/a' }],
      })) as { results: Array<Record<string, unknown>> }
    ).results;
    expect(hitOnly).toHaveLength(1);
    expect(hitOnly[0]).toMatchObject({
      id: 'decision_backup_hit',
      links: [
        {
          id: 'decision_backup_linked',
          topic: 'disk_budget',
          relation: 'builds_on',
          reason: 'the backup size follows the disk budget',
        },
      ],
    });
    expect((hitOnly[0]!.links as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'corrected_by'
    );
    expect(narrow).toMatchObject({ edge_reason: 'the backup size follows the disk budget' });
    expect(narrow).not.toHaveProperty('edge_corrected_by');
    expect(await search(['/team/a', '/team/b'])).toMatchObject({
      edge_corrected_by: [expect.objectContaining({ from: 'decision_other_team' })],
    });
  });
});
