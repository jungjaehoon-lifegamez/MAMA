import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from '../../src/sqlite.js';
import { join } from 'node:path';
import {
  hashProcedureDocument,
  publishProcedureProjection,
} from '../../src/operator/procedure-projection.js';
let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mama-projection-'));
  path = join(dir, 'brief.md');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
describe('TG-05/TG-06 canonical procedure projection', () => {
  it('publishes atomically and records its hash', () => {
    writeFileSync(path, 'original');
    let recorded = '';
    expect(
      publishProcedureProjection({
        path,
        text: 'next',
        expectedFileHash: hashProcedureDocument('original'),
        onPublished: (hash) => {
          recorded = hash;
        },
      }).status
    ).toBe('projected');
    expect(recorded).toBe(hashProcedureDocument('next'));
    expect(readFileSync(path, 'utf8')).toBe('next');
    expect(readdirSync(dir)).toEqual(['brief.md']);
  });
  it('rejects two writers of the same revision', () => {
    writeFileSync(path, 'original');
    const expectedFileHash = hashProcedureDocument('original');
    expect(
      publishProcedureProjection({ path, text: 'first', expectedFileHash, onPublished: () => {} })
        .status
    ).toBe('projected');
    expect(
      publishProcedureProjection({ path, text: 'second', expectedFileHash, onPublished: () => {} })
        .status
    ).toBe('conflict');
    expect(readFileSync(path, 'utf8')).toBe('first');
  });
  it('preserves human edits during preparation', () => {
    writeFileSync(path, 'original');
    expect(
      publishProcedureProjection({
        path,
        text: 'next',
        expectedFileHash: hashProcedureDocument('original'),
        onPublished: () => {},
        beforePublish: () => writeFileSync(path, 'human edit'),
      }).status
    ).toBe('conflict');
    expect(readFileSync(path, 'utf8')).toBe('human edit');
    expect(readdirSync(dir)).toEqual(['brief.md']);
  });
  it('recovers a saved revision after crash before publication', () => {
    writeFileSync(path, 'original');
    const input = {
      path,
      text: 'committed revision',
      expectedFileHash: hashProcedureDocument('original'),
      onPublished: () => {},
    };
    expect(
      publishProcedureProjection({
        ...input,
        beforePublish: () => {
          throw new Error('crash hook');
        },
      }).status
    ).toBe('saved');
    expect(readFileSync(path, 'utf8')).toBe('original');
    expect(publishProcedureProjection(input).status).toBe('projected');
  });
  it('recovers publication before DB acknowledgement without duplicate content', () => {
    const input = { path, text: 'committed revision', expectedFileHash: null };
    expect(
      publishProcedureProjection({
        ...input,
        onPublished: () => {
          throw new Error('DB unavailable');
        },
      }).status
    ).toBe('saved');
    let acknowledged = false;
    expect(
      publishProcedureProjection({
        ...input,
        onPublished: () => {
          acknowledged = true;
        },
      }).status
    ).toBe('projected');
    expect(acknowledged).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(input.text);
  });
});

it('TG-06 refuses a simultaneous writer while the first owns the publication lock', () => {
  writeFileSync(path, 'original');
  const expectedFileHash = hashProcedureDocument('original');
  let nestedStatus = '';
  expect(
    publishProcedureProjection({
      path,
      text: 'first',
      expectedFileHash,
      onPublished: () => {},
      beforePublish: () => {
        nestedStatus = publishProcedureProjection({
          path,
          text: 'second',
          expectedFileHash,
          onPublished: () => {},
        }).status;
      },
    }).status
  ).toBe('projected');
  expect(nestedStatus).toBe('conflict');
  expect(readFileSync(path, 'utf8')).toBe('first');
});

it('TG-06 holds trusted serialization through file publication and acknowledgement', () => {
  let serialized = false;
  let calls = 0;
  const result = publishProcedureProjection({
    path,
    text: 'canonical',
    expectedFileHash: null,
    serialize: (publish) => {
      calls += 1;
      serialized = true;
      try {
        return publish();
      } finally {
        serialized = false;
      }
    },
    beforePublish: () => {
      expect(serialized).toBe(true);
      expect(readdirSync(dir).some((name) => name.endsWith('.projection-lock'))).toBe(false);
    },
    onPublished: () => {
      expect(serialized).toBe(true);
    },
  });
  expect(result.status).toBe('projected');
  expect(calls).toBe(1);
});

it('TG-06 propagates acknowledgement failure through the transaction then recovers', () => {
  let rolledBack = false;
  const serialize = (publish: () => ReturnType<typeof publishProcedureProjection>) => {
    try {
      return publish();
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  };
  const input = { path, text: 'committed procedure', expectedFileHash: null, serialize };
  expect(
    publishProcedureProjection({
      ...input,
      onPublished: () => {
        throw new Error('ack failed');
      },
    }).status
  ).toBe('saved');
  expect(rolledBack).toBe(true);
  expect(readdirSync(dir)).toEqual(['brief.md']);
  expect(publishProcedureProjection({ ...input, onPublished: () => {} }).status).toBe('projected');
});

it('TG-06 rolls back the real SQLite acknowledgement and retries its already published file', () => {
  const db = new Database(join(dir, 'operator.db'));
  db.exec('CREATE TABLE acknowledgement (hash TEXT)');
  try {
    const input = {
      path,
      text: 'committed revision',
      expectedFileHash: null,
      serialize: (publish: () => ReturnType<typeof publishProcedureProjection>) =>
        db.transaction(publish, 'immediate')(),
    };
    const failed = publishProcedureProjection({
      ...input,
      onPublished: (hash) => {
        db.prepare('INSERT INTO acknowledgement VALUES (?)').run(hash);
        throw new Error('process interrupted before transaction commit');
      },
    });
    expect(failed.status).toBe('saved');
    expect(db.prepare('SELECT * FROM acknowledgement').all()).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(input.text);
    expect(
      publishProcedureProjection({
        ...input,
        onPublished: (hash) => {
          db.prepare('INSERT INTO acknowledgement VALUES (?)').run(hash);
        },
      }).status
    ).toBe('projected');
    expect(db.prepare('SELECT * FROM acknowledgement').all()).toEqual([
      { hash: hashProcedureDocument(input.text) },
    ]);
  } finally {
    db.close();
  }
});

it.each(['beforePublish', 'onPublished'] as const)(
  'TG-06 recovers after real process death at %s with SQLite serialization',
  (hook) => {
    const dbPath = join(dir, 'operator.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE canonical (body TEXT); CREATE TABLE acknowledged (hash TEXT)');
    db.prepare('INSERT INTO canonical VALUES (?)').run('saved canonical revision');
    db.close();
    writeFileSync(path, 'original');
    const publisherUrl = new URL('../../src/operator/procedure-projection.ts', import.meta.url)
      .href;
    const sqliteUrl = new URL('../../src/sqlite.ts', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--require',
        'tsx/cjs',
        '-e',
        `
    const { default: Database } = require(${JSON.stringify(fileURLToPath(sqliteUrl))});
    const { publishProcedureProjection, hashProcedureDocument } = require(${JSON.stringify(fileURLToPath(publisherUrl))});
    const [dbPath, path, hook] = process.argv.slice(1);
    const db = new Database(dbPath);
    const text = db.prepare('SELECT body FROM canonical').get().body;
    const die = () => process.kill(process.pid, 'SIGKILL');
    publishProcedureProjection({ path, text, expectedFileHash: hashProcedureDocument('original'),
      serialize: publish => db.transaction(publish, 'immediate')(),
      beforePublish: hook === 'beforePublish' ? die : undefined,
      onPublished: hash => { die(); db.prepare('INSERT INTO acknowledged VALUES (?)').run(hash); }
    });
  `,
        dbPath,
        path,
        hook,
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        encoding: 'utf8',
        timeout: 10000,
      }
    );
    expect(child.signal, child.stderr).toBe('SIGKILL');
    expect(readdirSync(dir).some((name) => name.endsWith('.projection-lock'))).toBe(false);
    const reopened = new Database(dbPath);
    try {
      const row = reopened.prepare('SELECT body FROM canonical').get() as { body: string };
      expect(reopened.prepare('SELECT * FROM acknowledged').all()).toEqual([]);
      expect(
        publishProcedureProjection({
          path,
          text: row.body,
          expectedFileHash: hashProcedureDocument('original'),
          serialize: (publish) => reopened.transaction(publish, 'immediate')(),
          onPublished: (hash) => {
            reopened.prepare('INSERT INTO acknowledged VALUES (?)').run(hash);
          },
        }).status
      ).toBe('projected');
      expect(readFileSync(path, 'utf8')).toBe(row.body);
      expect(reopened.prepare('SELECT * FROM acknowledged').all()).toHaveLength(1);
    } finally {
      reopened.close();
    }
  }
);
