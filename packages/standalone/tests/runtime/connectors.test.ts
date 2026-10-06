import { deltaRecordOrder, recordOrderPayload } from '../../src/runtime/turn-orders.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCatalog,
  createDispatcher,
  type ActionContext,
  type NativeDeliveryContext,
  type NativeTurnResult,
} from '@jungjaehoon/mama-core';
import { Mailbox, type Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import {
  setLiveConnectorPollCursors,
  startConnectorRuntime,
} from '../../src/runtime/connectors.js';
import type {
  ConnectorConfig,
  IConnector,
  NormalizedItem,
} from '../../src/connectors/framework/types.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { storedSourceFamilies } from '../../src/connectors/framework/stored-index-read.js';
import { ownerSystemPrompt } from '../../src/runtime/owner-system-prompt.js';
import { sourceActionRegistrations } from '../../src/api/source-actions.js';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import {
  createStimulusDelivery,
  createStimulusIntake,
} from '../../src/runtime/stimulus-delivery.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fake(name: string, items: NormalizedItem[]): IConnector {
  return {
    name,
    type: name === 'kagemusha' ? 'local' : 'api',
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, lastPollTime: null, lastPollCount: 0 }),
    getAuthRequirements: vi.fn().mockReturnValue([]),
    authenticate: vi.fn().mockResolvedValue(true),
    poll: vi.fn().mockResolvedValue(items),
  };
}

describe('connector runtime', () => {
  it('rejects an Obsidian vault that contains the configured wiki root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-wiki-feedback-'));
    roots.push(root);
    const vault = join(root, 'vault');
    await expect(
      startConnectorRuntime({
        timeZone: createTimeZoneSetting('UTC'),
        configPath: join(root, 'unused.json'),
        rawPath: join(root, 'raw'),
        statePath: join(root, 'state'),
        wikiRoot: join(vault, 'wiki'),
        configResult: {
          ok: true,
          config: {
            obsidian: {
              enabled: true,
              pollIntervalMinutes: 5,
              channels: { notes: { role: 'reference', vaultPath: vault } },
              auth: { type: 'none' },
            },
          },
          enabledNames: ['obsidian'],
        },
        rawIndexSink: () => [],
        acceptSourceDelta: async () => {},
        loadConnector: async (name) => fake(name, []),
      })
    ).rejects.toThrow(/contains the configured wiki root/);
  });
  it('validates all enabled intervals before creating timers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-runtime-interval-'));
    roots.push(root);
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const startup = startConnectorRuntime({
      timeZone: createTimeZoneSetting('UTC'),
      configPath: join(root, 'unused.json'),
      rawPath: join(root, 'raw'),
      statePath: join(root, 'state'),
      configResult: {
        ok: true,
        config: {
          slack: { enabled: true, pollIntervalMinutes: 5, channels: {}, auth: { type: 'none' } },
        },
        enabledNames: ['slack', 'chatwork'],
      },
      rawIndexSink: () => [],
      acceptSourceDelta: async () => {},
      loadConnector: async (name) => fake(name, []),
      setInterval: (handler, timeout) => {
        const timer = setInterval(handler, timeout);
        timers.push(timer);
        return timer;
      },
    });
    try {
      await expect(startup).rejects.toThrow(/poll interval.*chatwork/i);
      expect(timers).toHaveLength(0);
    } finally {
      for (const timer of timers) clearInterval(timer);
    }
  });

  it('sets the poll fence only for the currently enabled live connector set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-runtime-fence-'));
    roots.push(root);
    const configPath = join(root, 'connectors.json');
    const statePath = join(root, 'state');
    writeFileSync(
      configPath,
      JSON.stringify({
        slack: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'none' },
        },
        chatwork: {
          enabled: false,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'none' },
        },
      }),
      'utf8'
    );

    const fence = Date.parse('2026-09-02T00:00:00.000+09:00');
    setLiveConnectorPollCursors({ configPath, statePath, fenceMs: fence });

    expect(JSON.parse(readFileSync(join(statePath, 'poll-state.json'), 'utf8'))).toEqual({
      slack: new Date(fence).toISOString(),
    });
  });

  it('initializes only supported enabled connectors and freezes the one-day window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-runtime-'));
    roots.push(root);
    const configPath = join(root, 'connectors.json');
    const rawPath = join(root, 'raw');
    const statePath = join(root, 'state');
    const kagemushaDbPath = join(root, 'kagemusha.db');
    writeFileSync(
      configPath,
      JSON.stringify({
        slack: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { 'channel-key': { role: 'hub' } },
          auth: { type: 'token', tokenName: 'MAMA_SLACK_TOKEN' },
        },
        chatwork: {
          enabled: false,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'token', tokenName: 'MAMA_CHATWORK_TOKEN' },
        },
        trello: {
          enabled: true,
          pollIntervalMinutes: 10,
          channels: { 'board-key': { role: 'truth', boardId: 'board-key' } },
          auth: { type: 'token', tokenName: 'MAMA_TRELLO_TOKEN' },
        },
        kagemusha: {
          enabled: true,
          pollIntervalMinutes: 15,
          channels: { 'room-key': { role: 'hub' } },
          auth: { type: 'none' },
        },
        unsupported: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'none' },
        },
      }),
      'utf8'
    );
    const now = Date.parse('2024-01-02T00:00:00.000Z');
    const calls = new Map<string, IConnector>();
    const connectorPaths = new Map<string, unknown>();
    const deltas: unknown[] = [];
    const setIntervalMock = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
    const runtime = await startConnectorRuntime({
      timeZone: createTimeZoneSetting('UTC'),
      configPath,
      rawPath,
      statePath,
      kagemushaDbPath,
      clock: () => now,
      rawIndexSink: (_connector, items) =>
        items.map((item) => ({ sourceId: item.sourceId, observationRef: `obs:${item.sourceId}` })),
      acceptSourceDelta: async (delta) => {
        deltas.push(delta);
      },
      loadConnector: async (name, _config, paths) => {
        connectorPaths.set(name, paths);
        const item: NormalizedItem = {
          source: name,
          sourceId: `${name}-source`,
          channel: name === 'slack' ? 'channel-key' : name === 'trello' ? 'board-key' : 'room-key',
          author: 'actor-key',
          content: `${name}-content`,
          timestamp: new Date(now - 1_000),
          type: 'message',
        };
        const value = fake(name, [item]);
        calls.set(name, value);
        return value;
      },
      setInterval: setIntervalMock,
      clearInterval: vi.fn(),
    });
    expect([...calls.keys()]).toEqual(['slack', 'trello', 'kagemusha']);
    const expectedPaths = {
      kagemushaDbPath,
      timeZone: { get: expect.any(Function), set: expect.any(Function) },
    };
    expect(connectorPaths.get('trello')).toEqual(expectedPaths);
    expect(connectorPaths.get('kagemusha')).toEqual(expectedPaths);
    for (const value of calls.values()) {
      expect(value.poll).toHaveBeenCalledWith(new Date(now - 86_400_000), { hasCursor: false });
    }
    expect(deltas).toHaveLength(3);
    expect(setIntervalMock).toHaveBeenCalledTimes(3);
    await runtime.stop();
  });

  it('uses the real core adapter for the raw-to-index projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-runtime-index-'));
    roots.push(root);
    const configPath = join(root, 'connectors.json');
    const rawPath = join(root, 'raw');
    const statePath = join(root, 'state');
    const database = await openCoreDatabase({ path: join(root, 'core.db') });
    writeFileSync(
      configPath,
      JSON.stringify({
        slack: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { 'channel-key': { role: 'hub' } },
          auth: { type: 'token', tokenName: 'MAMA_SLACK_TOKEN' },
        },
      }),
      'utf8'
    );
    const now = Date.parse('2024-01-02T00:00:00.000Z');
    const runtime = await startConnectorRuntime({
      timeZone: createTimeZoneSetting('UTC'),
      configPath,
      rawPath,
      statePath,
      clock: () => now,
      coreAdapter: database.adapter,
      acceptSourceDelta: vi.fn(),
      loadConnector: async (name) =>
        fake(name, [
          {
            source: name,
            sourceId: 'source-key',
            channel: 'channel-key',
            author: 'actor-key',
            content: 'source-content',
            timestamp: new Date(now - 1_000),
            type: 'message',
          },
        ]),
      setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearInterval: vi.fn(),
    });
    await runtime.stop();
    expect(
      database.adapter
        .prepare(
          'SELECT source_connector, channel, content FROM connector_event_index WHERE source_id = ?'
        )
        .get('source-key')
    ).toEqual({
      source_connector: 'slack',
      channel: 'channel-key',
      content: 'source-content',
    });
    const raw = new RawStore(rawPath);
    try {
      expect(raw.query('slack', new Date(0))).toHaveLength(1);
    } finally {
      raw.close();
      await database.close();
    }
  });

  it('aborts a connector handoff when source projection fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-runtime-projection-failure-'));
    roots.push(root);
    const rawStore = new RawStore(join(root, 'raw'));
    const connector = fake('discord', [
      {
        source: 'discord',
        sourceId: 'source-fixture',
        channel: 'channel-fixture',
        author: 'fixture-author',
        content: 'fixture source content',
        timestamp: new Date('2026-09-26T00:00:00.000Z'),
        type: 'message',
      },
    ]);
    connector.beginPollHandoff = vi.fn();
    connector.commitPoll = vi.fn();
    connector.abortPollHandoff = vi.fn();
    const runtime = await startConnectorRuntime({
      timeZone: createTimeZoneSetting('UTC'),
      configPath: join(root, 'connectors.json'),
      rawPath: join(root, 'raw'),
      statePath: join(root, 'state'),
      rawStore,
      rawIndexSink: () => {
        throw new Error('fixture projection failure');
      },
      configResult: {
        ok: true,
        config: {
          discord: {
            enabled: true,
            pollIntervalMinutes: 5,
            channels: { 'channel-fixture': { role: 'hub' } },
            auth: { type: 'none' },
          },
        },
        enabledNames: ['discord'],
      },
      acceptSourceDelta: vi.fn(),
      loadConnector: async () => connector,
      setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearInterval: vi.fn(),
    });

    try {
      expect(connector.beginPollHandoff).toHaveBeenCalledOnce();
      expect(connector.abortPollHandoff).toHaveBeenCalledOnce();
      expect(connector.commitPoll).not.toHaveBeenCalled();
      expect(rawStore.listPendingProjections('discord')).toHaveLength(1);
    } finally {
      await runtime.stop();
      rawStore.close();
    }
  });

  it('projects every restored source family into the owner readable-sources line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restored-connector-index-'));
    roots.push(root);
    const database = await openCoreDatabase({ path: join(root, 'core.db') });
    const names = [
      'gmail',
      'drive',
      'sheets',
      'notion',
      'obsidian',
      'discord',
      'telegram',
      'imessage',
      'claude-code',
    ];
    const config = Object.fromEntries(
      names.map((name) => [
        name,
        {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { [`${name}:fixture-family:fixture-room`]: { role: 'hub' } },
          auth: { type: 'none' },
        } satisfies ConnectorConfig,
      ])
    );
    const commits = new Map<string, ReturnType<typeof vi.fn>>();
    const connectorPaths = new Map<string, unknown>();
    const runtime = await startConnectorRuntime({
      timeZone: createTimeZoneSetting('UTC'),
      configPath: join(root, 'connectors.json'),
      rawPath: join(root, 'raw'),
      statePath: join(root, 'state'),
      clock: () => Date.parse('2026-09-27T00:00:00.000Z'),
      coreAdapter: database.adapter,
      configResult: { ok: true, config, enabledNames: names },
      acceptSourceDelta: async () => {},
      loadConnector: async (name, _config, paths) => {
        connectorPaths.set(name, paths);
        const item: NormalizedItem = {
          source: name,
          sourceId: `source-${name}`,
          channel: `${name}:fixture-family:fixture-room`,
          author: 'fixture-author',
          content: `fixture source content for ${name}`,
          timestamp: new Date('2026-09-26T23:59:00.000Z'),
          type: 'message',
        };
        const connector = fake(name, [item]);
        const commitPoll = vi.fn();
        connector.beginPollHandoff = vi.fn();
        connector.commitPoll = commitPoll;
        connector.abortPollHandoff = vi.fn();
        commits.set(name, commitPoll);
        return connector;
      },
      setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearInterval: vi.fn(),
    });

    try {
      await runtime.stop();
      const families = storedSourceFamilies(database.adapter, names);
      const prompt = ownerSystemPrompt('codex', null, families, true, 'UTC');
      for (const name of names) {
        expect(prompt).toContain(`${name} (1; fixture-family 1)`);
        expect(commits.get(name)).toHaveBeenCalledOnce();
      }
      for (const name of ['drive', 'sheets', 'discord', 'telegram']) {
        expect(connectorPaths.get(name)).toMatchObject({
          connectorStatePath: join(root, 'state', `${name}-state.json`),
        });
      }
    } finally {
      await database.close();
    }
  });

  it('carries every connector delta ref through the mailbox into real source.read dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-runtime-source-read-'));
    roots.push(root);
    const configPath = join(root, 'connectors.json');
    const rawPath = join(root, 'raw');
    const statePath = join(root, 'state');
    const database = await openCoreDatabase({ path: join(root, 'core.db') });
    const rawStore = new RawStore(rawPath);
    const mailbox = new Mailbox(database.adapter);
    const stored = createStoredSourceReader({
      adapter: database.adapter,
      ownerPrincipalId: () => 'owner',
      rawStore: () => rawStore,
    });
    const catalog = createCatalog(
      sourceActionRegistrations({ stored, timeZone: createTimeZoneSetting('UTC') })
    );
    const dispatch = createDispatcher(catalog);
    const access: ActionContext['access'] = {
      principalId: 'owner',
      agentId: 'agent',
      actions: ['source.read'],
      connectors: ['slack'],
      scopes: [],
    };
    const runtime = {
      mailbox,
      accept: (stimulus: Stimulus) => {
        const inputId = mailbox.enqueue(stimulus);
        return {
          inputId: inputId === null ? null : stimulus.id,
          state: inputId === null ? 'duplicate' : 'accepted',
        } as const;
      },
    };
    const intake = createStimulusIntake(runtime, 'owner', {
      saveOwnerMessage: () => 'observation-test',
      saveReply: () => {},
    });
    writeFileSync(
      configPath,
      JSON.stringify({
        slack: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { 'channel-key': { role: 'hub' } },
          auth: { type: 'none' },
        },
      }),
      'utf8'
    );
    const now = Date.now();
    const items: NormalizedItem[] = [
      {
        source: 'slack',
        sourceId: 'source-1',
        channel: 'channel-key',
        author: 'actor-key',
        content: 'first source body',
        timestamp: new Date(now - 2_000),
        type: 'message',
      },
      {
        source: 'slack',
        sourceId: 'source-2',
        channel: 'channel-key',
        author: 'actor-key',
        content: 'second source body',
        timestamp: new Date(now - 1_000),
        type: 'message',
      },
    ];
    const connectorRuntime = await startConnectorRuntime({
      timeZone: createTimeZoneSetting('UTC'),
      configPath,
      rawPath,
      statePath,
      coreAdapter: database.adapter,
      acceptSourceDelta: async (delta) => {
        intake.acceptSourceDelta(delta);
      },
      loadConnector: async (name) => fake(name, items),
      setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearInterval: vi.fn(),
    });

    try {
      const row = mailbox.claimNext();
      expect(row).not.toBeNull();
      expect(row?.kind).toBe('source_delta');
      let recordRow: typeof row = null;
      const delivery = createStimulusDelivery({
        backend: 'codex',
        timeZone: createTimeZoneSetting('UTC'),
        recordOrders: {
          enqueueFirst: (delta) => {
            recordRow = delta;
          },
          onResult: () => {},
          onLost: () => {},
        },
      });
      let notifyText = '';
      const context: NativeDeliveryContext = {
        nativeInputId: 'native-input',
        resultForReceipt: () => null,
        run: async (content): Promise<NativeTurnResult> => {
          notifyText = content[0]?.type === 'text' ? (content[0].text ?? '') : '';
          return {
            response: '[ack]',
            turns: 1,
            history: [],
            totalUsage: { input_tokens: 1, output_tokens: 1 },
            stopReason: 'end_turn',
            modelRunId: null,
            modelRunProvenance: 'backend_no_run',
          };
        },
        steer: async () => {
          throw new Error('steer is not used by this delivery test');
        },
        wasDispatched: () => false,
        onInputDispatch: () => {},
        onAccepted: () => {},
      };

      await delivery.deliver(row!, context);
      // The notify order carries the message bodies; the record order carries every ref.
      expect(notifyText).toContain('<<<UNTRUSTED-CONTENT source=source_delta>>>');
      expect(notifyText).toContain('second source body');
      const recordText = deltaRecordOrder(recordOrderPayload(recordRow!, 1), new Date(), {
        backend: 'codex',
        timeZone: 'UTC',
        wikiEnabled: false,
      });
      const listed = recordText
        .split('\n')
        .find((line) => line.startsWith('observations: '))!
        .slice('observations: '.length)
        .split(', ');
      expect(listed.slice().sort()).toEqual(row!.refs.map((ref) => ref.observationRef).sort());
      const result = await dispatch(
        { action: 'source.read', input: { observationRefs: listed }, operationId: 'read-all' },
        { access }
      );
      expect(result.status).toBe('completed');
      const reads = (result as { data: { results: Array<{ status: string }> } }).data.results;
      expect(reads.map((read) => read.status)).toEqual(['completed', 'completed']);
    } finally {
      await connectorRuntime.stop();
      rawStore.close();
      await database.close();
    }
  });
});
