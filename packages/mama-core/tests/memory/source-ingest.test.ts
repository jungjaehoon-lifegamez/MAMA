import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { ingestSource } from '../../src/knowledge/index.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

describe('PR4B source.ingest: one immutable observation per command', () => {
  let dbPath = '';
  const access = {
    principalId: 'principal-test',
    agentId: 'agent-test',
    scopes: [{ kind: 'project' as const, id: 'scope-test' }],
  };

  beforeAll(async () => {
    dbPath = await initTestDB('source-ingest');
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM source_commands').run();
    db.prepare('DELETE FROM command_bindings').run();
    db.prepare('DELETE FROM observation_versions').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM decisions').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('stores exactly one observation and no judgment record', async () => {
    const receipt = await ingestSource(
      {
        commandId: 'src-1',
        source: { connector: 'conversation:test', id: 'turn-1' },
        body: 'raw conversation text',
        scopes: access.scopes,
      },
      access
    );
    expect(receipt.status).toBe('committed');
    expect(receipt.observationId).toMatch(/^obs_/);

    const db = getAdapter();
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM observation_versions WHERE observation_id = ?')
        .get(receipt.observationId)
    ).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 0 });
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM memory_events WHERE memory_id = ?')
        .get(receipt.observationId)
    ).toEqual({ n: 1 });
    const binding = db
      .prepare('SELECT action, receipt_kind FROM command_bindings WHERE command_id = ?')
      .get('src-1') as { action: string; receipt_kind: string };
    expect(binding).toEqual({ action: 'source.ingest', receipt_kind: 'observation' });
  });

  it('replays the stored receipt for an identical command', async () => {
    const command = {
      commandId: 'src-replay',
      source: { connector: 'conversation:test', id: 'turn-2' },
      body: 'same raw body',
      observedAt: 1700000000000,
      scopes: access.scopes,
    };
    const first = await ingestSource(command, access);
    const second = await ingestSource(command, access);
    expect(second).toEqual(first);
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM observation_versions').get()).toEqual({
      n: 1,
    });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM memory_events').get()).toEqual({ n: 1 });
  });

  it('rejects a different payload bound to the same command id', async () => {
    const command = {
      commandId: 'src-conflict',
      source: { connector: 'conversation:test', id: 'turn-3' },
      body: 'first body',
      scopes: access.scopes,
    };
    await ingestSource(command, access);
    await expect(
      ingestSource({ ...command, body: 'different body' }, access)
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM observation_versions').get()).toEqual({
      n: 1,
    });
  });

  it('rejects a scope outside the admitted access before writing', async () => {
    await expect(
      ingestSource(
        {
          commandId: 'src-scope-denied',
          source: { connector: 'conversation:test', id: 'turn-4' },
          body: 'scope escape attempt',
          scopes: [{ kind: 'project', id: 'not-admitted' }],
        },
        access
      )
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM observation_versions').get()).toEqual({
      n: 0,
    });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM command_bindings').get()).toEqual({
      n: 0,
    });
  });

  it('rejects a blank body before writing', async () => {
    await expect(
      ingestSource(
        {
          commandId: 'src-blank',
          source: { connector: 'conversation:test', id: 'turn-5' },
          body: '   ',
          scopes: access.scopes,
        },
        access
      )
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM observation_versions').get()).toEqual({
      n: 0,
    });
  });
});
