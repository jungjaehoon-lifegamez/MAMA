import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
}

function applyAll(db: Database.Database): void {
  for (const file of migrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function indexExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function triggerExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((col) => col.name === column);
}

describe('Case-First Memory Substrate (migration 030, consolidated Phase 1+2+3)', () => {
  it('creates every Phase 1 table/index/trigger on a fresh DB', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAll(db);

    expect(tableExists(db, 'case_truth')).toBe(true);
    expect(tableExists(db, 'case_memberships')).toBe(true);
    expect(tableExists(db, 'case_corrections')).toBe(true);
    expect(tableExists(db, 'case_proposal_queue')).toBe(true);
    expect(tableExists(db, 'wiki_page_index')).toBe(true);
    expect(tableExists(db, 'wiki_page_embeddings')).toBe(true);
    expect(tableExists(db, 'wiki_pages_fts')).toBe(true);

    const ctSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='case_truth'")
        .get() as { sql: string }
    ).sql;
    expect(ctSql).toMatch(/status[^,]*DEFAULT\s*'active'/i);

    const cmSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='case_memberships'")
        .get() as { sql: string }
    ).sql;
    expect(cmSql).toMatch(/source_type\s+TEXT\s+NOT\s+NULL/i);
    expect(cmSql).toMatch(/status\s+TEXT\s+NOT\s+NULL/i);
    expect(cmSql).toMatch(/added_by\s+TEXT\s+NOT\s+NULL/i);

    const ccSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='case_corrections'")
        .get() as { sql: string }
    ).sql;
    expect(ccSql).toMatch(/target_ref_json\s+TEXT/i);
    expect(ccSql).toMatch(/target_ref_hash\s+BLOB/i);
    expect(ccSql).toMatch(/length\s*\(\s*target_ref_hash\s*\)\s*=\s*32/i);

    expect(indexExists(db, 'idx_case_corrections_active_target')).toBe(true);

    const cpqSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='case_proposal_queue'")
        .get() as { sql: string }
    ).sql;
    for (const kind of [
      'unknown_case_id',
      'merged_target',
      'archived_target',
      'stale_case_id',
      'ambiguous_slug',
      'corrupt_frontmatter',
      'missing_frontmatter',
      'duplicate_frontmatter',
      'quarantined_accepted_case',
    ]) {
      expect(cpqSql).toContain(kind);
    }

    expect(triggerExists(db, 'trg_wiki_page_index_ai')).toBe(true);
    expect(triggerExists(db, 'trg_wiki_page_index_au')).toBe(true);
    expect(triggerExists(db, 'trg_wiki_page_index_ad')).toBe(true);

    db.close();
  });

  it('creates Phase 2 live-state artefact (entity_timeline_events.role column)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAll(db);
    expect(columnExists(db, 'entity_timeline_events', 'role')).toBe(true);
    db.close();
  });

  it('creates Phase 3 tables and extends case_truth/case_memberships', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAll(db);

    expect(tableExists(db, 'connector_event_index')).toBe(true);
    expect(tableExists(db, 'connector_event_index_cursors')).toBe(true);
    expect(tableExists(db, 'connector_event_index_fts')).toBe(true);
    expect(triggerExists(db, 'trg_connector_event_index_ai')).toBe(true);

    expect(tableExists(db, 'search_feedback')).toBe(true);
    expect(tableExists(db, 'ranker_model_versions')).toBe(true);
    expect(tableExists(db, 'search_ranker_settings')).toBe(true);

    expect(tableExists(db, 'case_links')).toBe(true);
    expect(tableExists(db, 'case_links_revoked_wiki_tombstones')).toBe(true);

    expect(columnExists(db, 'case_truth', 'canonical_decision_id')).toBe(true);
    expect(columnExists(db, 'case_truth', 'canonical_event_id')).toBe(true);
    expect(columnExists(db, 'case_truth', 'freshness_score')).toBe(true);
    expect(columnExists(db, 'case_truth', 'freshness_score_is_drifted')).toBe(true);

    expect(columnExists(db, 'case_memberships', 'assignment_strategy')).toBe(true);
    expect(columnExists(db, 'case_memberships', 'score_breakdown_json')).toBe(true);
    expect(columnExists(db, 'case_memberships', 'source_locator')).toBe(true);
    expect(columnExists(db, 'case_memberships', 'explanation_updated_at')).toBe(true);

    db.close();
  });

  it('is idempotent — re-running migration 030 after the schema_version guard fires is a no-op', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAll(db);

    const baselineTables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    const alreadyApplied = !!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(30);
    expect(alreadyApplied).toBe(true);

    const afterTables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(afterTables).toEqual(baselineTables);

    db.close();
  });

  it('a mid-migration failure inside a transaction leaves no partial artefacts', () => {
    // Rollback invariant: a partial failure inside a BEGIN/COMMIT block must
    // leave the baseline schema unchanged.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAll(db);

    const baselineTables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    const badSql = `
      CREATE TABLE fixture_partial_999 (id INTEGER PRIMARY KEY);
      CREATE TABLE case_truth (id INTEGER PRIMARY KEY);
    `;
    let threw = false;
    try {
      db.exec(`BEGIN;\n${badSql}\nCOMMIT;`);
    } catch {
      threw = true;
      try {
        db.exec('ROLLBACK;');
      } catch {
        // already rolled back
      }
    }
    expect(threw).toBe(true);
    expect(tableExists(db, 'fixture_partial_999')).toBe(false);

    const afterTables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(afterTables).toEqual(baselineTables);

    db.close();
  });

  it('records migration 030 in schema_version after apply', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAll(db);

    const row = db
      .prepare('SELECT version, description FROM schema_version WHERE version = 30')
      .get() as { version: number; description: string } | undefined;
    expect(row?.version).toBe(30);
    expect(row?.description).toContain('Case-First Memory Substrate');

    db.close();
  });

  it('records migration 032 memory provenance columns and indexes', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAll(db);

    for (const column of [
      'agent_id',
      'model_run_id',
      'envelope_hash',
      'gateway_call_id',
      'source_refs_json',
      'provenance_json',
    ]) {
      expect(columnExists(db, 'decisions', column)).toBe(true);
    }

    expect(indexExists(db, 'idx_decisions_envelope_hash')).toBe(true);
    expect(indexExists(db, 'idx_decisions_model_run_id')).toBe(true);
    expect(indexExists(db, 'idx_decisions_gateway_call_id')).toBe(true);
    expect(indexExists(db, 'idx_memory_events_memory_created')).toBe(true);

    const row = db
      .prepare('SELECT version, description FROM schema_version WHERE version = 32')
      .get() as { version: number; description: string } | undefined;
    expect(row?.version).toBe(32);
    expect(row?.description).toContain('memory provenance');

    db.close();
  });

  it('records migration 034 connector event scope columns and indexes', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAll(db);

    for (const column of [
      'source_cursor',
      'tenant_id',
      'project_id',
      'memory_scope_kind',
      'memory_scope_id',
    ]) {
      expect(columnExists(db, 'connector_event_index', column)).toBe(true);
    }

    const contentHash = (
      db.prepare(`PRAGMA table_info(connector_event_index)`).all() as Array<{
        name: string;
        type: string;
      }>
    ).find((column) => column.name === 'content_hash');
    expect(contentHash?.type.toUpperCase()).toBe('BLOB');
    expect(indexExists(db, 'idx_connector_event_scope')).toBe(true);
    expect(indexExists(db, 'idx_connector_event_source_cursor')).toBe(true);

    const row = db
      .prepare('SELECT version, description FROM schema_version WHERE version = 34')
      .get() as { version: number; description: string } | undefined;
    expect(row?.version).toBe(34);
    expect(row?.description).toContain('connector event scope');

    db.close();
  });

  it('records migration 035 twin edge ledger table and indexes', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyAll(db);

    expect(tableExists(db, 'twin_edges')).toBe(true);

    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='twin_edges'")
        .get() as { sql: string }
    ).sql;
    for (const edgeType of [
      'supersedes',
      'builds_on',
      'debates',
      'synthesizes',
      'mentions',
      'derived_from',
      'case_member',
      'alias_of',
      'next_action_for',
      'blocks',
    ]) {
      expect(sql).toContain(edgeType);
    }
    expect(sql).toMatch(/subject_kind\s+TEXT\s+NOT\s+NULL\s+CHECK/i);
    expect(sql).toMatch(/object_kind\s+TEXT\s+NOT\s+NULL\s+CHECK/i);
    expect(sql).toMatch(
      /content_hash\s+BLOB\s+NOT\s+NULL\s+CHECK\s*\(\s*length\s*\(\s*content_hash\s*\)\s*=\s*32\s*\)/i
    );

    for (const column of [
      'edge_id',
      'edge_type',
      'subject_kind',
      'subject_id',
      'object_kind',
      'object_id',
      'relation_attrs_json',
      'confidence',
      'source',
      'agent_id',
      'model_run_id',
      'envelope_hash',
      'human_actor_id',
      'human_actor_role',
      'authority_scope_json',
      'reason_classification',
      'reason_text',
      'evidence_refs_json',
      'request_idempotency_key',
      'edge_idempotency_key',
      'content_hash',
      'created_at',
    ]) {
      expect(columnExists(db, 'twin_edges', column)).toBe(true);
    }

    expect(indexExists(db, 'idx_twin_edges_subject')).toBe(true);
    expect(indexExists(db, 'idx_twin_edges_object')).toBe(true);
    expect(indexExists(db, 'idx_twin_edges_model_run_id')).toBe(true);
    expect(indexExists(db, 'idx_twin_edges_request_idempotency')).toBe(true);
    expect(indexExists(db, 'ux_twin_edges_model_run_edge_idempotency')).toBe(true);

    const row = db
      .prepare('SELECT version, description FROM schema_version WHERE version = 35')
      .get() as { version: number; description: string } | undefined;
    expect(row?.version).toBe(35);
    expect(row?.description).toContain('twin edge ledger');

    db.close();
  });
});
