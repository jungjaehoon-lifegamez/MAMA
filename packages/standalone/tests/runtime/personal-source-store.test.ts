import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  createPersonalSourceStore,
  personalChannelKey,
  personalConnectorName,
} from '../../src/runtime/personal-source-store.js';

const homes: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];

afterEach(async () => {
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function store() {
  const home = mkdtempSync(join(tmpdir(), 'mama-personal-sources-'));
  homes.push(home);
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  databases.push(db);
  let clock = 1_000;
  return createPersonalSourceStore(db.adapter, { now: () => clock++ });
}

const room = { id: '111', name: 'room-one' };

describe('personal source store (personal-connectors.md, C1)', () => {
  it("binds and lists a person's sources, theirs only", async () => {
    const sources = await store();
    sources.bind('person-a', 'chatwork', [room]);
    sources.bind('person-a', 'slack', [{ id: 'C1', name: null }]);
    expect(sources.list('person-a').map((source) => source.kind)).toEqual(['chatwork', 'slack']);
    expect(sources.get('person-a', 'chatwork')).toMatchObject({
      principalId: 'person-a',
      kind: 'chatwork',
      channels: [room],
      lastPollAt: null,
      lastError: null,
    });
    expect(sources.list('person-b')).toEqual([]);
    expect(sources.listAll()).toHaveLength(2);
  });

  it('rebinding replaces the channels and keeps when it was created', async () => {
    const sources = await store();
    sources.bind('person-a', 'chatwork', [room]);
    const created = sources.get('person-a', 'chatwork')!.createdAt;
    sources.bind('person-a', 'chatwork', [{ id: '222', name: 'room-two' }]);
    expect(sources.get('person-a', 'chatwork')).toMatchObject({
      channels: [{ id: '222', name: 'room-two' }],
      createdAt: created,
    });
  });

  it('remove and removeAll return what they removed', async () => {
    const sources = await store();
    sources.bind('person-a', 'chatwork', [room]);
    sources.bind('person-a', 'slack', [{ id: 'C1', name: null }]);
    sources.bind('person-b', 'chatwork', [room]);
    expect(sources.remove('person-a', 'chatwork')).toBe(true);
    expect(sources.remove('person-a', 'chatwork')).toBe(false);
    expect(sources.removeAll('person-a')).toEqual(['slack']);
    expect(sources.list('person-a')).toEqual([]);
    expect(sources.list('person-b')).toHaveLength(1);
  });

  it('recordPoll keeps the last error until a clean poll', async () => {
    const sources = await store();
    sources.bind('person-a', 'chatwork', [room]);
    sources.recordPoll('person-a', 'chatwork', { at: 50, error: 'Chatwork /me answered 401' });
    expect(sources.get('person-a', 'chatwork')).toMatchObject({
      lastPollAt: 50,
      lastError: 'Chatwork /me answered 401',
    });
    sources.recordPoll('person-a', 'chatwork', { at: 60, error: null });
    expect(sources.get('person-a', 'chatwork')).toMatchObject({ lastPollAt: 60, lastError: null });
  });

  it('names personal storage apart from the install’s connectors, one key per person', () => {
    expect(personalConnectorName('chatwork')).toBe('personal-chatwork');
    const a = personalChannelKey('person-a', '111');
    const b = personalChannelKey('person-b', '111');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}:111$/);
    expect(personalChannelKey('person-a', '111')).toBe(a);
  });
});
