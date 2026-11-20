import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RawStore, type NormalizedItem } from '../../src/storage/source-archive.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createAccountStore } from '../../src/runtime/account-store.js';
import {
  createPersonalSourceStore,
  personalChannelKey,
} from '../../src/runtime/personal-source-store.js';
import { startPersonalSources } from '../../src/runtime/personal-source-runtime.js';
import type { PersonalKindAdapter } from '../../src/connectors/personal/kinds.js';
import type { IConnector } from '../../src/connectors/framework/types.js';

const DAY = 86_400_000;
let root: string;
let database: Awaited<ReturnType<typeof openCoreDatabase>>;
let raw: RawStore;
let indexed: Array<{ connector: string; item: NormalizedItem }>;
let polls: Array<{ since: Date; token: string }>;
let fail: boolean;
let gate: Promise<void> | null;

function fakeConnector(token: string): IConnector {
  return {
    name: 'chatwork',
    type: 'api',
    init: async () => {},
    dispose: async () => {},
    healthCheck: async () => ({ healthy: true, lastPollTime: null, lastPollCount: 0 }),
    getAuthRequirements: () => [],
    authenticate: async () => true,
    poll: async (since) => {
      polls.push({ since, token });
      if (gate) await gate;
      if (fail) throw new Error('Chatwork answered 401');
      return [
        {
          source: 'chatwork',
          sourceId: '111:m1',
          channel: 'room-one',
          author: 'someone',
          content: 'hello',
          timestamp: new Date(Date.UTC(2026, 10, 20)),
          type: 'message',
        },
      ];
    },
  };
}

const chatwork: PersonalKindAdapter = {
  kind: 'chatwork',
  identify: async () => ({ id: '7', name: 'a' }),
  channels: async () => [],
  config: (secrets, channels) => ({
    enabled: true,
    pollIntervalMinutes: 5,
    channels: Object.fromEntries(
      channels.map((c) => [c.id, { role: 'hub' as const, name: c.name ?? undefined }])
    ),
    auth: { type: 'token', tokenName: 'MAMA_CHATWORK_TOKEN' },
    secrets: { MAMA_CHATWORK_TOKEN: secrets.token! },
  }),
  build: async (config) => fakeConnector(config.secrets!.MAMA_CHATWORK_TOKEN!),
};

async function runtime(now = Date.UTC(2026, 10, 20, 12)) {
  const store = createPersonalSourceStore(database.adapter);
  const accounts = createAccountStore(join(root, 'accounts'));
  const timers: Array<() => void> = [];
  const accepted = vi.fn();
  const personal = startPersonalSources({
    store,
    accounts,
    kinds: { chatwork } as never,
    rawStore: raw,
    indexSink: async (connector, items) => {
      for (const item of items) indexed.push({ connector, item });
      return items.map((item) => ({
        sourceId: item.sourceId,
        observationRef: `obs:${item.sourceId}`,
      }));
    },
    root: join(root, 'personal'),
    now: () => now,
    setInterval: ((fn: () => void) => {
      timers.push(fn);
      return 0 as never;
    }) as never,
    clearInterval: () => {},
    log: () => {},
  });
  return { store, accounts, personal, timers, accepted };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mama-personal-runtime-'));
  database = await openCoreDatabase({ path: join(root, 'state.db') });
  raw = new RawStore(join(root, 'raw'));
  indexed = [];
  polls = [];
  fail = false;
  gate = null;
});
afterEach(async () => {
  raw.close();
  await database.close();
  rmSync(root, { recursive: true, force: true });
});

const bind = (r: Awaited<ReturnType<typeof runtime>>, person: string, token: string) => {
  r.accounts.set(person, 'chatwork', { token, accountId: '7', name: 'a' });
  r.store.bind(person, 'chatwork', [{ id: '111', name: 'room-one' }]);
};

describe('personal source runtime (personal-connectors.md, C3)', () => {
  it("stores items as personal-<kind>, keyed and scoped to the person, on the person's token", async () => {
    const r = await runtime();
    bind(r, 'person-a', 'a-token');
    await r.personal.start('person-a', 'chatwork');
    expect(polls[0]).toMatchObject({ token: 'a-token' });
    expect(polls[0]!.since.getTime()).toBe(Date.UTC(2026, 10, 20, 12) - 7 * DAY);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({
      connector: 'personal-chatwork',
      item: {
        source: 'personal-chatwork',
        channel: personalChannelKey('person-a', '111'),
        memoryScopeKind: 'user',
        memoryScopeId: 'person-a',
      },
    });
    expect(indexed[0]!.item.sourceId).toBe(
      `${personalChannelKey('person-a', '111').split(':')[0]}:111:m1`
    );
    expect(r.store.get('person-a', 'chatwork')).toMatchObject({ lastError: null });
    await r.personal.stopAll();
  });

  it('two people binding one room keep their own copies', async () => {
    const r = await runtime();
    bind(r, 'person-a', 'a-token');
    bind(r, 'person-b', 'b-token');
    await r.personal.start('person-a', 'chatwork');
    await r.personal.start('person-b', 'chatwork');
    expect(new Set(indexed.map(({ item }) => item.sourceId)).size).toBe(2);
    expect(raw.count('personal-chatwork')).toBe(2);
    await r.personal.stopAll();
  });

  it('a failing source records its error and the next person still polls (Review Focus 3)', async () => {
    const r = await runtime();
    bind(r, 'person-a', 'a-token');
    bind(r, 'person-b', 'b-token');
    fail = true;
    await r.personal.start('person-a', 'chatwork');
    fail = false;
    await r.personal.start('person-b', 'chatwork');
    expect(r.store.get('person-a', 'chatwork')!.lastError).toMatch(/401/);
    expect(r.store.get('person-b', 'chatwork')!.lastError).toBeNull();
    await r.personal.stopAll();
  });

  it("a restart resumes from the person's own poll state (Review Focus 4)", async () => {
    const first = await runtime(Date.UTC(2026, 10, 20, 12));
    bind(first, 'person-a', 'a-token');
    await first.personal.start('person-a', 'chatwork');
    await first.personal.stopAll();
    const second = await runtime(Date.UTC(2026, 10, 20, 13));
    await second.personal.startAll();
    expect(polls[1]!.since.getTime()).toBe(Date.UTC(2026, 10, 20, 12));
    await second.personal.stopAll();
  });

  it('stop waits for an in-flight poll, so no batch lands after it (Review Focus 5)', async () => {
    const r = await runtime();
    bind(r, 'person-a', 'a-token');
    await r.personal.start('person-a', 'chatwork');
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    const polling = r.personal.pollNow('person-a', 'chatwork');
    const stopping = r.personal.stop('person-a', 'chatwork');
    release();
    await Promise.all([polling, stopping]);
    const after = indexed.length;
    await r.personal.pollNow('person-a', 'chatwork');
    expect(indexed.length).toBe(after);
  });

  it('a source without a connected account is not started and says why', async () => {
    const r = await runtime();
    r.store.bind('person-a', 'chatwork', [{ id: '111', name: 'room-one' }]);
    await r.personal.start('person-a', 'chatwork');
    expect(polls).toEqual([]);
    expect(r.store.get('person-a', 'chatwork')!.lastError).toMatch(/not connected/);
  });
});

describe('deleting a personal source (personal-connectors.md, C5)', () => {
  it("leaves no raw or index row of that person's source, and keeps another's copy", async () => {
    const { deletePersonalSourceData } =
      await import('../../src/runtime/personal-source-runtime.js');
    const { coreIndexSink } = await import('../../src/runtime/connectors.js');
    const r = await runtime();
    const sink = coreIndexSink(database.adapter);
    const store = r.store;
    bind(r, 'person-a', 'a-token');
    bind(r, 'person-b', 'b-token');
    const personal = startPersonalSources({
      store,
      accounts: r.accounts,
      kinds: { chatwork } as never,
      rawStore: raw,
      indexSink: sink,
      root: join(root, 'personal-real'),
      now: () => Date.UTC(2026, 10, 20, 12),
      setInterval: (() => 0) as never,
      clearInterval: () => {},
      log: () => {},
    });
    await personal.start('person-a', 'chatwork');
    await personal.start('person-b', 'chatwork');
    const rows = (id: string) =>
      database.adapter
        .prepare(
          "SELECT count(*) AS n FROM connector_event_index WHERE source_connector='personal-chatwork' AND memory_scope_id=?"
        )
        .get(id) as { n: number };
    expect(rows('person-a').n).toBe(1);
    await personal.stop('person-a', 'chatwork');
    const deleted = deletePersonalSourceData(database.adapter, raw, 'person-a', 'chatwork');
    expect(deleted).toMatchObject({ index: 1, raw: { raw_items: 1 } });
    expect(rows('person-a').n).toBe(0);
    expect(rows('person-b').n).toBe(1);
    expect(raw.count('personal-chatwork')).toBe(1);
    await personal.stopAll();
  });
});
