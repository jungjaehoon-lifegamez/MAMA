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
import {
  EVENT_INDEX_COLUMNS,
  isEventVisibleNow,
  toIndexedEvent,
  type EventRow,
} from '../../src/memory/provenance-live.js';
import type { IndexedEvent } from '../../src/memory/provenance-resolver.js';

interface EventFixture {
  id: string;
  connector: string;
  scopeKind: string | null;
  scopeId: string | null;
  projectId: string | null;
  tenantId: string | null;
  /** Defaults to BASE_MS. Varied so the reader's time clause is not dead on both sides. */
  observedMs?: number;
  /** Written to event_datetime when set, so it can differ from source_timestamp_ms. */
  eventDatetime?: number;
  /** Defaults to 'chan'. Varied so the channel grant is not dead on both sides. */
  channel?: string;
}

const BASE_MS = 1_785_000_000_000;
const OLD_MS = 1_600_000_000_000;

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
  // The grant axis. Without channels that differ, a grant-aware predicate and a
  // grant-blind one return the same verdict for every row, which is how the previous
  // version of this matrix stayed green while the two rules diverged.
  {
    id: 'e_granted_channel',
    connector: 'board',
    scopeKind: 'project',
    scopeId: 'alpha',
    projectId: 'p1',
    tenantId: null,
    channel: 'granted',
  },
  {
    id: 'e_ungranted_channel',
    connector: 'board',
    scopeKind: 'project',
    scopeId: 'alpha',
    projectId: 'p1',
    tenantId: null,
    channel: 'ungranted',
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
  // event_datetime = 0 is the mapper's disagreement case: SQL COALESCE keeps the 0
  // because it is not NULL, while a mapper that treats 0 as absent would fall through to
  // source_timestamp_ms and judge a different instant. Only visible now that the struct
  // comes from the production mapper.
  {
    id: 'e_zero_datetime',
    connector: 'board',
    scopeKind: 'project',
    scopeId: 'alpha',
    projectId: 'p1',
    tenantId: 'default',
    observedMs: BASE_MS,
    eventDatetime: 0,
  },
  // The time axis. Every fixture previously shared one timestamp and no scenario set a
  // window, so the reader's COALESCE bound never ran - the same uniformity that hid the
  // tenant leak, on the one filter the predicate had no counterpart for at all.
  {
    id: 'e_old',
    connector: 'board',
    scopeKind: 'project',
    scopeId: 'alpha',
    projectId: 'p1',
    tenantId: 'default',
    observedMs: OLD_MS,
  },
];

interface Scenario {
  name: string;
  scopes: Array<{ kind: string; id: string }>;
  connectors: string[];
  projectIds: string[];
  /** deriveEffectiveTenantId() returns 'default', so production always resolves one. */
  tenantId?: string;
  asOf?: string;
  rangeStartMs?: number;
  /** When set, the grant decides on BOTH sides - the branch production takes. */
  channels?: Record<string, readonly string[]>;
}

const SCENARIOS: Scenario[] = [
  // The grant scenarios come first because they are the branch production takes. Every
  // scenario below them exercises the pre-grant rule, which now applies only to callers
  // that hold no grant.
  {
    name: 'grant: one channel of one connector',
    scopes: [
      { kind: 'project', id: 'alpha' },
      { kind: 'global', id: 'system' },
    ],
    connectors: ['board'],
    projectIds: [],
    channels: { board: ['granted'] },
  },
  {
    name: 'grant: several channels, one connector of two',
    scopes: [{ kind: 'global', id: 'system' }],
    connectors: ['board', 'gmail'],
    projectIds: [],
    channels: { board: ['granted', 'chan'] },
  },
  {
    name: 'grant: empty for the requested connector',
    scopes: [{ kind: 'global', id: 'system' }],
    connectors: ['board'],
    projectIds: [],
    channels: { board: [] },
  },
  {
    // Without project and tenant set on a grant scenario, "the grant branch skips them"
    // is unobservable: a side that started applying either filter under a grant would
    // still pass every assertion.
    name: 'grant: with a project and tenant window that must NOT apply',
    scopes: [{ kind: 'global', id: 'system' }],
    connectors: ['board'],
    projectIds: ['p1'],
    tenantId: 'default',
    channels: { board: ['granted', 'chan'] },
  },
  {
    name: 'grant: with a time bound',
    scopes: [{ kind: 'global', id: 'system' }],
    connectors: ['board'],
    projectIds: [],
    channels: { board: ['granted', 'chan'] },
    rangeStartMs: BASE_MS,
  },
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
    // as_of is an authority clamp, not a caller preference, so a resolver that ignored
    // it would out-read the reader the moment anything sets it.
    name: 'an as_of clamp that excludes the newer events',
    scopes: [
      { kind: 'project', id: 'alpha' },
      { kind: 'global', id: 'system' },
    ],
    connectors: ['board'],
    projectIds: ['p1'],
    tenantId: 'default',
    asOf: new Date(OLD_MS + 1_000).toISOString(),
  },
  {
    name: 'a range that excludes the older event',
    scopes: [
      { kind: 'project', id: 'alpha' },
      { kind: 'global', id: 'system' },
    ],
    connectors: ['board'],
    projectIds: ['p1'],
    tenantId: 'default',
    rangeStartMs: OLD_MS + 1_000,
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
    ) VALUES (?, ?, 'message', ?, ?, 'title', 'content body', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const fixture of EVENTS) {
    insert.run(
      fixture.id,
      fixture.connector,
      `src-${fixture.id}`,
      fixture.channel ?? 'chan',
      fixture.eventDatetime ?? fixture.observedMs ?? BASE_MS,
      fixture.observedMs ?? BASE_MS,
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

/**
 * Read the row back and map it with the PRODUCTION mapper.
 *
 * The earlier version hand-built this struct from the fixture, which meant the
 * differential proved the predicate mirrors the reader while leaving the row-to-struct
 * mapping unjudged - the layer where a scope-column coercion bug already lived once, and
 * where `toIsoOrNull` and SQL `COALESCE` can still disagree about a zero timestamp. Going
 * through the real mapper closes that layer instead of chasing it one column at a time.
 */
function indexedEvent(fixture: EventFixture): IndexedEvent {
  const row = db
    .prepare(`SELECT ${EVENT_INDEX_COLUMNS} FROM connector_event_index WHERE event_index_id = ?`)
    .get(fixture.id) as EventRow;
  return toIndexedEvent(row);
}

describe('provenance visibility matches the raw reader', () => {
  for (const scenario of SCENARIOS) {
    it(`agrees with readRawCandidates: ${scenario.name}`, () => {
      const result = readRawCandidates(
        adapter as never,
        {
          scopes: scenario.scopes as never,
          connectors: scenario.connectors,
          project_refs: scenario.projectIds.map((id) => ({ kind: 'project', id })) as never,
          ...(scenario.tenantId === undefined ? {} : { tenant_id: scenario.tenantId }),
          ...(scenario.asOf === undefined ? {} : { as_of: scenario.asOf }),
          ...(scenario.rangeStartMs === undefined
            ? {}
            : { range: { start_ms: scenario.rangeStartMs } }),
          ...(scenario.channels
            ? {
                boundary: {
                  connectors: scenario.connectors,
                  scopes: scenario.scopes,
                  project_refs: scenario.projectIds.map((id) => ({ kind: 'project', id })),
                  ...(scenario.tenantId === undefined ? {} : { tenant_id: scenario.tenantId }),
                  channels: scenario.channels,
                },
              }
            : {}),
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
          isEventVisibleNow(indexedEvent(fixture), {
            scopes: scenario.scopes as never,
            connectors: scenario.connectors,
            ...(scenario.channels ? { channels: scenario.channels } : {}),
            projectIds: scenario.projectIds,
            tenantId: scenario.tenantId ?? null,
            maxObservedMs: scenario.asOf === undefined ? null : Date.parse(scenario.asOf),
            minObservedMs: scenario.rangeStartMs ?? null,
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
          project_refs: scenario.projectIds.map((id) => ({ kind: 'project', id })) as never,
          ...(scenario.tenantId === undefined ? {} : { tenant_id: scenario.tenantId }),
          ...(scenario.asOf === undefined ? {} : { as_of: scenario.asOf }),
          ...(scenario.rangeStartMs === undefined
            ? {}
            : { range: { start_ms: scenario.rangeStartMs } }),
          ...(scenario.channels
            ? {
                boundary: {
                  connectors: scenario.connectors,
                  scopes: scenario.scopes,
                  project_refs: scenario.projectIds.map((id) => ({ kind: 'project', id })),
                  ...(scenario.tenantId === undefined ? {} : { tenant_id: scenario.tenantId }),
                  channels: scenario.channels,
                },
              }
            : {}),
          limit: 100,
        } as never
      );
      const readerVisible = new Set(
        result.candidates
          .filter((candidate) => candidate.visible)
          .map((candidate) => (candidate.ref as { raw_id: string }).raw_id)
      );

      for (const fixture of EVENTS) {
        const shown = isEventVisibleNow(indexedEvent(fixture), {
          scopes: scenario.scopes as never,
          ...(scenario.channels ? { channels: scenario.channels } : {}),
          connectors: scenario.connectors,
          projectIds: scenario.projectIds,
          tenantId: scenario.tenantId ?? null,
          maxObservedMs: scenario.asOf === undefined ? null : Date.parse(scenario.asOf),
          minObservedMs: scenario.rangeStartMs ?? null,
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
