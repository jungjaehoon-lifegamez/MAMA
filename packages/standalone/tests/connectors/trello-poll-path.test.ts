import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConnectorRegistry } from '../../src/connectors/framework/connector-registry.js';
import { PollingScheduler } from '../../src/connectors/framework/polling-scheduler.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';
import { TrelloConnector } from '../../src/connectors/trello/index.js';
import { RawStore } from '../../src/storage/source-archive.js';

// The live path: TrelloConnector -> PollingScheduler (stamps channelName and observedAt) ->
// RawStore.save, with the windows overlapping as they do every poll.
const roots: string[] = [];
let raw: RawStore | undefined;

function comment(text: string) {
  return {
    id: 'action-comment',
    type: 'commentCard',
    date: '2026-10-02T01:00:00.000Z',
    data: { card: { id: 'card-a', name: 'Still 01' }, text },
    memberCreator: { id: 'm', fullName: 'Member A' },
  };
}

async function livePath(
  channels: ConnectorConfig['channels'],
  respond: (url: URL) => Response | Promise<Response>
) {
  const root = mkdtempSync(join(tmpdir(), 'trello-poll-path-'));
  roots.push(root);
  raw = new RawStore(join(root, 'raw'));
  const config: ConnectorConfig = {
    enabled: true,
    pollIntervalMinutes: 5,
    channels,
    auth: { type: 'token' },
  };
  const connector = new TrelloConnector(config, async (input) => respond(new URL(String(input))));
  await connector.init();
  const registry = new ConnectorRegistry();
  registry.register('trello', connector);
  const errors: string[] = [];
  // The clock sits just before the action, so every poll's window still holds it (the overlap).
  const clock = Date.parse('2026-10-02T00:59:00.000Z');
  const scheduler = new PollingScheduler(raw, root, {
    now: () => clock,
    initialNow: clock,
    rawIndexSink: (connectorName, items) =>
      items.map((item) => ({
        sourceId: item.sourceId,
        observationRef: `obs:${connectorName}:${item.sourceId}`,
      })),
    recordPollOutcome: (_name, outcome) => {
      if (outcome.error) errors.push(outcome.error);
    },
  });
  const deltas: unknown[] = [];
  const poll = () =>
    scheduler.pollConnector('trello', registry, { trello: channels }, async (delta) => {
      deltas.push(delta);
    });
  return { scheduler, poll, errors, deltas, stored: () => raw!.query('trello', new Date(0)) };
}

describe('Trello live poll path', () => {
  beforeEach(() => {
    vi.stubEnv('MAMA_TRELLO_KEY', 'fixture-key');
    vi.stubEnv('MAMA_TRELLO_TOKEN', 'fixture-token');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    raw?.close();
    raw = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('stores an action listed by two overlapping polls once, named or not', async () => {
    for (const channels of [
      { 'board-key': { role: 'truth' as const, name: 'Board A', boardId: 'board-a' } },
      { 'board-key': { role: 'truth' as const, boardId: 'board-a' } },
    ]) {
      const path = await livePath(channels, () => Response.json([comment('Fixed')]));
      await path.poll();
      await path.poll();
      expect(path.errors).toEqual([]);
      expect(path.stored()).toHaveLength(1);
      expect(path.deltas).toHaveLength(1);
      raw?.close();
      raw = undefined;
    }
  });

  it('keeps polling when a comment is edited between two polls', async () => {
    let text = 'Fixed';
    const path = await livePath(
      { 'board-key': { role: 'truth', name: 'Board A', boardId: 'board-a' } },
      () => Response.json([comment(text)])
    );
    await path.poll();
    text = 'Fixed, thanks';
    await path.poll();
    expect(path.errors).toEqual([]);
    expect(path.stored().map((item) => item.content)).toContain(
      'Still 01 | comment: Fixed, thanks | Member A'
    );
  });

  it('stores nothing and keeps the cursor when one board fails', async () => {
    const path = await livePath(
      {
        healthy: { role: 'truth', boardId: 'board-ok' },
        broken: { role: 'truth', boardId: 'board-down' },
      },
      (url) =>
        url.pathname.includes('board-down')
          ? new Response(null, { status: 503 })
          : Response.json([comment('Fixed')])
    );
    const before = path.scheduler.getLastPollTime('trello');
    await path.poll();
    expect(path.errors).toEqual([
      expect.stringContaining('Trello poll failed for 1 of 2 configured boards'),
    ]);
    expect(path.stored()).toHaveLength(0);
    expect(path.scheduler.getLastPollTime('trello')).toEqual(before);
  });
});
