import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import { buildMemoryScopeId, ensureMemoryScope } from '../../src/db-manager.js';
import * as core from '../../src/index.js';

describe('explicit record user-scope moves', () => {
  let db: NodeSQLiteAdapter;
  let dir: string;
  let fromScope: string;
  const move = (recordIds: Array<string | number>, extra = {}) =>
    core.moveRecordsUserScope(db, {
      recordIds,
      fromPrincipalId: 'common',
      toPrincipalId: 'person',
      ...extra,
    });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'move-user-scope-'));
    process.env.MAMA_DB_PATH = join(dir, 'test.db');
    db = new NodeSQLiteAdapter({ dbPath: process.env.MAMA_DB_PATH });
    db.connect();
    db.runMigrations(join(__dirname, '../../db/migrations'));
    fromScope = ensureMemoryScope(db, 'user', 'common');
    const scope = {
      memoryScopeKind: 'user',
      memoryScopeId: 'common',
      channel: 'test:dm',
      scopes: [
        { kind: 'user', externalId: 'common', scopeId: fromScope, primary: true },
        { kind: 'project', id: 'shared' },
      ],
    };
    for (const id of ['obs-a', 'obs-untouched'])
      db.prepare(
        'INSERT INTO observation_versions (observation_id, source, source_id, body, observed_at, content_hash, metadata_json, scope_json, memory_scope_kind, memory_scope_id, author) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)'
      ).run(
        id,
        'test',
        id,
        'original body',
        id,
        '{}',
        JSON.stringify(scope),
        'user',
        'common',
        'common'
      );
    for (const id of [1, 2])
      db.prepare('INSERT INTO checkpoints (id, timestamp, summary) VALUES (?, 1, ?)').run(
        id,
        'checkpoint content'
      );
    db.prepare(
      'INSERT INTO checkpoint_scope_bindings (checkpoint_id, scope_id, is_primary, created_at) VALUES (1, ?, 1, 5)'
    ).run(fromScope);
  });
  afterEach(() => {
    db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves all current scope copies for named records and preserves other scopes and authored content', () => {
    const result = move(['obs-a', 1]);
    expect(result.records).toEqual({ observations: 1, checkpoints: 1 });
    expect(result.stores).toEqual({
      memory_scopes: 1,
      checkpoint_scope_bindings: 1,
      observation_versions: 1,
    });
    const observation = db
      .prepare('SELECT * FROM observation_versions WHERE observation_id=?')
      .get('obs-a') as Record<string, unknown>;
    expect(observation.memory_scope_id).toBe('person');
    expect(observation.author).toBe('common');
    expect(observation.body).toBe('original body');
    expect(JSON.parse(String(observation.scope_json))).toEqual({
      memoryScopeKind: 'user',
      memoryScopeId: 'person',
      channel: 'test:dm',
      scopes: [
        {
          kind: 'user',
          externalId: 'person',
          scopeId: buildMemoryScopeId('user', 'person'),
          primary: true,
        },
        { kind: 'project', id: 'shared' },
      ],
    });
    expect(
      db.prepare('SELECT scope_id FROM checkpoint_scope_bindings WHERE checkpoint_id=1').get()
    ).toEqual({ scope_id: buildMemoryScopeId('user', 'person') });
    expect(
      db
        .prepare(
          "SELECT memory_scope_id FROM observation_versions WHERE observation_id='obs-untouched'"
        )
        .get()
    ).toEqual({ memory_scope_id: 'common' });
    expect(move(['obs-a', 1]).records).toEqual({
      observations: 0,
      checkpoints: 0,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('changes an observation author only when explicitly requested', () => {
    move(['obs-a']);
    db.prepare(
      "UPDATE observation_versions SET author='host' WHERE observation_id='obs-untouched'"
    ).run();
    expect(
      move(['obs-a', 'obs-untouched'], { authorPrincipalId: 'person' }).records.observations
    ).toBe(2);
    expect(
      db.prepare("SELECT author FROM observation_versions WHERE observation_id='obs-a'").get()
    ).toEqual({ author: 'person' });
    expect(
      db
        .prepare("SELECT author FROM observation_versions WHERE observation_id='obs-untouched'")
        .get()
    ).toEqual({ author: 'host' });
    expect(
      move(['obs-a', 'obs-untouched'], { authorPrincipalId: 'person' }).records.observations
    ).toBe(0);
  });

  it('binds specifically named unscoped checkpoints only when requested', () => {
    expect(move([2]).records.checkpoints).toBe(0);
    expect(
      db.prepare('SELECT * FROM checkpoint_scope_bindings WHERE checkpoint_id=2').all()
    ).toEqual([]);
    const result = move([2], { bindUnscoped: true });
    expect(result.records.checkpoints).toBe(1);
    expect(result.stores.checkpoint_scope_bindings).toBe(1);
    expect(
      db.prepare('SELECT scope_id FROM checkpoint_scope_bindings WHERE checkpoint_id=2').get()
    ).toEqual({ scope_id: buildMemoryScopeId('user', 'person') });
  });

  it('merges an existing destination binding without losing the primary flag', () => {
    const toScope = ensureMemoryScope(db, 'user', 'person');
    db.prepare(
      'INSERT INTO checkpoint_scope_bindings (checkpoint_id, scope_id, is_primary, created_at) VALUES (?, ?, 0, 7)'
    ).run(1, toScope);
    expect(move([1]).records.checkpoints).toBe(1);
    expect(
      db
        .prepare('SELECT scope_id,is_primary FROM checkpoint_scope_bindings WHERE checkpoint_id=?')
        .all(1)
    ).toEqual([{ scope_id: toScope, is_primary: 1 }]);
  });

  it('rolls back every store if a named record is missing or scope JSON is malformed', () => {
    expect(() => move([1, 'missing'])).toThrow(/not found/);
    expect(
      db.prepare('SELECT scope_id FROM checkpoint_scope_bindings WHERE checkpoint_id=1').get()
    ).toEqual({ scope_id: fromScope });
    db.prepare(
      "UPDATE observation_versions SET scope_json='not json' WHERE observation_id='obs-a'"
    ).run();
    expect(() => move([1, 'obs-a'])).toThrow(/scope_json/);
    expect(
      db.prepare('SELECT scope_id FROM checkpoint_scope_bindings WHERE checkpoint_id=1').get()
    ).toEqual({ scope_id: fromScope });
    expect(
      db.prepare("SELECT id FROM memory_scopes WHERE kind='user' AND external_id='person'").get()
    ).toBeUndefined();
  });
});
