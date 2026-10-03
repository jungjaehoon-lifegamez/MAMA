/**
 * What was written when. A reader of the memory looks back over what was saved: newest written
 * first, inside a window on write time, a page at a time. A work revision says which item and
 * revision it is, and a record says which turn wrote it when a turn did.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureMemoryScope, getAdapter } from '../../src/db-manager.js';
import { createKnowledge } from '../../src/knowledge/index.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import { coreActionRegistrations, createCatalog } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';

const SCOPES: MemoryScopeRef[] = [{ kind: 'project', id: 'timeline-test' }];
const ACCESS = {
  principalId: 'principal-timeline',
  agentId: 'agent-timeline',
  scopes: SCOPES,
  actions: ['memory.read:timeline'],
};

function insertRecord(
  id: string,
  kind: string,
  createdAt: number,
  scope: MemoryScopeRef,
  sourceMessageRef: string | null
): void {
  const db = getAdapter();
  db.prepare(
    `INSERT INTO decisions (id, topic, decision, reasoning, confidence, created_at, updated_at,
       kind, status, summary, provenance_json)
     VALUES (?, ?, ?, '', 0.8, ?, ?, ?, 'active', ?, ?)`
  ).run(
    id,
    `topic/${id}`,
    `Statement ${id}`,
    createdAt,
    createdAt,
    kind,
    `Statement ${id}`,
    sourceMessageRef === null ? null : JSON.stringify({ source_message_ref: sourceMessageRef })
  );
  const scopeId = ensureMemoryScope(db, scope.kind, scope.id);
  db.prepare('INSERT INTO memory_scope_bindings (memory_id, scope_id) VALUES (?, ?)').run(
    id,
    scopeId
  );
}

describe('memory.read:timeline', () => {
  let dbPath = '';
  let commitmentId = '';
  let dispatch: ReturnType<typeof createDispatcher>;

  beforeAll(async () => {
    dbPath = await initTestDB('saved-timeline');
    const adapter = getAdapter();
    const knowledge = createKnowledge({ adapter });
    insertRecord('lesson_early', 'lesson', 1_000, SCOPES[0], null);
    insertRecord('fact_owner', 'fact', 2_000, SCOPES[0], 'telegram:chat-1:42');
    insertRecord('fact_elsewhere', 'fact', 2_500, { kind: 'project', id: 'other-scope' }, null);
    const created = await knowledge.createWork(
      {
        commandId: 'timeline-create',
        topic: 'work/item',
        summary: 'Item opened',
        set: { title: 'Item' },
        scopes: SCOPES,
      },
      ACCESS
    );
    commitmentId = created.commitmentId;
    await knowledge.reviseWork(
      {
        commandId: 'timeline-revise',
        commitmentId,
        summary: 'Item fixed',
        set: { status: 'done', title: 'Item renamed' },
      },
      ACCESS
    );
    // Write times are set so the window and the order are statements about the seeded rows.
    const revisions = adapter
      .prepare(
        'SELECT record_id, revision FROM commitment_assignments WHERE commitment_id = ? ORDER BY revision'
      )
      .all(commitmentId) as Array<{ record_id: string; revision: number }>;
    for (const { record_id, revision } of revisions) {
      adapter
        .prepare('UPDATE decisions SET created_at = ? WHERE id = ?')
        .run(2_000 + revision * 1_000, record_id);
    }
    dispatch = createDispatcher(createCatalog(coreActionRegistrations(knowledge, adapter)));
  });

  afterAll(async () => cleanupTestDB(dbPath));

  async function read(input: Record<string, unknown>) {
    const result = await dispatch({ action: 'memory.read:timeline', input }, { access: ACCESS });
    if (result.status !== 'completed') throw new Error(JSON.stringify(result));
    return result.data as {
      records: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
  }

  it('lists what was written in the window, newest first, with the item and turn behind it', async () => {
    const page = await read({ since: 1_500, until: 4_500 });

    expect(page.records.map((row) => row.id)).toEqual([
      expect.any(String),
      expect.any(String),
      'fact_owner',
    ]);
    expect(page.records.slice(0, 2)).toEqual([
      expect.objectContaining({
        recordKind: 'commitment',
        commitmentId,
        revision: 2,
        operation: 'revise',
        itemTitle: 'Item renamed',
        createdAt: 4_000,
      }),
      expect.objectContaining({
        recordKind: 'commitment',
        commitmentId,
        revision: 1,
        operation: 'create',
        itemTitle: 'Item renamed',
        createdAt: 3_000,
      }),
    ]);
    expect(page.records[2]).toEqual(
      expect.objectContaining({
        kind: 'fact',
        commitmentId: null,
        revision: null,
        operation: null,
        itemTitle: null,
        sourceMessageRef: 'telegram:chat-1:42',
        summary: 'Statement fact_owner',
      })
    );
    expect(page.nextCursor).toBeNull();
  });

  it('pages without overlap and leaves out records the reader does not admit', async () => {
    const first = await read({ limit: 2 });
    expect(first.records.map((row) => row.createdAt)).toEqual([4_000, 3_000]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await read({ limit: 2, cursor: first.nextCursor });
    expect(second.records.map((row) => row.id)).toEqual(['fact_owner', 'lesson_early']);
    expect(second.nextCursor).toBeNull();
  });
});
