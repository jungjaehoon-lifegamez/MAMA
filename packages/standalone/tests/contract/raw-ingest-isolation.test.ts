import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

import Database from '../../src/sqlite.js';
import { RawStore } from '../../src/connectors/framework/raw-store.js';
import { applyAgentStoreTablesMigration } from '../../src/db/migrations/agent-store-tables.js';

describe('Story M0: Raw ingest isolation contract', () => {
  let tmpDir: string;
  let mainDb: Database;
  let rawStore: RawStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mama-m0-isolation-'));
    mainDb = new Database(join(tmpDir, 'main.db'));
    applyAgentStoreTablesMigration(mainDb);
    mainDb.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        topic TEXT,
        decision TEXT,
        reasoning TEXT,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY,
        title TEXT,
        state TEXT,
        created_at INTEGER
      );
    `);
    rawStore = new RawStore(join(tmpDir, 'raw'));
  });

  afterEach(() => {
    rawStore?.close();
    mainDb?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('AC #1: RawStore writes stay isolated from memory and case stores', () => {
    it('inserting raw items via RawStore does not create decisions', () => {
      const before = mainDb.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };

      rawStore.save('telegram', [
        {
          sourceId: 'tg:1:msg:1',
          source: 'telegram',
          channel: 'tg:1',
          author: 'user1',
          content: 'Decision: adopt X next quarter',
          timestamp: new Date('2026-04-26T00:00:00Z'),
          type: 'message',
        },
      ]);

      const after = mainDb.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
      expect(after.n).toBe(before.n);
    });

    it('inserting raw items via RawStore does not create cases', () => {
      const before = mainDb.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number };

      rawStore.save('telegram', [
        {
          sourceId: 'tg:1:msg:2',
          source: 'telegram',
          channel: 'tg:1',
          author: 'user1',
          content: 'Bug found: API returns 500',
          timestamp: new Date('2026-04-26T00:01:00Z'),
          type: 'message',
        },
      ]);

      const after = mainDb.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number };
      expect(after.n).toBe(before.n);
    });
  });
});

describe('Story M0: Connector extraction kill switch', () => {
  it('audited connector extraction entrypoint has no direct memory or dead prompt calls', () => {
    const source = readFileSync(
      new URL('../../src/cli/runtime/connector-init.ts', import.meta.url),
      'utf8'
    );

    expect(findCallExpressions(source, 'saveMemory')).toEqual([]);
    expect(findCallExpressions(source, 'buildActivityExtractionPrompt')).toEqual([]);
    expect(findCallExpressions(source, 'buildSpokeExtractionPrompt')).toEqual([]);
  });

  it('connector observation extraction failures are surfaced instead of swallowed', () => {
    const source = readFileSync(
      new URL('../../src/cli/runtime/connector-init.ts', import.meta.url),
      'utf8'
    );
    const extractAndSaveBody = findVariableFunctionBody(source, 'extractAndSave');

    expect(extractAndSaveBody).toContain('buildEntityObservations');
    expect(extractAndSaveBody).toContain('entityObservationStore.upsertEntityObservations');
    expect(extractAndSaveBody).not.toContain('console.error');
    expect(extractAndSaveBody).toContain('throw new Error');
  });
});

function findCallExpressions(source: string, calleeName: string): number[] {
  const sourceFile = ts.createSourceFile(
    'connector-init.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const lines: number[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === calleeName) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart());
        lines.push(line + 1);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return lines;
}

function findVariableFunctionBody(source: string, variableName: string): string {
  const sourceFile = ts.createSourceFile(
    'connector-init.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let body = '';

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      ts.isArrowFunction(node.initializer) &&
      node.initializer.body
    ) {
      body = node.initializer.body.getText(sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return body;
}
