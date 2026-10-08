import { readFileSync } from 'node:fs';
import { readDecisionListing, readSavedTimeline } from '../../src/memory/dashboard-read.js';
import { readDecisionWithEdges } from '../../src/memory/decision-links.js';
import { listDecisionsInAdapter, suggestInAdapter } from '../../src/memory/api.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureMemoryScope } from '../../src/db-manager.js';
import * as core from '../../src/index.js';
import { NativeInputJournal } from '../../src/runtime/native-input-journal.js';
import { canonicalizeJSON } from '../../src/canonicalize.js';
import { Mailbox } from '../../src/runtime/mailbox.js';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import { createPrincipalRepository } from '../../src/identity/principal-repository.js';
import { appendJudgment } from '../../src/knowledge/judgments.js';
import { ingestSource } from '../../src/knowledge/source-ingest.js';
import { createWork, readWork, reviseWork } from '../../src/knowledge/commitments.js';
import {
  queryDecisionGraph,
  querySemanticEdges,
  getGraphTimeline,
  queryGraph,
} from '../../src/knowledge/graph-query.js';
import {
  readMemoryRecordById,
  readMemoryRecordsInScopes,
  recallMemory,
} from '../../src/memory/api.js';
import { assertTwinRefsVisible, visibleTwinRefKeys } from '../../src/knowledge/access.js';
import type { TwinVisibility } from '../../src/knowledge/twin-edge-types.js';
import { getMemoryProvenance } from '../../src/memory/provenance-query.js';
import { resolveMemoryProvenanceLive } from '../../src/memory/provenance-live.js';
import { readObservationVersion } from '../../src/knowledge/observations.js';
import { readGraphNodes } from '../../src/memory/graph-read.js';
import { fts5Search } from '../../src/knowledge/search.js';

// CJK words come from a fixture: the trigram index is what this exercises, and source stays English.
const { privateSummary: PRIVATE_SUMMARY, privateTrigram: PRIVATE_TRIGRAM } = JSON.parse(
  readFileSync(new URL('../fixtures/principal-records.json', import.meta.url), 'utf8')
) as { privateSummary: string; privateTrigram: string };

const migrations = join(__dirname, '../../db/migrations');
const vector = [1, 0, 0];

describe('principal record export and erasure', () => {
  let dir: string;
  let db: NodeSQLiteAdapter;
  let member: string;
  let owner: string;
  let ids: Record<string, string>;
  let ownerRows: Record<string, unknown[]>;
  const access = (principalId: string, shared = false) => ({
    principalId,
    agentId: 'test-agent',
    scopes: [{ kind: shared ? 'project' : 'user', id: shared ? 'shared-scope' : principalId }],
  });
  const rows = (table: string) =>
    db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const row = (id: string) =>
    db.prepare('SELECT rowid, * FROM decisions WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
  const exportRecords = () => {
    expect(core.exportPrincipalRecords).toBeTypeOf('function');
    return core.exportPrincipalRecords(db, member);
  };
  const erase = (commandId = 'erase-command') => {
    expect(core.erasePrincipalRecords).toBeTypeOf('function');
    return core.erasePrincipalRecords(db, { principalId: member, commandId });
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'principal-records-'));
    process.env.MAMA_DB_PATH = join(dir, 'test.db');
    db = new NodeSQLiteAdapter({ dbPath: process.env.MAMA_DB_PATH });
    db.connect();
    db.runMigrations(migrations);
    const principals = createPrincipalRepository(db);
    principals.ensureOwner({
      principalId: 'owner-principal',
      connector: 'test',
      namespace: 'test',
      externalId: 'owner-external',
      now: 1,
    });
    owner = 'owner-principal';
    member = principals.registerMember({
      connector: 'test',
      namespace: 'test',
      externalId: 'member-external',
      now: 2,
    });
    ids = {};
    for (const name of [
      'uncited',
      'cited',
      'evidence-only',
      'edge-evidence',
      'assignment',
      'owner-record',
      'mixed',
    ]) {
      const principalId = name === 'owner-record' ? owner : member;
      const command = {
        commandId: `save-${name}`,
        topic: name === 'owner-record' ? 'public-topic' : 'privateword',
        summary: name === 'owner-record' ? 'public summary' : PRIVATE_SUMMARY,
        recordKind: 'judgment' as const,
      };
      const receipt = await appendJudgment(command, access(principalId), {
        adapter: db,
        embedder: null,
      });
      ids[name] = receipt.recordId;
      db.insertEmbedding(Number(row(receipt.recordId)?.rowid), vector);
    }
    const sharedScope = ensureMemoryScope(db, 'project', 'shared-scope');
    db.prepare('INSERT INTO memory_scope_bindings (memory_id, scope_id) VALUES (?, ?)').run(
      ids.mixed,
      sharedScope
    );
    for (const name of ['obs-cited', 'obs-uncited', 'obs-mixed', 'obs-owner']) {
      const receipt = await ingestSource(
        {
          commandId: name,
          source: { connector: 'test-source', id: name },
          body: 'privateword observation',
          scopes: access(name === 'obs-owner' ? owner : member).scopes,
        },
        access(name === 'obs-owner' ? owner : member),
        { adapter: db }
      );
      ids[name] = receipt.observationId;
    }
    const mixedObs = rows('observation_versions').find(
      (r) => r.observation_id === ids['obs-mixed']
    )!;
    const mixedScope = JSON.parse(String(mixedObs.scope_json));
    mixedScope.scopes.push({ kind: 'project', externalId: 'shared-scope', scopeId: sharedScope });
    db.prepare('UPDATE observation_versions SET scope_json=? WHERE observation_id=?').run(
      JSON.stringify(mixedScope),
      ids['obs-mixed']
    );
    const ownerCitation = await appendJudgment(
      {
        commandId: 'owner-citation',
        topic: 'public-topic',
        summary: 'public citation',
        recordKind: 'judgment',
        links: [
          { relation: 'derived_from', target: { kind: 'memory', id: ids.cited } },
          { relation: 'derived_from', target: { kind: 'observation', id: ids['obs-cited'] } },
        ],
      },
      { ...access(owner), scopes: [...access(owner).scopes, ...access(member).scopes] },
      { adapter: db, embedder: null }
    );
    ids['owner-citation'] = ownerCitation.recordId;
    // Bind the citing record exclusively to its owner, although its write admitted the target.
    db.prepare('DELETE FROM memory_scope_bindings WHERE memory_id=? AND scope_id=?').run(
      ownerCitation.recordId,
      ensureMemoryScope(db, 'user', member)
    );
    db.prepare('UPDATE decisions SET source_refs_json=? WHERE id=?').run(
      JSON.stringify([`memory:${ids['evidence-only']}`]),
      ids['owner-record']
    );
    const edge = rows('twin_edges').find((r) => r.subject_id === ids['owner-citation'])!;
    db.prepare('UPDATE twin_edges SET evidence_refs_json=? WHERE edge_id=?').run(
      JSON.stringify([{ kind: 'memory', id: ids['edge-evidence'] }]),
      edge.edge_id
    );
    await appendJudgment(
      {
        commandId: 'private-link',
        topic: 'privateword',
        summary: 'privateword link',
        recordKind: 'judgment',
        links: [{ relation: 'mentions', target: { kind: 'memory', id: ids.uncited } }],
      },
      access(member),
      { adapter: db, embedder: null }
    ).then((r) => {
      ids['private-link'] = r.recordId;
    });
    const work = await createWork(
      {
        commandId: 'shared-work',
        topic: 'public-topic',
        summary: 'public work',
        set: { title: 'shared work' },
      },
      access(owner, true),
      { adapter: db, embedder: null }
    );
    ids.work = work.commitmentId;
    await reviseWork(
      {
        commandId: 'shared-revision',
        commitmentId: work.commitmentId,
        summary: 'shared revision by member',
        set: { stage: 'review' },
      },
      access(member, true),
      { adapter: db, embedder: null }
    );
    // A retained assignment referencing an exclusively personal judgment requires a tombstone.
    db.prepare(
      "INSERT INTO commitment_assignments (commitment_id, revision, record_id, operation, set_json, clear_json, created_at) VALUES (?, 3, ?, 'revise', '{}', '[]', 3)"
    ).run(work.commitmentId, ids.assignment);
    for (const principalId of [owner, member]) {
      const checkpoint = db
        .prepare(
          "INSERT INTO checkpoints (timestamp, summary, open_files, next_steps, status) VALUES (1, ?, '[]', 'private steps', 'active')"
        )
        .run(principalId);
      db.prepare(
        'INSERT INTO checkpoint_scope_bindings (checkpoint_id, scope_id, created_at) VALUES (?, ?, 1)'
      ).run(checkpoint.lastInsertRowid, ensureMemoryScope(db, 'user', principalId));
      const input = db
        .prepare(
          "INSERT INTO mailbox_inputs (stimulus_id, principal_id, kind, status, channel_key, preview_json, occurred_at, created_at) VALUES (?, ?, 'owner_message', 'acked', 'test-channel', '[\"privateword\"]', 1, 1)"
        )
        .run(`stimulus-${principalId}`, principalId);
      db.prepare('INSERT INTO mailbox_input_refs (input_id, ref_id) VALUES (?, ?)').run(
        input.lastInsertRowid,
        `ref-${principalId}`
      );
      db.prepare('INSERT INTO mailbox_seen (ref_id, seen_at) VALUES (?, 1)').run(
        `ref-${principalId}`
      );
      db.prepare(
        "INSERT INTO native_input_deliveries (input_id, invocation_id, state, dispatch_json, receipt_json, updated_at) VALUES (?, ?, 'settled', ?, ?, 1)"
      ).run(
        input.lastInsertRowid,
        `invocation-${principalId}`,
        canonicalizeJSON({
          backend: 'claude',
          sessionId: 'test-session',
          inputId: `invocation-${principalId}`,
        }),
        canonicalizeJSON({
          backend: 'claude',
          sessionId: 'test-session',
          inputId: `invocation-${principalId}`,
        })
      );
      db.prepare(
        'INSERT INTO native_turn_results (receipt_json, principal_id, primary_stimulus_id, result_json, created_at) VALUES (?, ?, ?, \'{"text":"privateword"}\', 1)'
      ).run(
        canonicalizeJSON({
          backend: 'claude',
          sessionId: 'test-session',
          inputId: `invocation-${principalId}`,
        }),
        principalId,
        `stimulus-${principalId}`
      );
      db.prepare(
        "INSERT INTO model_runs (model_run_id, input_refs_json, completion_summary, input_snapshot_ref, envelope_hash, status, token_count, cost_estimate, input_tokens, output_tokens, created_at, completed_at) VALUES (?, ?, 'privateword', 'private snapshot', 'private hash', 'committed', 9, 0.1, 7, 2, 1, 2)"
      ).run(
        `run-${principalId}`,
        JSON.stringify({
          sessionKey: 'test-session',
          cliSessionId: 'test-session',
          nativeInputId: `invocation-${principalId}`,
          sourceMessageRef: `stimulus-${principalId}`,
        })
      );
      db.prepare(
        "INSERT INTO tool_traces (trace_id, model_run_id, tool_name, input_summary, output_summary, diagnostic_json, evidence_json, execution_status, duration_ms, created_at) VALUES (?, ?, 'test-tool', 'privateword', 'privateword', '{}', '{}', 'success', 5, 1)"
      ).run(`trace-${principalId}`, `run-${principalId}`);
      db.prepare(
        "INSERT INTO model_runs (model_run_id, parent_model_run_id, input_refs_json, completion_summary, status, created_at) VALUES (?, ?, '{}', 'private child output', 'committed', 1)"
      ).run(`child-${principalId}`, `run-${principalId}`);
      db.prepare(
        "INSERT INTO tool_traces (trace_id, model_run_id, tool_name, input_summary, execution_status, duration_ms, created_at) VALUES (?, ?, 'test-tool', 'private child input', 'success', 1, 1)"
      ).run(`child-trace-${principalId}`, `child-${principalId}`);
    }
    db.prepare(
      "INSERT INTO tool_traces (trace_id, operation_id, actor_principal_id, tool_name, input_summary, execution_status, duration_ms, created_at) VALUES ('member-operation-trace', 'test-operation', ?, 'test-tool', 'privateword', 'success', 5, 1)"
    ).run(member);
    ownerRows = {};
    const ownerRecords = new Set(
      rows('memory_scope_bindings')
        .filter(
          (r) => r.scope_id === ensureMemoryScope(db, 'user', owner) || r.scope_id === sharedScope
        )
        .map((r) => r.memory_id)
    );
    const ownerRowids = new Set(
      rows('decisions')
        .filter((r) => ownerRecords.has(r.id))
        .map((r) => row(String(r.id))?.rowid)
    );
    const ownerCommands = new Set(
      rows('judgment_commands')
        .filter((r) => ownerRecords.has(r.record_id))
        .map((r) => r.command_id)
    );
    ownerCommands.add('obs-owner');
    const ownerInputs = new Set(
      rows('mailbox_inputs')
        .filter((r) => r.principal_id === owner)
        .map((r) => r.id)
    );
    const ownerCheckpointIds = new Set(
      rows('checkpoint_scope_bindings')
        .filter(
          (r) => r.scope_id === ensureMemoryScope(db, 'user', owner) || r.scope_id === sharedScope
        )
        .map((r) => r.checkpoint_id)
    );
    const selectors: Record<string, (r: Record<string, unknown>) => boolean> = {
      decisions: (r) => ownerRecords.has(r.id),
      memory_scope_bindings: (r) => ownerRecords.has(r.memory_id),
      memory_events: (r) =>
        ownerRecords.has(r.memory_id) ||
        r.memory_id === ids['obs-owner'] ||
        r.memory_id === ids['obs-mixed'],
      record_actors: (r) => ownerRecords.has(r.record_id),
      embeddings: (r) => ownerRowids.has(r.rowid),
      judgment_commands: (r) => ownerRecords.has(r.record_id),
      command_bindings: (r) => ownerCommands.has(r.command_id),
      twin_edges: (r) => ownerRecords.has(r.subject_id),
      checkpoints: (r) => ownerCheckpointIds.has(r.id),
      checkpoint_scope_bindings: (r) => ownerCheckpointIds.has(r.checkpoint_id),
      observation_versions: (r) =>
        r.observation_id === ids['obs-owner'] || r.observation_id === ids['obs-mixed'],
      source_commands: (r) => r.command_id === 'obs-owner' || r.command_id === 'obs-mixed',
      mailbox_inputs: (r) => ownerInputs.has(r.id),
      mailbox_input_refs: (r) => ownerInputs.has(r.input_id),
      mailbox_seen: (r) => r.ref_id === `ref-${owner}`,
      native_input_deliveries: (r) => ownerInputs.has(r.input_id),
      native_turn_results: (r) => r.principal_id === owner,
      model_runs: (r) => [`run-${owner}`, `child-${owner}`].includes(String(r.model_run_id)),
      tool_traces: (r) => [`run-${owner}`, `child-${owner}`].includes(String(r.model_run_id)),
      commitments: () => true,
      commitment_assignments: () => true,
    };
    for (const [table, selector] of Object.entries(selectors))
      ownerRows[table] = rows(table).filter(selector);
  });
  afterEach(() => {
    db?.disconnect();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('neutralizes cited record metadata before status, kind and date filtered reads', async () => {
    db.prepare(
      "UPDATE decisions SET kind='lesson', status='stale', created_at=10, updated_at=20 WHERE id=?"
    ).run(ids.cited);
    const receipt = erase();
    expect(row(ids.cited)).toMatchObject({
      kind: null,
      status: null,
      record_kind: 'legacy',
      created_at: receipt.erasedAt,
      updated_at: receipt.erasedAt,
    });
    expect(await readMemoryRecordsInScopes(db, access(member).scopes, { kind: 'lesson' })).toEqual(
      []
    );
    expect(await readDecisionListing(db, access(member).scopes, { status: 'stale' })).toEqual([]);
    expect((await readSavedTimeline(db, access(member).scopes, { until: 21 })).records).toEqual([]);
    const erased = { id: ids.cited, scopes: access(member).scopes, state: 'erased' };
    expect(
      (await readSavedTimeline(db, access(member).scopes, { since: receipt.erasedAt })).records
    ).toContainEqual(erased);
    expect(await readMemoryRecordById(db, ids.cited, access(member).scopes)).toEqual(erased);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    ['as-of window', { asOfMs: 0 }],
    ['observed start window', { startMs: Number.MAX_SAFE_INTEGER }],
    ['source ceiling', { maxSourceMs: 0 }],
    ['removed channel grant', { channels: { 'test-source': [] } }],
    ['removed connector grant', { connectors: [] }],
    ['removed project grant', { projectRefs: [{ id: 'other-project' }] }],
    ['other tenant', { tenantId: 'other-tenant' }],
  ] as Array<[string, Partial<TwinVisibility>]>)(
    'hides an erased raw ref outside its %s',
    (_name, constraint) => {
      erase();
      const ref = { kind: 'raw' as const, id: ids['obs-cited'] };
      const visibility = { ...access(member), ...constraint };
      expect(visibleTwinRefKeys(db, [ref], visibility).size).toBe(0);
      expect(() => assertTwinRefsVisible(db, [ref], visibility)).toThrow('not visible');
    }
  );

  it('erases dead inputs and their settled execution records while retaining pending and claimed inputs', () => {
    const input = rows('mailbox_inputs').find((r) => r.principal_id === member)!;
    db.prepare("UPDATE mailbox_inputs SET status='dead' WHERE id=?").run(input.id);
    for (const status of ['pending', 'claimed']) {
      db.prepare(
        "INSERT INTO mailbox_inputs (stimulus_id, principal_id, kind, status, channel_key, preview_json, occurred_at, created_at) VALUES (?, ?, 'owner_message', ?, 'test-channel', '[]', 1, 1)"
      ).run(`active-${status}`, member, status);
    }
    const receipt = erase();
    expect(receipt.counts.mailbox_inputs).toMatchObject({ deleted: 1, in_flight: 2 });
    expect(rows('mailbox_inputs').find((r) => r.id === input.id)).toBeUndefined();
    expect(rows('native_input_deliveries').find((r) => r.input_id === input.id)).toBeUndefined();
    expect(
      rows('native_turn_results').find((r) => r.primary_stimulus_id === input.stimulus_id)
    ).toBeUndefined();
    expect(rows('model_runs').find((r) => r.model_run_id === `run-${member}`)).toMatchObject({
      completion_summary: null,
      erased_at: receipt.erasedAt,
    });
    expect(receipt.counts.model_runs.in_flight).toBe(0);
  });

  it('exports exactly exclusively personal rows in every store, stable ordering and counts', () => {
    const exported = exportRecords();
    expect(exported).toEqual(exportRecords());
    expect(exported.stores.decisions.map((r) => r.id).sort()).toEqual(
      ['uncited', 'cited', 'evidence-only', 'edge-evidence', 'assignment', 'private-link']
        .map((n) => ids[n])
        .sort()
    );
    expect(exported.stores.observation_versions.map((r) => r.observation_id).sort()).toEqual(
      [ids['obs-cited'], ids['obs-uncited']].sort()
    );
    expect(exported.stores.command_bindings.map((r) => r.command_id).sort()).toEqual(
      [
        'save-uncited',
        'save-cited',
        'save-evidence-only',
        'save-edge-evidence',
        'save-assignment',
        'private-link',
        'obs-cited',
        'obs-uncited',
      ].sort()
    );
    for (const [store, entries] of Object.entries(exported.stores))
      expect(exported.counts[store]).toBe(entries.length);
    for (const table of [
      'checkpoints',
      'checkpoint_scope_bindings',
      'mailbox_inputs',
      'mailbox_input_refs',
      'mailbox_seen',
      'native_input_deliveries',
      'native_turn_results',
    ])
      expect(exported.counts[table]).toBe(1);
    expect(exported.counts.model_runs).toBe(2);
    expect(exported.counts.tool_traces).toBe(3);
    expect(exported.stores.judgment_commands.map((r) => r.command_id).sort()).toEqual(
      [
        'save-uncited',
        'save-cited',
        'save-evidence-only',
        'save-edge-evidence',
        'save-assignment',
        'private-link',
      ].sort()
    );
    expect(exported.stores.source_commands.map((r) => r.command_id).sort()).toEqual([
      'obs-cited',
      'obs-uncited',
    ]);
    expect(exported.stores.memory_events.map((r) => r.memory_id).sort()).toEqual(
      [...exported.stores.decisions.map((r) => r.id), ids['obs-cited'], ids['obs-uncited']].sort()
    );
    expect(exported.stores.twin_edges).toEqual(
      rows('twin_edges').sort((a, b) => String(a.edge_id).localeCompare(String(b.edge_id)))
    );
    expect(exported.stores.model_runs.map((r) => r.model_run_id)).toEqual([
      `child-${member}`,
      `run-${member}`,
    ]);
    expect(exported.stores.tool_traces.map((r) => r.trace_id).sort()).toEqual(
      ['member-operation-trace', `trace-${member}`, `child-trace-${member}`].sort()
    );
    expect(exported.stores.mailbox_inputs[0]?.principal_id).toBe(member);
    expect(exported.stores.mailbox_seen[0]?.ref_id).toBe(`ref-${member}`);
    expect(exported.stores.native_turn_results[0]?.principal_id).toBe(member);
    for (const table of ['decisions_fts', 'decisions_trigram'])
      expect(exported.stores[table].map((r) => r.rowid).sort()).toEqual(
        exported.stores.decisions.map((r) => r.rowid).sort()
      );
    expect(exported.counts.embeddings).toBe(5);
    expect(exported.counts.vector_cache).toBe(5);
    expect(exported.stores.principal_erasure_receipts).toEqual([]);
  });

  it('deletes uncited records and their children, wipes cited records and observations, preserves shared rows and every owner row', async () => {
    const beforeMixed = row(ids.mixed);
    const mixedEvents = rows('memory_events').filter((r) => r.memory_id === ids.mixed);
    const beforeWork = rows('commitments');
    const beforeRevisions = rows('commitment_assignments');
    const uncitedRowids = [
      Number(row(ids.uncited)?.rowid),
      Number(row(ids['private-link'])?.rowid),
    ];
    const erasedRowids = [
      ...uncitedRowids,
      ...['cited', 'evidence-only', 'edge-evidence', 'assignment'].map((n) =>
        Number(row(ids[n])?.rowid)
      ),
    ];
    erase();
    for (const n of ['uncited', 'private-link']) {
      expect(row(ids[n])).toBeUndefined();
      for (const table of ['memory_scope_bindings', 'memory_events', 'record_actors'])
        expect(rows(table).some((r) => r.memory_id === ids[n] || r.record_id === ids[n])).toBe(
          false
        );
    }
    for (const n of ['cited', 'evidence-only', 'edge-evidence', 'assignment']) {
      const tombstone = { id: ids[n], scopes: access(member).scopes, state: 'erased' };
      expect(await readMemoryRecordById(db, ids[n], access(member).scopes)).toEqual(tombstone);
      expect(await getMemoryProvenance(db, ids[n])).toEqual(tombstone);
      const graph = queryGraph(
        db,
        { view: 'detail', seeds: [{ kind: 'memory', id: ids[n] }], history: 'all' },
        access(member)
      );
      expect(graph.nodes[0]?.data).toEqual({ kind: 'memory', ...tombstone });
      expect(row(ids[n])?.payload_json).toBe('{}');
      expect(row(ids[n])?.reasoning).toBeNull();
    }
    expect(readObservationVersion(db, ids['obs-uncited'])).toEqual({ status: 'not_found' });
    expect(readObservationVersion(db, ids['obs-cited'])).toEqual({
      id: ids['obs-cited'],
      scopes: access(member).scopes,
      state: 'erased',
    });
    const observation = rows('observation_versions').find(
      (r) => r.observation_id === ids['obs-cited']
    )!;
    expect(observation.body).toBeNull();
    expect(observation.body_location_json).toBeNull();
    expect(observation.content_hash).toBeNull();
    expect(observation.metadata_json).toBe('{}');
    for (const table of ['decisions_fts', 'decisions_trigram'])
      expect(
        db
          .prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH 'privateword'`)
          .all()
          .some((r: Record<string, unknown>) => erasedRowids.includes(Number(r.rowid)))
      ).toBe(false);
    expect(
      db.prepare('SELECT term,doc FROM decisions_trigram_vocab WHERE term=?').all(PRIVATE_TRIGRAM)
    ).toEqual([{ term: PRIVATE_TRIGRAM, doc: 1 }]);
    expect(rows('embeddings').some((r) => erasedRowids.includes(Number(r.rowid)))).toBe(false);
    expect(db.vectorSearch(vector, 100)?.some((r) => erasedRowids.includes(r.rowid))).toBe(false);
    expect(
      (await fts5Search(db, 'privateword', 100)).some((r) => erasedRowids.includes(Number(r.rowid)))
    ).toBe(false);
    const recalled = await recallMemory(db, 'privateword', {
      scopes: access(member).scopes,
      includeHistory: true,
      embedder: { embed: async () => Float32Array.from(vector) },
    });
    expect(JSON.stringify(recalled)).not.toContain(ids.cited);

    expect(row(ids.mixed)).toEqual(beforeMixed);
    expect(rows('memory_events').filter((r) => r.memory_id === ids.mixed)).toEqual(mixedEvents);
    expect(rows('commitments')).toEqual(beforeWork);
    expect(rows('commitment_assignments')).toEqual(beforeRevisions);
    expect(
      readWork(db, { commitmentId: ids.work, history: 'all' }, access(owner, true)).items[0]?.values
        .stage
    ).toBe('review');
    for (const [table, originals] of Object.entries(ownerRows)) {
      for (const original of originals) expect(rows(table)).toContainEqual(original);
      expect(
        rows(table).filter((r) =>
          originals.some((o) =>
            Object.keys(o).every((key) => JSON.stringify(o[key]) === JSON.stringify(r[key]))
          )
        )
      ).toHaveLength(originals.length);
    }
    const provenance = await resolveMemoryProvenanceLive(db, ids['owner-citation'], {
      scopes: [...access(owner).scopes, ...access(member).scopes],
      connectors: ['test-source'],
    });
    expect(JSON.stringify(provenance)).toContain('erased');
    expect(JSON.stringify(provenance)).not.toContain('privateword');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const run = rows('model_runs').find((r) => r.model_run_id === `run-${member}`)!;
    expect(run).toMatchObject({
      input_refs_json: null,
      completion_summary: null,
      input_snapshot_ref: null,
      envelope_hash: null,
      token_count: 9,
      cost_estimate: 0.1,
      input_tokens: 7,
      output_tokens: 2,
      status: 'committed',
      created_at: 1,
      completed_at: 2,
    });
    const trace = rows('tool_traces').find((r) => r.trace_id === `trace-${member}`)!;
    expect(trace).toMatchObject({
      input_summary: null,
      output_summary: null,
      diagnostic_json: null,
      evidence_json: null,
      execution_status: 'success',
      duration_ms: 5,
    });
    for (const table of [
      'mailbox_inputs',
      'mailbox_input_refs',
      'mailbox_seen',
      'native_input_deliveries',
      'native_turn_results',
      'checkpoints',
      'checkpoint_scope_bindings',
    ])
      expect(rows(table)).toHaveLength(1);
  });

  it('exports and wipes native roots, all descendants and NULL-actor traces', () => {
    db.prepare(
      "INSERT INTO model_runs (model_run_id, parent_model_run_id, input_refs_json, completion_summary, status, created_at) VALUES ('grandchild', ?, '{}', 'private output', 'committed', 1)"
    ).run(`child-${member}`);
    db.prepare(
      "INSERT INTO model_runs (model_run_id, input_refs_json, status, created_at) VALUES ('explicit-principal', ?, 'committed', 1)"
    ).run(JSON.stringify({ principalId: member }));
    expect(
      exportRecords()
        .stores.model_runs.map((r) => r.model_run_id)
        .sort()
    ).toEqual([`run-${member}`, `child-${member}`, 'grandchild', 'explicit-principal'].sort());
    expect(
      exportRecords()
        .stores.tool_traces.filter((r) => r.model_run_id)
        .every((r) => r.actor_principal_id === null)
    ).toBe(true);
    erase();
    for (const runId of [`run-${member}`, `child-${member}`, 'grandchild', 'explicit-principal']) {
      expect(rows('model_runs').find((r) => r.model_run_id === runId)).toMatchObject({
        input_refs_json: null,
        completion_summary: null,
        erased_principal_id: member,
      });
    }
    for (const traceId of [`trace-${member}`, `child-trace-${member}`]) {
      expect(rows('tool_traces').find((r) => r.trace_id === traceId)).toMatchObject({
        input_summary: null,
        output_summary: null,
      });
    }
  });

  it('preserves unacked inputs and their execution records until a new erase after settlement', () => {
    const input = rows('mailbox_inputs').find((r) => r.principal_id === member)!;
    db.prepare("UPDATE mailbox_inputs SET status='claimed' WHERE id=?").run(input.id);
    db.prepare("UPDATE native_input_deliveries SET state='accepted' WHERE input_id=?").run(
      input.id
    );
    const tables = [
      'mailbox_inputs',
      'mailbox_input_refs',
      'mailbox_seen',
      'native_input_deliveries',
      'native_turn_results',
      'model_runs',
      'tool_traces',
    ];
    const before = Object.fromEntries(tables.map((table) => [table, rows(table)]));
    before.tool_traces = before.tool_traces.filter((r) => r.trace_id !== 'member-operation-trace');
    const receipt = erase();
    expect(rows('mailbox_inputs')).toEqual(before.mailbox_inputs);
    for (const table of tables)
      expect(rows(table).filter((r) => r.trace_id !== 'member-operation-trace')).toEqual(
        before[table]
      );
    expect(receipt.counts.mailbox_inputs.in_flight).toBe(1);
    expect(receipt.counts.model_runs.in_flight).toBe(2);
    const journal = new NativeInputJournal(db);
    // Completion must still have its accepted input, receipt and principal.
    db.prepare('DELETE FROM native_turn_results WHERE principal_id=?').run(member);
    journal.storeResult(Number(input.id), {
      response: 'completed',
      turns: 1,
      totalUsage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'completed',
      modelRunId: `run-${member}`,
      modelRunProvenance: 'available',
    });
    journal.settle(Number(input.id));
    expect(erase()).toEqual(receipt);
    const next = erase('after-settlement');
    expect(next.counts.mailbox_inputs.deleted).toBe(1);
    expect(next.counts.mailbox_inputs.in_flight).toBe(0);
    expect(rows('mailbox_inputs').some((r) => r.id === input.id)).toBe(false);
    expect(rows('native_turn_results').some((r) => r.principal_id === member)).toBe(false);
    expect(
      rows('model_runs').find((r) => r.model_run_id === `child-${member}`)?.completion_summary
    ).toBeNull();
  });

  it('keeps a shared native receipt attributable while any member input is unacked', () => {
    const root = rows('mailbox_inputs').find((r) => r.principal_id === member)!;
    const receiptJson = canonicalizeJSON({
      backend: 'codex',
      sessionId: 'test-session',
      turnId: 'test-turn',
    });
    db.prepare(
      'UPDATE native_input_deliveries SET receipt_json=?, dispatch_json=? WHERE input_id=?'
    ).run(
      receiptJson,
      canonicalizeJSON({
        backend: 'codex',
        sessionId: 'test-session',
        inputId: `invocation-${member}`,
      }),
      root.id
    );
    db.prepare('UPDATE native_turn_results SET receipt_json=? WHERE principal_id=?').run(
      receiptJson,
      member
    );
    const active = db
      .prepare(
        "INSERT INTO mailbox_inputs (stimulus_id, principal_id, kind, status, channel_key, preview_json, occurred_at, created_at) VALUES ('steering-input', ?, 'owner_message', 'claimed', 'test-channel', '[]', 1, 1)"
      )
      .run(member);
    db.prepare(
      "INSERT INTO native_input_deliveries (input_id, invocation_id, state, dispatch_json, receipt_json, updated_at) VALUES (?, 'steering-invocation', 'accepted', ?, ?, 1)"
    ).run(
      active.lastInsertRowid,
      canonicalizeJSON({
        backend: 'codex',
        sessionId: 'test-session',
        inputId: 'steering-invocation',
      }),
      receiptJson
    );
    erase();
    expect(rows('mailbox_inputs')).toContainEqual(root);
    new NativeInputJournal(db).settle(Number(active.lastInsertRowid));
    erase('after-steering');
    expect(
      rows('model_runs').find((r) => r.model_run_id === `run-${member}`)?.completion_summary
    ).toBeNull();
    expect(rows('native_turn_results').some((r) => r.principal_id === member)).toBe(false);
  });

  it('keeps an erased endpoint edge cited by a kept correction without dangling references', () => {
    const target = rows('twin_edges').find((r) => r.subject_id === ids['private-link'])!;
    db.prepare(
      'UPDATE twin_edges SET reason_text=\'private reason\', relation_attrs_json=\'{"note":"private attrs"}\' WHERE edge_id=?'
    ).run(target.edge_id);
    db.prepare(
      "INSERT INTO twin_edges (edge_id, edge_type, subject_kind, subject_id, object_kind, object_id, source, content_hash, created_at) VALUES ('kept-correction', 'supersedes', 'edge', ?, 'memory', ?, 'agent', zeroblob(32), 1)"
    ).run(target.edge_id, ids['owner-record']);
    const correction = rows('twin_edges').find((r) => r.edge_id === 'kept-correction');
    erase();
    expect(rows('twin_edges').find((r) => r.edge_id === target.edge_id)).toMatchObject({
      reason_text: null,
      relation_attrs_json: null,
    });
    expect(rows('twin_edges')).toContainEqual(correction);
    expect(row(String(target.subject_id))?.erased_at).toBeTypeOf('number');
    expect(row(String(target.object_id))?.erased_at).toBeTypeOf('number');
  });

  it('does not widen live provenance to memory derived_from edges', async () => {
    const result = await resolveMemoryProvenanceLive(db, ids['owner-citation'], {
      scopes: [...access(owner).scopes, ...access(member).scopes],
      connectors: ['test-source'],
    });
    expect(result.supports).not.toContainEqual({ kind: 'memory', id: ids.cited });
    expect(JSON.stringify(result)).toContain(ids['obs-cited']);
  });

  it('preserves keyword fallback matching while excluding erased rows', async () => {
    db.prepare(
      "UPDATE decisions SET topic='fallbackneedle', status='superseded', superseded_by=? WHERE id=?"
    ).run(ids['owner-record'], ids.uncited);
    // Reads must honour erasure state even if an old content projection survives.
    db.prepare("UPDATE decisions SET erased_at=2, topic='fallbackneedle' WHERE id=?").run(
      ids.cited
    );
    const result = await suggestInAdapter(db, 'fallbackneedle missingword', { format: 'json' });
    expect(result && typeof result === 'object' ? result.results.map((r) => r.id) : []).toContain(
      ids.uncited
    );
    expect(
      result && typeof result === 'object' ? result.results.map((r) => r.id) : []
    ).not.toContain(ids.cited);
  });

  it('blocks record and observation command replay, replays the same erasure receipt and reports no new erasure with a new id', async () => {
    const receipt = erase();
    expect(erase()).toEqual(receipt);
    const second = erase('another-erase-command');
    expect(second.state).toBe('nothing_to_erase');
    expect(
      Object.values(second.counts).every(
        (c) => c.deleted === 0 && c.tombstoned === 0 && c.wiped === 0
      )
    ).toBe(true);
    expect(exportRecords().stores.principal_erasure_receipts).toHaveLength(2);
    await expect(
      appendJudgment(
        {
          commandId: 'save-uncited',
          topic: 'privateword',
          summary: PRIVATE_SUMMARY,
          recordKind: 'judgment',
        },
        access(member),
        { adapter: db, embedder: null }
      )
    ).rejects.toMatchObject({ code: 'COMMAND_ERASED' });
    await expect(
      ingestSource(
        {
          commandId: 'obs-uncited',
          source: { connector: 'test-source', id: 'obs-uncited' },
          body: 'privateword observation',
          scopes: access(member).scopes,
        },
        access(member),
        { adapter: db }
      )
    ).rejects.toMatchObject({ code: 'COMMAND_ERASED' });
    expect(row(ids.uncited)).toBeUndefined();
  });

  it('erases an outgoing personal link to a kept record rather than mistaking it for an incoming citation', async () => {
    const receipt = await appendJudgment(
      {
        commandId: 'outgoing-private',
        topic: 'privateword',
        summary: 'outgoing private content',
        recordKind: 'judgment',
        links: [{ relation: 'mentions', target: { kind: 'memory', id: ids['owner-record'] } }],
      },
      { ...access(member), scopes: [...access(member).scopes, ...access(owner).scopes] },
      { adapter: db, embedder: null }
    );
    db.prepare('DELETE FROM memory_scope_bindings WHERE memory_id=? AND scope_id=?').run(
      receipt.recordId,
      ensureMemoryScope(db, 'user', owner)
    );
    erase();
    expect(row(receipt.recordId)).toBeUndefined();
    expect(rows('twin_edges').some((r) => r.subject_id === receipt.recordId)).toBe(false);
    expect(row(ids['owner-record'])).toBeDefined();
  });

  it('keeps erasure state and command replay protection after reconnecting and running migrations again', async () => {
    erase();
    db.disconnect();
    db = new NodeSQLiteAdapter({ dbPath: join(dir, 'test.db') });
    db.connect();
    db.runMigrations(migrations);
    expect(await readMemoryRecordById(db, ids.cited, access(member).scopes)).toEqual({
      id: ids.cited,
      scopes: access(member).scopes,
      state: 'erased',
    });
    expect(readObservationVersion(db, ids['obs-cited'])).toMatchObject({ state: 'erased' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(erase('after-restart').state).toBe('nothing_to_erase');
  });

  it('shows erased citations on work and scope graph reads without exposing their content', async () => {
    const work = await createWork(
      {
        commandId: 'citing-work',
        topic: 'public-topic',
        summary: 'public work with evidence',
        set: { title: 'shared evidence' },
        links: [{ relation: 'derived_from', target: { kind: 'memory', id: ids.cited } }],
      },
      { ...access(owner, true), scopes: [...access(owner, true).scopes, ...access(member).scopes] },
      { adapter: db, embedder: null }
    );
    db.prepare('DELETE FROM memory_scope_bindings WHERE memory_id=? AND scope_id=?').run(
      work.recordRef.id,
      ensureMemoryScope(db, 'user', member)
    );
    erase();
    const admitted = {
      ...access(owner, true),
      scopes: [...access(owner, true).scopes, ...access(member).scopes],
    };
    expect(
      readWork(db, { commitmentId: work.commitmentId }, admitted).items[0]?.erasedCitations
    ).toContainEqual({ id: ids.cited, scopes: access(member).scopes, state: 'erased' });
    expect((await readGraphNodes(db, access(member).scopes, { ids: [ids.cited] }))[0]).toEqual({
      id: ids.cited,
      scopes: access(member).scopes,
      state: 'erased',
    });
  });

  it('erases seen refs of new member inputs even after their mailbox payload is pruned', () => {
    const mailbox = new Mailbox(db, () => 10);
    const inputId = mailbox.enqueue({
      id: 'prunable-input',
      kind: 'source_delta',
      principalId: member,
      channelKey: 'test-channel',
      refs: [{ refId: 'prunable-ref', observationRef: null }],
      occurredAt: 1,
    });
    db.prepare('DELETE FROM mailbox_inputs WHERE id=?').run(inputId);
    expect(exportRecords().stores.mailbox_seen.map((r) => r.ref_id)).toContain('prunable-ref');
    erase();
    expect(rows('mailbox_seen').map((r) => r.ref_id)).not.toContain('prunable-ref');
  });

  it('omits tombstones from recall graph expansion even when historical records are requested', async () => {
    const receipt = await appendJudgment(
      {
        commandId: 'searchable-citation',
        topic: 'searchable-public',
        summary: 'searchable public record',
        recordKind: 'judgment',
        links: [{ relation: 'builds_on', target: { kind: 'memory', id: ids.cited } }],
      },
      { ...access(owner), scopes: [...access(owner).scopes, ...access(member).scopes] },
      { adapter: db, embedder: null }
    );
    db.prepare('DELETE FROM memory_scope_bindings WHERE memory_id=? AND scope_id=?').run(
      receipt.recordId,
      ensureMemoryScope(db, 'user', member)
    );
    const before = await recallMemory(db, 'searchable', {
      scopes: [...access(owner).scopes, ...access(member).scopes],
      includeHistory: true,
      includeRelated: true,
      embedder: { embed: async () => Float32Array.from([0, 1, 0]) },
    });
    expect(before.graph_context.expanded.map((r) => r.id)).toContain(ids.cited);
    erase();
    const recalled = await recallMemory(db, 'searchable', {
      scopes: [...access(owner).scopes, ...access(member).scopes],
      includeHistory: true,
      includeRelated: true,
      embedder: { embed: async () => Float32Array.from([0, 1, 0]) },
    });
    expect(recalled.memories.map((r) => r.id)).toContain(receipt.recordId);
    expect(recalled.graph_context.expanded.map((r) => r.id)).not.toContain(ids.cited);
    expect(JSON.stringify(recalled)).not.toContain(ids.cited);
    const suggested = await suggestInAdapter(db, 'searchable', {
      scopes: [...access(owner).scopes, ...access(member).scopes],
      includeRelated: true,
      includeHistory: true,
    });
    expect(JSON.stringify(suggested)).not.toContain(ids.cited);
    expect(
      (await querySemanticEdges(db, [receipt.recordId])).builds_on?.[0]?.erasedCitation
    ).toEqual({ id: ids.cited, scopes: access(member).scopes, state: 'erased' });
  });

  it('reads erased observation and legacy raw graph endpoints through their preserved scope', () => {
    erase();
    for (const kind of ['observation', 'raw'] as const) {
      const graph = queryGraph(
        db,
        { view: 'detail', seeds: [{ kind, id: ids['obs-cited'] }] },
        kind === 'raw' ? access(member) : { ...access(member), connectors: ['test-source'] }
      );
      expect(graph.nodes[0]?.data).toEqual({
        kind,
        id: ids['obs-cited'],
        scopes: access(member).scopes,
        state: 'erased',
      });
    }
  });

  it('does not treat a personal event that will be deleted as a kept citation', () => {
    db.prepare(
      "INSERT INTO memory_events (event_id,event_type,actor,scope_refs,evidence_refs,created_at) VALUES ('personal-event','saved','test-agent',?,?,1)"
    ).run(JSON.stringify(access(member).scopes), JSON.stringify([`memory:${ids.uncited}`]));
    erase();
    expect(row(ids.uncited)).toBeUndefined();
  });

  it('preserves a bodyless observation cited only by a legacy raw source ref', () => {
    db.prepare('UPDATE decisions SET source_refs_json=? WHERE id=?').run(
      JSON.stringify([`raw:test-source:${ids['obs-uncited']}`]),
      ids['owner-record']
    );
    erase();
    expect(readObservationVersion(db, ids['obs-uncited'])).toEqual({
      id: ids['obs-uncited'],
      scopes: access(member).scopes,
      state: 'erased',
    });
  });

  it('returns erasure state from legacy record, listing, dashboard and timeline reads', async () => {
    erase();
    const erased = { id: ids.cited, scopes: access(member).scopes, state: 'erased' };
    expect(await queryDecisionGraph(db, '', ids.cited)).toEqual([erased]);
    expect(readDecisionWithEdges(db, ids.cited)).toEqual(erased);
    expect(
      await listDecisionsInAdapter(db, {
        scopes: access(member).scopes,
        includeHistory: true,
        limit: 100,
      })
    ).toContainEqual(erased);
    expect(await readDecisionListing(db, access(member).scopes, { limit: 100 })).toContainEqual(
      erased
    );
    expect((await readSavedTimeline(db, access(member).scopes)).records).toContainEqual(erased);
    expect(
      getGraphTimeline(
        db,
        { ref: { kind: 'memory', id: ids.cited }, limit: 100 },
        { scopes: access(member).scopes }
      ).events.some(
        (e) => e.kind === 'memory' && JSON.stringify(e.memory) === JSON.stringify(erased)
      )
    ).toBe(true);
  });

  it('wipes nullable extension content on cited personal records and observations', () => {
    db.exec('ALTER TABLE decisions ADD COLUMN extra_note TEXT');
    db.exec('ALTER TABLE observation_versions ADD COLUMN extra_note TEXT');
    db.prepare('UPDATE decisions SET extra_note=? WHERE id=?').run('private extension', ids.cited);
    db.prepare('UPDATE observation_versions SET extra_note=? WHERE observation_id=?').run(
      'private extension',
      ids['obs-cited']
    );
    erase();
    expect(row(ids.cited)?.extra_note).toBeNull();
    expect(
      rows('observation_versions').find((r) => r.observation_id === ids['obs-cited'])?.extra_note
    ).toBeNull();
  });

  it('keeps erased run and trace content wiped when native completion arrives after erasure', async () => {
    const runId = `run-${member}`;
    db.prepare(
      "UPDATE model_runs SET status='running', completed_at=NULL WHERE model_run_id=?"
    ).run(runId);
    erase();
    expect(db.prepare('PRAGMA recursive_triggers').get()).toEqual({ recursive_triggers: 0 });
    core.commitModelRun(db, runId, 'private late completion', 12, {
      input_tokens: 8,
      output_tokens: 4,
    });
    const run = rows('model_runs').find((r) => r.model_run_id === runId)!;
    expect(run).toMatchObject({
      status: 'committed',
      completion_summary: null,
      token_count: 12,
      input_tokens: 8,
      output_tokens: 4,
    });
    db.prepare("UPDATE tool_traces SET output_summary='private late output' WHERE trace_id=?").run(
      `trace-${member}`
    );
    expect(
      rows('tool_traces').find((r) => r.trace_id === `trace-${member}`)?.output_summary
    ).toBeNull();
    const trace = await core.appendToolTrace(db, {
      model_run_id: runId,
      tool_name: 'test-tool',
      input_summary: 'private late input',
      output_summary: 'private late output',
      execution_status: 'success',
      duration_ms: 7,
    });
    expect(trace).toMatchObject({
      input_summary: null,
      output_summary: null,
      execution_status: 'success',
      duration_ms: 7,
    });
    expect(erase('after-native-completion').state).toBe('nothing_to_erase');
  });

  it.each(['owner-principal', 'unknown-principal', 'member-external', ''])(
    'refuses export and erasure for non-member principal %j',
    (principalId) => {
      expect(core.exportPrincipalRecords).toBeTypeOf('function');
      expect(() => core.exportPrincipalRecords(db, principalId)).toThrow(/registered member/);
      expect(() => core.erasePrincipalRecords(db, { principalId, commandId: 'refused' })).toThrow(
        /registered member/
      );
      expect(rows('principal_erasure_receipts')).toEqual([]);
    }
  );

  it('rolls back SQL, command reservations and the vector cache if writing the final receipt fails', () => {
    const before = rows('decisions');
    const vectorsBefore = db.vectorSearch(vector, 100);
    expect(core.erasePrincipalRecords).toBeTypeOf('function');
    db.exec(
      "CREATE TRIGGER refuse_receipt BEFORE INSERT ON principal_erasure_receipts BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END"
    );
    expect(() => erase()).toThrow('test receipt failure');
    expect(rows('decisions')).toEqual(before);
    expect(db.vectorSearch(vector, 100)).toEqual(vectorsBefore);
    expect(rows('command_bindings').every((r) => r.erased_at === null)).toBe(true);
  });
});
