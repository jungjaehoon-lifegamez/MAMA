import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledge } from '@jungjaehoon/mama-core';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  createStimulusDelivery,
  createStimulusIntake,
} from '../../src/runtime/stimulus-delivery.js';
import { createNativeSession } from '../../src/runtime/native-session.js';
import type { IModelRunner, PromptOptions } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { createActionSurface, ownerMemoryScopes } from '../../src/runtime/action-surface.js';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { ChatSources, ownerMessageItem, ownerReplyItem } from '../../src/storage/chat-sources.js';
import { readReplaySourceEvents } from '../../src/replay/replay-source-catalog.js';
import { readSessionStartInput } from '../../src/runtime/session-start-context.js';
import { LOADABLE_CONNECTORS } from '../../src/connectors/index.js';
import { createCoreRawIndexSink } from '../../src/replay/import-manifest.js';

let home: string;
let database: Awaited<ReturnType<typeof openCoreDatabase>>;
let raw: RawStore;
let chat: ChatSources;
let mailbox: Mailbox;
let surface: ReturnType<typeof createActionSurface>;
let intake: ReturnType<typeof createStimulusIntake>;
const message = {
  id: 'telegram:room-test:message-test',
  channelKey: 'room-test',
  occurredAt: Date.parse('2026-01-01T00:00:00Z'),
  text: 'Keep the synthetic correction narrow',
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'chat-sources-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  database = await openCoreDatabase({ path: join(home, 'state.db') });
  raw = new RawStore(join(home, 'raw'));
  chat = new ChatSources(raw, database.adapter, 'owner-test', 'agent-test');
  mailbox = new Mailbox(database.adapter);
  intake = createStimulusIntake(
    {
      mailbox,
      accept: (stimulus) => ({ inputId: mailbox.enqueue(stimulus)!, state: 'accepted' }),
    },
    'owner-test',
    chat
  );
  surface = createActionSurface({
    adapter: database.adapter,
    knowledge: createKnowledge({ adapter: database.adapter }),
    ownerPrincipalId: 'owner-test',
    agentId: 'agent-test',
    connectors: ['slack'],
    timeZone: createTimeZoneSetting('UTC'),
    configPath: join(home, 'config.yaml'),
    isOwnerMessageTurn: () => true,
    storedSourceReader: createStoredSourceReader({
      adapter: database.adapter,
      ownerPrincipalId: () => 'owner-test',
      rawStore: () => raw,
    }),
    ownerMessages: { exchanges: (since, before) => chat.exchanges(since, before) },
  });
});

afterEach(async () => {
  raw.close();
  await database.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function call(action: string, input: unknown) {
  const result = await surface.dispatch({ action, input }, { access: surface.ownerAccess });
  expect(result.status).toBe('completed');
  return (result as { data: Record<string, unknown> }).data;
}

describe('owner chat raw sources', () => {
  it('returns the owner message in correction provenance, without carrying it into scheduled turns', async () => {
    intake.acceptOwnerMessage(message);
    let index = 0;
    const ids: string[] = [];
    const model = {
      backendType: 'codex',
      reportsModelRuns: false,
      prompt: async (_content: unknown, _callbacks: unknown, options: PromptOptions) => {
        const saved = await options.hostToolBridge!.execute({
          callId: `correction-${index++}`,
          name: 'memory.save',
          input: {
            topic: 'synthetic-correction',
            kind: 'decision',
            summary: 'Keep this correction narrow',
            details: 'Synthetic owner correction',
            source: { package: 'test-product', source_type: 'owner' },
          },
        });
        const body = JSON.parse(saved.content) as { success: boolean; data: { id: string } };
        expect(body.success).toBe(true);
        ids.push(body.data.id);
        return {
          response: 'Recorded',
          session_id: 'session-test',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
      setSessionId: () => {},
      setSystemPrompt: () => {},
      isHealthy: () => true,
      getMetrics: () => ({
        requestCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        lastRequestAt: null,
      }),
      stop: async () => {},
    } as IModelRunner;
    const session = createNativeSession({
      backend: 'codex',
      model: 'fixture-model',
      workspaceDir: join(home, 'workspace'),
      runtimeRoot: home,
      actionSurface: surface,
      agent: model,
      maxTurns: 10,
      timeout: 1_000,
    });
    try {
      const delivery = createStimulusDelivery({
        backend: 'codex',
        timeZone: createTimeZoneSetting('UTC'),
      });
      const context = {
        run: (content: never, request: never) => session.runTurn!(content, request),
        nativeInputId: 'input-test',
        resultForReceipt: () => null,
      };
      await delivery.deliver(mailbox.readInput(message.id, 'owner-test')!, context as never);
      const provenance = await call('memory.read:provenance', { memory_id: ids[0] });
      expect(provenance.events).toEqual([
        expect.objectContaining({ excerpt: message.text, connector: 'chat', sourceId: message.id }),
      ]);
      const row = mailbox.readInput(message.id, 'owner-test')!;
      await delivery.deliver(
        {
          ...row,
          kind: 'scheduled',
          channelKey: 'schedule',
          stimulusId: 'scheduled-test',
          payload: { report: 'full', hourKey: '2026-01-01:08' },
          refs: [],
        },
        context as never
      );
      const scheduled = await call('memory.read:provenance', { memory_id: ids[1] });
      expect(scheduled.events).toEqual([]);
    } finally {
      await session.stop();
    }
  });

  it('indexes only the accepted owner message, without a delta or draining another connector', async () => {
    raw.save('slack', [
      { ...ownerMessageItem(message, 'owner-test'), source: 'slack', sourceId: 'pending-source' },
    ]);
    intake.acceptOwnerMessage(message);
    intake.acceptOwnerMessage(message);
    const search = await call('source.search', { source: 'chat', query: 'synthetic correction' });
    const hits = search.hits as Array<{ observationRef: string }>;
    expect(hits).toHaveLength(1);
    const original = await call('source.read', {
      source: 'chat',
      observationRef: hits[0]!.observationRef,
    });
    expect(original).toMatchObject({
      content: message.text,
      channel: 'telegram:room-test',
      author: 'owner-test',
      sourceId: message.id,
    });
    expect(mailbox.readInput(message.id, 'owner-test')!.refs).toEqual([
      { refId: message.id, observationRef: hits[0]!.observationRef },
    ]);
    expect(
      database.adapter
        .prepare("SELECT COUNT(*) AS count FROM mailbox_inputs WHERE kind = 'source_delta'")
        .get()
    ).toEqual({ count: 0 });
    expect(
      database.adapter
        .prepare(
          "SELECT memory_scope_kind, memory_scope_id FROM connector_event_index WHERE source_connector = 'chat'"
        )
        .get()
    ).toEqual({ memory_scope_kind: 'user', memory_scope_id: 'owner-test' });
    expect(raw.pendingProjectionCount('chat')).toBe(0);
    expect(raw.pendingProjectionCount('slack')).toBe(1);
    expect(LOADABLE_CONNECTORS).not.toContain('chat');
    expect(ownerMemoryScopes('owner-test')).not.toContainEqual({ kind: 'channel', id: 'chat' });
  });

  it('fails intake before accepting a mailbox row when the raw save fails', () => {
    vi.spyOn(raw, 'save').mockImplementation(() => {
      throw new Error('synthetic raw failure');
    });
    expect(() => intake.acceptOwnerMessage(message)).toThrow('synthetic raw failure');
    expect(mailbox.readInput(message.id, 'owner-test')).toBeNull();
  });

  it('stores a delivered reply once and keeps the message ref as metadata without links', async () => {
    intake.acceptOwnerMessage(message);
    const reply = {
      messageRef: message.id,
      text: '<b>Sent reply</b>',
      occurredAt: message.occurredAt + 1,
      author: 'agent' as const,
      deliveryVerified: true,
    };
    intake.recordOwnerReply(reply);
    intake.recordOwnerReply(reply);
    const search = await call('source.search', { source: 'chat', query: 'Sent reply' });
    const hits = search.hits as Array<{ observationRef: string }>;
    expect(hits).toHaveLength(1);
    expect(
      await call('source.read', { source: 'chat', observationRef: hits[0]!.observationRef })
    ).toMatchObject({
      content: reply.text,
      author: 'agent-test',
      sourceId: `${message.id}:reply`,
      metadata: { messageRef: message.id, deliveryVerified: true },
    });
    expect(
      database.adapter
        .prepare("SELECT COUNT(*) AS count FROM twin_edges WHERE edge_type = 'derived_from'")
        .get()
    ).toEqual({ count: 0 });
    expect(
      ownerReplyItem({ ...reply, deliveryVerified: false }, 'owner-test', 'agent-test').metadata
    ).toMatchObject({ deliveryVerified: false });
  });

  it('reads exchanges older than seven days from chat for owner.messages and session start', async () => {
    intake.acceptOwnerMessage(message);
    intake.recordOwnerReply({
      messageRef: message.id,
      text: '<b>Recorded answer</b>',
      occurredAt: message.occurredAt + 1,
      author: 'agent',
      deliveryVerified: true,
    });
    database.adapter.prepare('DELETE FROM mailbox_inputs').run();
    const now = message.occurredAt + 30 * 86_400_000;
    expect(await call('owner.messages', { since: message.occurredAt, before: now })).toMatchObject({
      messages: [{ at: message.occurredAt, owner: message.text, reply: '<b>Recorded answer</b>' }],
    });
    const start = await readSessionStartInput({
      exchanges: chat.recentExchanges('current-message'),
      records: async () => [],
      checkpoint: async () => null,
      now,
    });
    expect(start.exchanges).toEqual([
      { at: message.occurredAt, owner: message.text, answer: '<b>Recorded answer</b>' },
    ]);
  });

  it('excludes chat at replay and recent reads unless its channel is named', async () => {
    intake.acceptOwnerMessage(message);
    const monitored = raw.save('slack', [
      {
        ...ownerMessageItem(message, 'owner-test'),
        source: 'slack',
        sourceId: 'monitored-test',
        channel: 'room-monitored',
        content: 'Monitored update',
      },
    ]);
    createCoreRawIndexSink(database.adapter)('slack', monitored);
    expect(
      readReplaySourceEvents(database.adapter, message.occurredAt, message.occurredAt + 100, {})
    ).toEqual([expect.objectContaining({ connector: 'slack', sourceId: 'monitored-test' })]);
    expect(await call('source.recent', { since: message.occurredAt })).toMatchObject({
      channels: [expect.objectContaining({ source: 'slack', channel: 'room-monitored' })],
    });
    const recent = await call('source.recent', {
      since: message.occurredAt,
      channels: ['chat:telegram:room-test'],
    });
    expect(JSON.stringify(recent)).toContain(message.text);
  });
});
