/**
 * Raw visibility decided by the (connector, channel) grant.
 *
 * Measured on a live index of 30,671 connector events, with the input shape the runtime
 * actually sends - granted connectors, derived scopes, and the tenant the reader always
 * resolves - the existing predicate returns ZERO rows. Not few: none. Four independent
 * filters each remove a different slice, and naming a tenant or a project additionally
 * closes the legacy escape that was letting the 63% of unscoped rows through, so the more
 * precisely a caller asks, the less it can see.
 *
 * The grant replaces those filters for raw rows. On the same live index it makes 14,080
 * events readable with no data migration - but only from two connectors, and that caveat
 * matters more than the number: for trello, drive, slack and chatwork the index stores the
 * config entry's DISPLAY NAME where the grant holds its key, so 15,279 events belonging to
 * channels the owner did configure stay unreadable until those rows are re-keyed.
 * `canonicalChannelKey` fixes this for newly polled events only. Until a backfill runs, the
 * connectors the owner asks about most are still answered from nothing - which is why the
 * refusal count below is not decoration.
 *
 * Synthetic fixtures only.
 */
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import {
  readRawCandidates,
  setContextSourceClockForTests,
} from '../../src/context-compile/source-readers.js';
import type { ContextSourceReadInput } from '../../src/context-compile/source-readers.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'raw-grant-'));
  tempDirs.push(dir);
  return join(dir, `${randomUUID()}.db`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createAdapter(): DatabaseAdapter {
  const adapter = new NodeSQLiteAdapter({ dbPath: tempDbPath() }) as unknown as DatabaseAdapter;
  adapter.connect();
  adapter.runMigrations(MIGRATIONS_DIR);
  return adapter;
}

/**
 * An event shaped like the ones the live index actually holds: no project, no tenant, and
 * no memory scope. Two thirds of production rows look exactly like this, and every filter
 * the old predicate applies removes them.
 */
function event(adapter: DatabaseAdapter, connector: string, channel: string, title: string): void {
  upsertConnectorEventIndex(adapter, {
    source_connector: connector,
    source_type: 'message',
    source_id: `${connector}:${channel}:${title}`,
    channel,
    title,
    content: `content for ${title}`,
    event_datetime: 1_200,
    source_timestamp_ms: 1_200,
  });
}

// Production always carries scopes - the reader treats their absence as "read nothing",
// on the grant path too. Supplying them here keeps the fixtures faithful to the caller.
const SCOPES = [{ kind: 'global' as const, id: 'system' }];

function input(overrides: Partial<ContextSourceReadInput> = {}): ContextSourceReadInput {
  return { task: 'compile', connectors: ['chat'], scopes: SCOPES, limit: 50, ...overrides };
}

const GRANT = { chat: ['C001', 'C002'], board: ['b-1'] };

function grantBoundary(
  connectors: string[],
  channels: Record<string, string[]> = GRANT
): ContextSourceReadInput['boundary'] {
  return { connectors, scopes: SCOPES, channels };
}

describe('raw candidates within a channel grant', () => {
  it('reads granted channels that carry no scope, project or tenant at all', () => {
    const adapter = createAdapter();
    event(adapter, 'chat', 'C001', 'granted one');
    event(adapter, 'chat', 'C002', 'granted two');

    const result = readRawCandidates(adapter, input({ boundary: grantBoundary(['chat']) }));

    expect(result.candidates.map((c) => c.title).sort()).toEqual(['granted one', 'granted two']);
  });

  // The regression this replaces. Same rows, same caller, the shape the runtime sends.
  it('is what the old predicate returned nothing for', () => {
    const adapter = createAdapter();
    event(adapter, 'chat', 'C001', 'granted one');

    const withoutGrant = readRawCandidates(
      adapter,
      input({
        scopes: [{ kind: 'global', id: 'system' }],
        tenant_id: 'default',
        boundary: {
          connectors: ['chat'],
          scopes: [{ kind: 'global', id: 'system' }],
          tenant_id: 'default',
        },
      })
    );
    expect(withoutGrant.candidates).toEqual([]);

    const withGrant = readRawCandidates(adapter, input({ boundary: grantBoundary(['chat']) }));
    expect(withGrant.candidates).toHaveLength(1);
  });

  it('refuses a channel the owner never configured', () => {
    const adapter = createAdapter();
    event(adapter, 'chat', 'C001', 'granted');
    event(adapter, 'chat', 'C999', 'not configured');

    const result = readRawCandidates(adapter, input({ boundary: grantBoundary(['chat']) }));

    expect(result.candidates.map((c) => c.title)).toEqual(['granted']);
  });

  // The grant is a ceiling, never an instruction: a connector the caller did not ask for
  // stays unread even though it is granted.
  it('reads only the connectors the caller asked for', () => {
    const adapter = createAdapter();
    event(adapter, 'chat', 'C001', 'chat event');
    event(adapter, 'board', 'b-1', 'board event');

    const result = readRawCandidates(
      adapter,
      input({ connectors: ['chat'], boundary: grantBoundary(['chat', 'board']) })
    );

    expect(result.candidates.map((c) => c.title)).toEqual(['chat event']);
  });

  // Failing open here would hand a caller the whole index the moment its request and its
  // grant stopped overlapping - the one mistake a visibility rule must never make.
  it('reads nothing when the request and the grant do not overlap', () => {
    const adapter = createAdapter();
    event(adapter, 'chat', 'C001', 'chat event');

    expect(
      readRawCandidates(
        adapter,
        input({ connectors: ['other'], boundary: grantBoundary(['other']) })
      ).candidates
    ).toEqual([]);
    expect(
      readRawCandidates(
        adapter,
        input({ connectors: ['chat'], boundary: grantBoundary(['chat'], { chat: [] }) })
      ).candidates
    ).toEqual([]);
  });

  // The limit must count rows the caller may see. Applied after the grant it would turn
  // "the 50 most recent events" into "however many of the 50 happened to be readable".
  it('counts the limit in readable rows', () => {
    const adapter = createAdapter();
    for (let i = 0; i < 5; i += 1) event(adapter, 'chat', 'C999', `hidden ${i}`);
    for (let i = 0; i < 3; i += 1) event(adapter, 'chat', 'C001', `visible ${i}`);

    const result = readRawCandidates(
      adapter,
      input({ limit: 3, boundary: grantBoundary(['chat']) })
    );

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((c) => c.title.startsWith('visible'))).toBe(true);
  });

  it('still applies the time window', () => {
    const adapter = createAdapter();
    upsertConnectorEventIndex(adapter, {
      source_connector: 'chat',
      source_type: 'message',
      source_id: 'old',
      channel: 'C001',
      title: 'too old',
      content: 'x',
      event_datetime: 500,
      source_timestamp_ms: 500,
    });
    event(adapter, 'chat', 'C001', 'in window');

    const result = readRawCandidates(
      adapter,
      input({ range: { start_ms: 1_000 }, boundary: grantBoundary(['chat']) })
    );

    expect(result.candidates.map((c) => c.title)).toEqual(['in window']);
  });

  // The isolation the scope columns were attempting, enforced where it can actually be
  // stated. Two runs on the same connector, bound to different channels, must not see each
  // other - the narrowing happens in the caller, so this asserts the reader honours a
  // narrowed grant rather than the config as written.
  it('reads only the channel a narrowed grant names', () => {
    const adapter = createAdapter();
    event(adapter, 'chat', 'C001', 'channel one');
    event(adapter, 'chat', 'C002', 'channel two');

    const boundToOne = readRawCandidates(
      adapter,
      input({ boundary: grantBoundary(['chat'], { chat: ['C001'] }) })
    );

    expect(boundToOne.candidates.map((c) => c.title)).toEqual(['channel one']);
  });

  // Filtering happens in SQL and leaves no trace, so without a count the caller cannot tell
  // "this channel was quiet" from "you may not see this channel". Given that the live index
  // refuses 15,279 events belonging to configured channels, a confident empty answer here
  // is the most likely wrong answer the system can give.
  it('reports how many events the grant kept out', () => {
    const adapter = createAdapter();
    event(adapter, 'chat', 'C001', 'granted');
    event(adapter, 'chat', 'C999', 'refused one');
    event(adapter, 'chat', 'C998', 'refused two');

    const result = readRawCandidates(adapter, input({ boundary: grantBoundary(['chat']) }));

    expect(result.candidates.map((c) => c.title)).toEqual(['granted']);
    expect(result.hidden).toMatchObject({
      total: 2,
      by_reason: { channel_not_granted: 2 },
    });
  });

  it('reports refusals even when nothing at all is readable', () => {
    const adapter = createAdapter();
    event(adapter, 'chat', 'C999', 'refused');

    const result = readRawCandidates(
      adapter,
      input({ boundary: grantBoundary(['chat'], { chat: [] }) })
    );

    expect(result.candidates).toEqual([]);
    expect(result.hidden.by_reason.channel_not_granted).toBe(1);
  });

  // A connector that does not populate channel has every event refused - and the count
  // reported zero, because NOT(...) is NULL for a NULL channel so the row fell out of both
  // sides of the answer. A confident empty answer with clean diagnostics is exactly what
  // the count exists to prevent.
  it('counts a refused event whose channel is null', () => {
    const adapter = createAdapter();
    upsertConnectorEventIndex(adapter, {
      source_connector: 'chat',
      source_type: 'message',
      source_id: 'no-channel',
      title: 'no channel at all',
      content: 'x',
      event_datetime: 1_200,
      source_timestamp_ms: 1_200,
    });
    event(adapter, 'chat', 'C001', 'granted');

    const result = readRawCandidates(adapter, input({ boundary: grantBoundary(['chat']) }));

    expect(result.candidates.map((c) => c.title)).toEqual(['granted']);
    expect(result.hidden.by_reason.channel_not_granted).toBe(1);
  });

  // Found by running the reader against a snapshot of the live index. `event_datetime` is
  // when an event OCCURS, and a calendar entry occurs in the future - 2,762 live rows are
  // future-dated, one in 2056 - so ordering by it descending handed them the entire page.
  // A report asking what happened last week received calendar entries and no messages.
  it('does not let a future-dated event outrank what has happened', () => {
    const adapter = createAdapter();
    setContextSourceClockForTests(() => 2_000);
    try {
      upsertConnectorEventIndex(adapter, {
        source_connector: 'chat',
        source_type: 'message',
        source_id: 'scheduled',
        channel: 'C001',
        title: 'a meeting in 2056',
        content: 'x',
        event_datetime: 9_000,
        source_timestamp_ms: 1_200,
      });
      event(adapter, 'chat', 'C001', 'something that happened');

      const result = readRawCandidates(adapter, input({ boundary: grantBoundary(['chat']) }));

      expect(result.candidates.map((c) => c.title)).toEqual(['something that happened']);
    } finally {
      setContextSourceClockForTests(() => Date.now());
    }
  });

  // A caller that genuinely wants the future still gets it by asking.
  it('includes the future when the caller names an end past it', () => {
    const adapter = createAdapter();
    setContextSourceClockForTests(() => 2_000);
    try {
      upsertConnectorEventIndex(adapter, {
        source_connector: 'chat',
        source_type: 'message',
        source_id: 'scheduled',
        channel: 'C001',
        title: 'a meeting in 2056',
        content: 'x',
        event_datetime: 9_000,
        source_timestamp_ms: 1_200,
      });

      const result = readRawCandidates(
        adapter,
        input({ range: { end_ms: 10_000 }, boundary: grantBoundary(['chat']) })
      );

      expect(result.candidates.map((c) => c.title)).toEqual(['a meeting in 2056']);
    } finally {
      setContextSourceClockForTests(() => Date.now());
    }
  });

  // Both fail-closed states must hold on this path too: skipping them would have turned a
  // deliberate "read nothing" request into a read.
  it('still honours the explicit read-nothing requests', () => {
    const adapter = createAdapter();
    event(adapter, 'chat', 'C001', 'granted');

    expect(
      readRawCandidates(
        adapter,
        input({
          project_refs: [],
          boundary: { ...grantBoundary(['chat']), project_refs: [{ kind: 'project', id: 'p1' }] },
        })
      ).candidates
    ).toEqual([]);
    expect(
      readRawCandidates(adapter, input({ scopes: [], boundary: grantBoundary(['chat']) }))
        .candidates
    ).toEqual([]);
  });
});
