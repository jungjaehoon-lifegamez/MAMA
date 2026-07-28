/**
 * The test that should have existed before the predicate was written.
 *
 * `isEventVisibleNow` claims to reproduce the raw candidate reader's access rules. The
 * first version did not - it mirrored the MEMORY reader's legacy rule instead, and since
 * `deriveMemoryScopes` always appends global:system alongside project/channel/user, the
 * two rules disagree in EVERY production configuration. Unit tests over the predicate
 * alone could not see that, because they asserted the predicate against itself.
 *
 * So this runs the real reader, over a real SQLite database, and requires the two to
 * return the same verdict for every event under every scope set. A prose claim about
 * mirroring is worth nothing; a differential is worth exactly what it covers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { readRawCandidates } from '@jungjaehoon/mama-core/context-compile';
import { isEventVisibleNow } from '../../src/memory/provenance-live.js';
import type { IndexedEvent } from '../../src/memory/provenance-resolver.js';

interface EventFixture {
  id: string;
  connector: string;
  scopeKind: string | null;
  scopeId: string | null;
  projectId: string | null;
  tenantId: string | null;
}

// A matrix rather than examples: scoped and unscoped, in-project and project-less,
// granted and ungranted connectors. The divergence lived in the unscoped rows.
const EVENTS: EventFixture[] = [
  {
    id: 'e_proj_scoped',
    connector: 'board',
    scopeKind: 'project',
    scopeId: 'alpha',
    projectId: 'p1',
    tenantId: null,
  },
  {
    id: 'e_proj_other',
    connector: 'board',
    scopeKind: 'project',
    scopeId: 'beta',
    projectId: 'p1',
    tenantId: null,
  },
  {
    id: 'e_unscoped_p1',
    connector: 'board',
    scopeKind: null,
    scopeId: null,
    projectId: 'p1',
    tenantId: null,
  },
  {
    id: 'e_unscoped_noproj',
    connector: 'board',
    scopeKind: null,
    scopeId: null,
    projectId: null,
    tenantId: null,
  },
  {
    id: 'e_global_system',
    connector: 'board',
    scopeKind: 'global',
    scopeId: 'system',
    projectId: null,
    tenantId: null,
  },
  {
    id: 'e_global_legacy',
    connector: 'board',
    scopeKind: 'global',
    scopeId: 'global',
    projectId: null,
    tenantId: null,
  },
  {
    id: 'e_channel',
    connector: 'board',
    scopeKind: 'channel',
    scopeId: 'c1',
    projectId: null,
    tenantId: null,
  },
  {
    id: 'e_other_conn',
    connector: 'gmail',
    scopeKind: 'project',
    scopeId: 'alpha',
    projectId: 'p1',
    tenantId: null,
  },
  {
    id: 'e_unscoped_gmail',
    connector: 'gmail',
    scopeKind: null,
    scopeId: null,
    projectId: null,
    tenantId: null,
  },
  // The tenant axis. The first version of this matrix left it uniformly null on every
  // fixture AND unset on every scenario, so the reader's tenant filter never ran on
  // either side - and a resolver that skipped the filter entirely looked identical to
  // one that applied it. 19,394 of the live rows are tenant-null.
  {
    id: 'e_tenant_default',
    connector: 'board',
    scopeKind: 'project',
    scopeId: 'alpha',
    projectId: 'p1',
    tenantId: 'default',
  },
  {
    id: 'e_tenant_other',
    connector: 'board',
    scopeKind: 'project',
    scopeId: 'alpha',
    projectId: 'p1',
    tenantId: 'other',
  },
  {
    id: 'e_user_scope',
    connector: 'board',
    scopeKind: 'user',
    scopeId: 'u1',
    projectId: null,
    tenantId: 'default',
  },
  {
    id: 'e_proj_p2',
    connector: 'board',
    scopeKind: 'project',
    scopeId: 'alpha',
    projectId: 'p2',
    tenantId: 'default',
  },
];

interface Scenario {
  name: string;
  scopes: Array<{ kind: string; id: string }>;
  connectors: string[];
  projectIds: string[];
  /** deriveEffectiveTenantId() returns 'default', so production always resolves one. */
  tenantId?: string;
}

const SCENARIOS: Scenario[] = [
  {
    // The only scope set the runtime actually produces: deriveMemoryScopes appends
    // global:system next to the specific scopes. This is the case the first predicate
    // got wrong, and the case the original unit tests never exercised.
    name: 'production mixed scopes with a project window',
    scopes: [
      { kind: 'project', id: 'alpha' },
      { kind: 'channel', id: 'c1' },
      { kind: 'global', id: 'system' },
    ],
    connectors: ['board'],
    projectIds: ['p1'],
  },
  {
    name: 'production mixed scopes without a project window',
    scopes: [
      { kind: 'project', id: 'alpha' },
      { kind: 'global', id: 'system' },
    ],
    connectors: ['board'],
    projectIds: [],
  },
  {
    // The narrow case the reader's legacy allowance actually targets.
    name: 'global-system alone',
    scopes: [{ kind: 'global', id: 'system' }],
    connectors: ['board'],
    projectIds: [],
  },
  {
    name: 'global-system alone across two connectors',
    scopes: [{ kind: 'global', id: 'system' }],
    connectors: ['board', 'gmail'],
    projectIds: [],
  },
  {
    name: 'a single project scope with no global sentinel',
    scopes: [{ kind: 'project', id: 'alpha' }],
    connectors: ['board'],
    projectIds: [],
  },
  {
    name: 'no connector grant',
    scopes: [{ kind: 'global', id: 'system' }],
    connectors: [],
    projectIds: [],
  },
  // The shape production actually runs: a resolved tenant on every call.
  {
    name: 'production shape with a resolved tenant',
    scopes: [
      { kind: 'project', id: 'alpha' },
      { kind: 'user', id: 'u1' },
      { kind: 'global', id: 'system' },
    ],
    connectors: ['board'],
    projectIds: ['p1'],
    tenantId: 'default',
  },
  {
    // A resolved tenant makes hasScopedVisibility true, so the legacy allowance can
    // never fire here - the case where the predicate previously diverged.
    name: 'global-system alone but with a resolved tenant',
    scopes: [{ kind: 'global', id: 'system' }],
    connectors: ['board'],
    projectIds: [],
    tenantId: 'default',
  },
  {
    name: 'a multi-project window with a resolved tenant',
    scopes: [
      { kind: 'project', id: 'alpha' },
      { kind: 'global', id: 'system' },
    ],
    connectors: ['board'],
    projectIds: ['p1', 'p2'],
    tenantId: 'default',
  },
];

let db: Database.Database;
let adapter: { prepare: (sql: string) => Database.Statement };

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE connector_event_index (
      event_index_id TEXT PRIMARY KEY,
      source_connector TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_locator TEXT,
      channel TEXT,
      author TEXT,
      title TEXT,
      content TEXT NOT NULL,
      event_datetime INTEGER,
      event_date TEXT,
      source_timestamp_ms INTEGER NOT NULL,
      metadata_json TEXT,
      artifact_locator TEXT,
      artifact_title TEXT,
      content_hash BLOB NOT NULL,
      indexed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      tenant_id TEXT,
      project_id TEXT,
      memory_scope_kind TEXT,
      memory_scope_id TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO connector_event_index (
      event_index_id, source_connector, source_type, source_id, channel, title, content,
      event_datetime, source_timestamp_ms, content_hash, indexed_at, updated_at,
      tenant_id, project_id, memory_scope_kind, memory_scope_id
    ) VALUES (?, ?, 'message', ?, 'chan', 'title', 'content body', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const fixture of EVENTS) {
    insert.run(
      fixture.id,
      fixture.connector,
      `src-${fixture.id}`,
      1_785_000_000_000,
      1_785_000_000_000,
      Buffer.alloc(32),
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      fixture.tenantId,
      fixture.projectId,
      fixture.scopeKind,
      fixture.scopeId
    );
  }
  adapter = { prepare: (sql: string) => db.prepare(sql) };
});

afterAll(() => {
  db.close();
});

function toIndexedEvent(fixture: EventFixture): IndexedEvent {
  return {
    connector: fixture.connector,
    eventIndexId: fixture.id,
    sourceId: `src-${fixture.id}`,
    channel: 'chan',
    observedAt: '2026-07-01T00:00:00.000Z',
    content: 'content body',
    memoryScope:
      fixture.scopeKind && fixture.scopeId
        ? { kind: fixture.scopeKind, id: fixture.scopeId }
        : null,
    projectId: fixture.projectId,
    tenantId: fixture.tenantId,
  };
}

describe('provenance visibility matches the raw reader', () => {
  for (const scenario of SCENARIOS) {
    it(`agrees with readRawCandidates: ${scenario.name}`, () => {
      const result = readRawCandidates(
        adapter as never,
        {
          scopes: scenario.scopes as never,
          connectors: scenario.connectors,
          project_refs: scenario.projectIds.map((id) => ({ id })) as never,
          ...(scenario.tenantId === undefined ? {} : { tenant_id: scenario.tenantId }),
          limit: 100,
        } as never
      );

      const readerVisible = new Set(
        result.candidates
          .filter((candidate) => candidate.visible)
          .map((candidate) => (candidate.ref as { raw_id: string }).raw_id)
      );

      const resolverVisible = new Set(
        EVENTS.filter((fixture) =>
          isEventVisibleNow(toIndexedEvent(fixture), {
            scopes: scenario.scopes as never,
            connectors: scenario.connectors,
            projectIds: scenario.projectIds,
            tenantId: scenario.tenantId ?? null,
          })
        ).map((fixture) => fixture.id)
      );

      expect([...resolverVisible].sort()).toEqual([...readerVisible].sort());
    });
  }

  // Guards the direction that matters. If the two ever drift again, the failure that
  // hurts is the resolver showing MORE than the reader - that is the access leak, and
  // the equality assertions above would report it as a plain mismatch.
  it('never shows an event the reader excludes, across every scenario', () => {
    for (const scenario of SCENARIOS) {
      const result = readRawCandidates(
        adapter as never,
        {
          scopes: scenario.scopes as never,
          connectors: scenario.connectors,
          project_refs: scenario.projectIds.map((id) => ({ id })) as never,
          ...(scenario.tenantId === undefined ? {} : { tenant_id: scenario.tenantId }),
          limit: 100,
        } as never
      );
      const readerVisible = new Set(
        result.candidates
          .filter((candidate) => candidate.visible)
          .map((candidate) => (candidate.ref as { raw_id: string }).raw_id)
      );

      for (const fixture of EVENTS) {
        const shown = isEventVisibleNow(toIndexedEvent(fixture), {
          scopes: scenario.scopes as never,
          connectors: scenario.connectors,
          projectIds: scenario.projectIds,
          tenantId: scenario.tenantId ?? null,
        });
        if (shown) {
          expect(
            readerVisible.has(fixture.id),
            `${scenario.name}: resolver showed ${fixture.id}, reader did not`
          ).toBe(true);
        }
      }
    }
  });
});
