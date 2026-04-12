import { describe, it, expect, beforeEach } from 'vitest';
import Database from '../../src/sqlite.js';
import {
  initAgentTables,
  createAgentVersion,
  getLatestVersion,
  getAgentVersion,
  listVersions,
  upsertMetrics,
  getMetrics,
  compareVersionMetrics,
} from '../../src/db/agent-store.js';

describe('STORY-V019 - agent-store', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  describe('AC1 - initAgentTables creates required tables', () => {
    it('creates agent_versions and agent_metrics tables', () => {
      initAgentTables(db);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_versions','agent_metrics')"
        )
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(2);
    });

    it('is idempotent', () => {
      initAgentTables(db);
      initAgentTables(db);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_versions','agent_metrics')"
        )
        .all();
      expect(tables).toHaveLength(2);
    });

    it('upgrades legacy agent_activity tables with validation linkage columns', () => {
      db.exec(`
        CREATE TABLE agent_activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          agent_version INTEGER NOT NULL,
          type TEXT NOT NULL,
          input_summary TEXT,
          output_summary TEXT,
          tokens_used INTEGER DEFAULT 0,
          tools_called TEXT,
          duration_ms INTEGER DEFAULT 0,
          score REAL,
          details TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      initAgentTables(db);

      const columns = db.prepare('PRAGMA table_info(agent_activity)').all() as Array<{
        name: string;
      }>;
      expect(columns.some((column) => column.name === 'run_id')).toBe(true);
      expect(columns.some((column) => column.name === 'execution_status')).toBe(true);
      expect(columns.some((column) => column.name === 'trigger_reason')).toBe(true);
    });
  });

  describe('AC2 - version history is persisted and versioned', () => {
    beforeEach(() => initAgentTables(db));

    it('creates version 1 for new agent', () => {
      const v = createAgentVersion(db, {
        agent_id: 'conductor',
        snapshot: { model: 'claude-sonnet-4-6', tier: 1 },
        persona_text: 'You are Conductor.',
        change_note: 'Initial creation',
      });
      expect(v.version).toBe(1);
      expect(v.agent_id).toBe('conductor');
    });

    it('auto-increments version', () => {
      createAgentVersion(db, { agent_id: 'dev', snapshot: { tier: 1 } });
      const v2 = createAgentVersion(db, {
        agent_id: 'dev',
        snapshot: { tier: 2 },
        change_note: 'Tier upgrade',
      });
      expect(v2.version).toBe(2);
    });

    it('getLatestVersion returns highest version', () => {
      createAgentVersion(db, { agent_id: 'dev', snapshot: { tier: 1 } });
      createAgentVersion(db, { agent_id: 'dev', snapshot: { tier: 2 } });
      const latest = getLatestVersion(db, 'dev');
      expect(latest?.version).toBe(2);
    });

    it('getLatestVersion returns null for unknown agent', () => {
      expect(getLatestVersion(db, 'unknown')).toBeNull();
    });

    it('getAgentVersion returns specific version', () => {
      createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 1 } });
      createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 2 } });
      const v1 = getAgentVersion(db, 'dev', 1);
      expect(v1?.version).toBe(1);
      expect(JSON.parse(v1!.snapshot)).toEqual({ v: 1 });
    });

    it('listVersions returns all in desc order', () => {
      createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 1 } });
      createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 2 } });
      createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 3 } });
      const versions = listVersions(db, 'dev');
      expect(versions).toHaveLength(3);
      expect(versions[0].version).toBe(3);
    });

    it('skips version bump on identical snapshot (no-op)', () => {
      const snap = { model: 'sonnet', tier: 1 };
      createAgentVersion(db, { agent_id: 'dev', snapshot: snap });
      const v2 = createAgentVersion(db, { agent_id: 'dev', snapshot: snap });
      expect(v2.version).toBe(1);
      expect(listVersions(db, 'dev')).toHaveLength(1);
    });

    it('creates a new version when only persona text changes', () => {
      const snap = { model: 'sonnet', tier: 1 };
      createAgentVersion(db, {
        agent_id: 'dev',
        snapshot: snap,
        persona_text: 'Old persona',
      });
      const v2 = createAgentVersion(db, {
        agent_id: 'dev',
        snapshot: snap,
        persona_text: 'New persona',
      });
      expect(v2.version).toBe(2);
      expect(v2.persona_text).toBe('New persona');
      expect(listVersions(db, 'dev')).toHaveLength(2);
    });
  });

  describe('AC3 - metrics aggregate and compare across versions', () => {
    beforeEach(() => initAgentTables(db));

    it('inserts new metrics row', () => {
      upsertMetrics(db, {
        agent_id: 'conductor',
        agent_version: 1,
        period_start: '2026-04-10',
        input_tokens: 1000,
        output_tokens: 500,
        tool_calls: 10,
      });
      const rows = getMetrics(db, 'conductor', '2026-04-01', '2026-04-11');
      expect(rows).toHaveLength(1);
      expect(rows[0].input_tokens).toBe(1000);
    });

    it('upserts: adds to existing row for same period', () => {
      const base = {
        agent_id: 'dev',
        agent_version: 2,
        period_start: '2026-04-10',
      };
      upsertMetrics(db, { ...base, input_tokens: 100, output_tokens: 50, tool_calls: 5 });
      upsertMetrics(db, { ...base, input_tokens: 200, output_tokens: 100, tool_calls: 3 });
      const rows = getMetrics(db, 'dev', '2026-04-10', '2026-04-11');
      expect(rows).toHaveLength(1);
      expect(rows[0].input_tokens).toBe(300);
      expect(rows[0].tool_calls).toBe(8);
    });

    it('updates avg_response_ms on metric upsert', () => {
      const base = {
        agent_id: 'dev',
        agent_version: 2,
        period_start: '2026-04-10',
      };
      upsertMetrics(db, { ...base, avg_response_ms: 1200 });
      upsertMetrics(db, { ...base, avg_response_ms: 900 });
      const rows = getMetrics(db, 'dev', '2026-04-10', '2026-04-11');
      expect(rows).toHaveLength(1);
      expect(rows[0].avg_response_ms).toBe(1050);
    });

    it('compareVersionMetrics returns aggregated diff', () => {
      upsertMetrics(db, {
        agent_id: 'dev',
        agent_version: 1,
        period_start: '2026-04-10',
        input_tokens: 1000,
        output_tokens: 500,
        tool_calls: 10,
      });
      upsertMetrics(db, {
        agent_id: 'dev',
        agent_version: 2,
        period_start: '2026-04-10',
        input_tokens: 400,
        output_tokens: 200,
        tool_calls: 5,
      });
      const cmp = compareVersionMetrics(db, 'dev', 1, 2);
      expect(cmp.version_a.input_tokens).toBe(1000);
      expect(cmp.version_b.input_tokens).toBe(400);
    });

    it('compareVersionMetrics throws when a requested version has no metrics rows', () => {
      upsertMetrics(db, {
        agent_id: 'dev',
        agent_version: 1,
        period_start: '2026-04-10',
        input_tokens: 100,
      });

      expect(() => compareVersionMetrics(db, 'dev', 1, 99)).toThrow(
        "No metrics found for agent 'dev' version 99"
      );
    });
  });
});
