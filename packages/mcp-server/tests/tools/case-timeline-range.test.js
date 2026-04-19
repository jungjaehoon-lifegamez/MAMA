/**
 * Tests for case_timeline_range MCP tool
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  caseTimelineRangeTool,
  resetCaseTimelineRangeAdapterForTest,
  setCaseTimelineRangeAdapterForTest,
} from '../../src/tools/case-timeline-range.js';
import { createMemoryTools } from '../../src/tools/index.js';

const CASE_ID = '11111111-1111-4111-8111-111111111111';

function applyMigrations(db) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = resolve(testDir, '../../../mama-core/db/migrations');

  for (const file of readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
}

function createAdapter(db) {
  return {
    prepare(sql) {
      return db.prepare(sql);
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
  };
}

function seedTimelineCase(db) {
  const now = '2026-04-18T00:00:00.000Z';
  db.prepare(
    `
      INSERT INTO case_truth (
        case_id, current_wiki_path, title, status, created_at, updated_at
      )
      VALUES (?, ?, ?, 'active', ?, ?)
    `
  ).run(CASE_ID, 'cases/timeline-case.md', 'Timeline Case', now, now);

  db.prepare(
    `
      INSERT INTO decisions (
        id, topic, decision, reasoning, confidence, created_at, updated_at,
        event_date, event_datetime
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    'dec-timeline-range',
    'timeline/range',
    'Use bounded case timelines',
    'The UI needs a focused case history window.',
    0.9,
    Date.parse('2026-04-10T12:00:00.000Z'),
    Date.parse('2026-04-10T12:00:00.000Z'),
    '2026-04-10',
    Date.parse('2026-04-10T12:00:00.000Z')
  );

  db.prepare(
    `
      INSERT INTO case_memberships (
        case_id, source_type, source_id, role, confidence, reason, status,
        added_by, added_at, updated_at, user_locked
      )
      VALUES (?, 'decision', ?, 'primary', 0.91, 'seeded test membership',
              'active', 'wiki-compiler', ?, ?, 0)
    `
  ).run(CASE_ID, 'dec-timeline-range', now, now);
}

describe('case_timeline_range MCP tool', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    seedTimelineCase(db);
    setCaseTimelineRangeAdapterForTest(createAdapter(db));
  });

  afterEach(() => {
    resetCaseTimelineRangeAdapterForTest();
    db.close();
  });

  it('is registered in createMemoryTools', () => {
    const tools = createMemoryTools();

    expect(tools.case_timeline_range).toBeDefined();
    expect(tools.case_timeline_range.name).toBe('case_timeline_range');
    expect(tools.case_timeline_range.name).toBe(caseTimelineRangeTool.name);
  });

  it('returns a plain case timeline range object', async () => {
    const result = await caseTimelineRangeTool.handler({
      case_id: CASE_ID,
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-30T23:59:59.999Z',
      order: 'asc',
      limit: 10,
    });

    expect(result).toEqual(
      expect.objectContaining({
        terminal_case_id: CASE_ID,
        resolved_via_case_id: null,
        chain: [CASE_ID],
      })
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        item_type: 'decision',
        source_type: 'decision',
        source_id: 'dec-timeline-range',
        title: 'timeline/range',
        role: 'primary',
        membership_reason: 'seeded test membership',
      })
    );
  });
});
