import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMemoryScope, openDatabase, type DatabaseHandle } from '../../src/db-manager.js';
import { listCheckpointsInAdapter, saveCheckpointInAdapter } from '../../src/memory/api.js';

const PERSONAL = [{ kind: 'user' as const, id: 'principal-member-test' }];

describe('scoped checkpoint persistence', () => {
  let root: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'scoped-checkpoint-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
    db = await openDatabase({ path: process.env.MAMA_DB_PATH! });
  });
  afterEach(async () => {
    await db?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the checkpoint and personal binding in one transaction', async () => {
    const id = await saveCheckpointInAdapter(
      db.adapter,
      'Personal checkpoint fixture',
      [],
      '',
      [],
      PERSONAL
    );
    expect(
      db.adapter
        .prepare(
          `
      SELECT s.kind, s.external_id AS id FROM checkpoint_scope_bindings b
      JOIN memory_scopes s ON s.id = b.scope_id WHERE b.checkpoint_id = ?
    `
        )
        .all(id)
    ).toEqual(PERSONAL);
    db.adapter
      .exec(`CREATE TRIGGER refuse_checkpoint_binding BEFORE INSERT ON checkpoint_scope_bindings
      BEGIN SELECT RAISE(ABORT, 'fixture binding failure'); END`);
    await expect(
      saveCheckpointInAdapter(db.adapter, 'Failed fixture', [], '', [], PERSONAL)
    ).rejects.toThrow('fixture binding failure');
    expect(db.adapter.prepare('SELECT COUNT(*) AS count FROM checkpoints').get()).toEqual({
      count: 1,
    });
  });

  it('filters checkpoint scopes before limiting, excluding legacy and other personal rows', async () => {
    const personal = db.adapter
      .prepare('INSERT INTO checkpoints (timestamp, summary) VALUES (?, ?)')
      .run(1, 'Personal fixture');
    const scopeId = ensureMemoryScope(db.adapter, 'user', PERSONAL[0].id);
    db.adapter
      .prepare(
        'INSERT INTO checkpoint_scope_bindings (checkpoint_id, scope_id, created_at) VALUES (?, ?, ?)'
      )
      .run(personal.lastInsertRowid, scopeId, 1);
    db.adapter
      .prepare('INSERT INTO checkpoints (timestamp, summary) VALUES (?, ?)')
      .run(3, 'Legacy fixture');
    const other = db.adapter
      .prepare('INSERT INTO checkpoints (timestamp, summary) VALUES (?, ?)')
      .run(2, 'Other fixture');
    const otherScope = ensureMemoryScope(db.adapter, 'user', 'principal-other-test');
    db.adapter
      .prepare(
        'INSERT INTO checkpoint_scope_bindings (checkpoint_id, scope_id, created_at) VALUES (?, ?, ?)'
      )
      .run(other.lastInsertRowid, otherScope, 2);
    expect(await listCheckpointsInAdapter(db.adapter, 1, PERSONAL)).toMatchObject([
      { summary: 'Personal fixture' },
    ]);
    expect(await listCheckpointsInAdapter(db.adapter, 10, [])).toEqual([]);
    expect(await listCheckpointsInAdapter(db.adapter, 10)).toHaveLength(3);
  });

  it('optionally includes unbound checkpoints alongside admitted scopes before LIMIT', async () => {
    const owner = [{ kind: 'user', id: 'principal-owner-test' }];
    for (const [timestamp, summary, scopes] of [
      [1, 'Legacy fixture', undefined],
      [2, 'Owner fixture', owner],
      [3, 'Member fixture', PERSONAL],
    ] as const) {
      const id = await saveCheckpointInAdapter(db.adapter, summary, [], '', [], scopes);
      db.adapter.prepare('UPDATE checkpoints SET timestamp = ? WHERE id = ?').run(timestamp, id);
    }
    expect(
      await listCheckpointsInAdapter(db.adapter, 2, owner, { includeUnbound: true })
    ).toMatchObject([{ summary: 'Owner fixture' }, { summary: 'Legacy fixture' }]);
    expect(
      await listCheckpointsInAdapter(db.adapter, 1, owner, { includeUnbound: true })
    ).toMatchObject([{ summary: 'Owner fixture' }]);
    expect(
      await listCheckpointsInAdapter(db.adapter, 10, [], { includeUnbound: true })
    ).toMatchObject([{ summary: 'Legacy fixture' }]);
    expect(await listCheckpointsInAdapter(db.adapter, 10, PERSONAL)).toMatchObject([
      { summary: 'Member fixture' },
    ]);
  });
});
