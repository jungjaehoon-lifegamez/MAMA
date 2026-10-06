import { chatFixture } from './chat-fixture.js';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Events } from 'discord.js';

const mocks = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock('discord.js', async (load) => {
  const actual = await load<typeof import('discord.js')>();
  return {
    ...actual,
    Client: class MockClient extends EventEmitter {
      channels = { fetch: vi.fn() };
      login = vi.fn(async () => undefined);
      destroy = vi.fn();
      constructor() {
        super();
        mocks.clients.push(this);
      }
    },
  };
});
import { DiscordGateway } from '../../src/gateways/discord.js';
import { OwnerMessageLedger } from '../../src/gateways/telegram-message-ledger.js';

type MockClient = EventEmitter & {
  channels: { fetch: ReturnType<typeof vi.fn> };
  login: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
interface TestAttachment {
  id: string;
  name: string;
  url: string;
  contentType: string;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'discord-owner-'));
  mocks.clients.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function ownerMessage(
  id: string,
  user: string,
  channel = 'channel_test',
  attachments: TestAttachment[] = []
) {
  return {
    id,
    channelId: channel,
    createdTimestamp: 1_700_000_000_000,
    content: 'owner input',
    author: { id: user, bot: false },
    attachments: { size: attachments.length, values: () => attachments },
  };
}

describe('Discord owner gateway', () => {
  it('drops non-owners with hashed ids and accepts a duplicate owner event once', async () => {
    const accepted: unknown[] = [];
    const logs: string[] = [];
    const gateway = new DiscordGateway({
      token: 'fixture-token',
      intake: {
        recordOwnerReply: () => {},
        acceptOwnerMessage: (input) => {
          accepted.push(input);
          return { state: 'accepted' } as never;
        },
        isPending: () => true,
      },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: join(root, 'owner-ledger.json'),
      downloadsDir: join(root, 'downloads'),
      log: (line) => logs.push(line),
    });
    await gateway.start();
    const client = mocks.clients[0] as MockClient;
    client.emit(Events.MessageCreate, ownerMessage('id_rejected', 'user_stranger'));
    client.emit(Events.MessageCreate, ownerMessage('id_accepted', 'user_owner'));
    client.emit(Events.MessageCreate, ownerMessage('id_accepted', 'user_owner'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      id: 'discord:channel_test:id_accepted',
      channelKey: 'channel_test',
    });
    expect(logs.join('\n')).toContain('channel_hash=');
    expect(logs.join('\n')).not.toContain('channel_test');
    expect(logs.join('\n')).not.toContain('user_stranger');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('download unavailable');
      })
    );
    const failedFile = ownerMessage('id_file', 'user_owner', 'channel_test', [
      {
        id: 'file_test',
        name: 'result.pdf',
        url: 'https://files.example.test/result.pdf',
        contentType: 'application/pdf',
      },
    ]);
    client.emit(Events.MessageCreate, failedFile);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(accepted[1]).toMatchObject({
      payload: { attachments: [{ name: 'result.pdf', error: 'download unavailable' }] },
    });
    await gateway.stop();
  });

  it('uploads a file once for an operation id and returns the durable receipt on repeat', async () => {
    const filesRoot = join(root, 'workspace', 'files');
    mkdirSync(filesRoot, { recursive: true });
    const filePath = join(filesRoot, 'result.pdf');
    writeFileSync(filePath, 'result');
    const gateway = new DiscordGateway({
      token: 'fixture-token',
      intake: {
        recordOwnerReply: () => {},
        acceptOwnerMessage: () => ({ state: 'accepted' }) as never,
      },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: join(root, 'ledger.json'),
      filesRoot,
    });
    await gateway.start();
    const send = vi.fn(async () => ({ id: 'message_test' }));
    (mocks.clients[0] as MockClient).channels.fetch.mockResolvedValue({
      isSendable: () => true,
      isTextBased: () => true,
      send,
    });
    expect(await gateway.sendFile(filePath, undefined, 'operation_test')).toMatchObject({
      messageId: 'message_test',
      size: 6,
    });
    expect(await gateway.sendFile(filePath, undefined, 'operation_test')).toMatchObject({
      idempotent: true,
      size: 6,
    });
    expect(send).toHaveBeenCalledTimes(1);
    await gateway.stop();
  });

  it('resumes a known-unsent reply after restart and keeps its receipt', async () => {
    const ledgerPath = join(root, 'ledger.json');
    const ledger = new OwnerMessageLedger(ledgerPath);
    ledger.claim('discord:channel_test:message_test', {
      deliveryTarget: 'discord:channel_test',
      payloadIdentity: 'a'.repeat(64),
    });
    ledger.markReady('discord:channel_test:message_test', 'recovered response');
    const gateway = new DiscordGateway({
      token: 'fixture-token',
      intake: {
        recordOwnerReply: () => {},
        acceptOwnerMessage: () => ({ state: 'accepted' }) as never,
      },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: ledgerPath,
    });
    const send = vi.fn(async () => ({ id: 'message_reply' }));
    (mocks.clients[0] as MockClient).channels.fetch.mockResolvedValue({
      isSendable: () => true,
      isTextBased: () => true,
      send,
    });
    await gateway.start();
    await gateway.recoverPendingResponses();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      new OwnerMessageLedger(ledgerPath).get('discord:channel_test:message_test')
    ).toMatchObject({
      state: 'delivered',
      messageIds: ['message_reply'],
    });
    await gateway.stop();
  });

  it('recovers an interrupted owner turn and logs client errors', async () => {
    const ledgerPath = join(root, 'ledger.json');
    const ledger = new OwnerMessageLedger(ledgerPath);
    ledger.claim('discord:channel_test:interrupted', {
      deliveryTarget: 'discord:channel_test',
      payloadIdentity: 'a'.repeat(64),
    });
    ledger.claim('slack:channel_test:foreign', {
      deliveryTarget: 'slack:channel_test',
      payloadIdentity: 'b'.repeat(64),
    });
    ledger.markReady('slack:channel_test:foreign', 'foreign');
    const logs: string[] = [];
    const gateway = new DiscordGateway({
      token: 'fixture-token',
      intake: {
        recordOwnerReply: () => {},
        acceptOwnerMessage: () => ({ state: 'accepted' }) as never,
        isPending: () => false,
      },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: ledgerPath,
      log: (line) => logs.push(line),
    });
    const client = mocks.clients[0] as MockClient;
    client.channels.fetch.mockResolvedValue({
      isSendable: () => true,
      send: vi.fn(async () => ({ id: 'message_sent' })),
    });
    await gateway.start();
    client.emit('error', new Error('provider event error'));
    expect(logs.join('\n')).toContain('discord client error=provider event error');
    expect(client.channels.fetch).toHaveBeenCalledOnce();
    expect(new OwnerMessageLedger(ledgerPath).get('discord:channel_test:interrupted')?.state).toBe(
      'delivered'
    );
    expect(new OwnerMessageLedger(ledgerPath).get('slack:channel_test:foreign')?.state).toBe(
      'ready'
    );
    await gateway.stop();
  });

  it('marks a chunk uncertain while the provider request is in flight', async () => {
    const ledgerPath = join(root, 'ledger.json');
    const gateway = new DiscordGateway({
      token: 'fixture-token',
      intake: {
        recordOwnerReply: () => {},
        acceptOwnerMessage: () => ({ state: 'accepted' }) as never,
      },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: ledgerPath,
    });
    await gateway.start();
    let release!: (value: { id: string }) => void;
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    (mocks.clients[0] as MockClient).channels.fetch.mockResolvedValue({
      isSendable: () => true,
      send,
    });
    const pending = gateway.sendMessage('channel_test', 'outbound text', 'stable-key');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(new OwnerMessageLedger(ledgerPath).listUndelivered()[0]?.deliveryUncertain).toBe(true);
    release({ id: 'message_sent' });
    await pending;
    await expect(
      gateway.sendMessage('channel_test', 'regenerated text', 'stable-key')
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    await gateway.stop();
  });

  it('keeps same-named attachments from overwriting each other', async () => {
    const accepted: Array<{ payload?: { attachments?: Array<{ path?: string }> } }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('file'))
    );
    const gateway = new DiscordGateway({
      token: 'fixture-token',
      intake: {
        recordOwnerReply: () => {},
        acceptOwnerMessage: (input) => {
          accepted.push(input as never);
          return { state: 'accepted' } as never;
        },
      },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: join(root, 'ledger.json'),
      downloadsDir: join(root, 'downloads'),
    });
    await gateway.start();
    (mocks.clients[0] as MockClient).emit(
      Events.MessageCreate,
      ownerMessage('message-files', 'user_owner', 'channel_test', [
        {
          id: 'file-a',
          name: 'same.pdf',
          url: 'https://example.test/a',
          contentType: 'application/pdf',
        },
        {
          id: 'file-b',
          name: 'same.pdf',
          url: 'https://example.test/b',
          contentType: 'application/pdf',
        },
      ])
    );
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    const paths = accepted[0]!.payload!.attachments!.map((item) => item.path);
    expect(new Set(paths).size).toBe(2);
    await gateway.stop();
  });

  it('does not send an interrupted notice for a live duplicate owner event', async () => {
    const accepted = vi.fn(() => ({ state: 'accepted' }) as never);
    const gateway = new DiscordGateway({
      token: 'fixture-token',
      intake: { recordOwnerReply: () => {}, acceptOwnerMessage: accepted, isPending: () => false },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: join(root, 'ledger.json'),
    });
    const client = mocks.clients[0] as MockClient;
    const send = vi.fn(async () => ({ id: 'reply' }));
    client.channels.fetch.mockResolvedValue({ isSendable: () => true, send });
    await gateway.start();
    client.emit(Events.MessageCreate, ownerMessage('duplicate', 'user_owner'));
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    client.emit(Events.MessageCreate, ownerMessage('duplicate', 'user_owner'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(accepted).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    await gateway.stop();
  });
});

it('archives only sent replies once and interrupted recovery as host text', async () => {
  const f = await chatFixture(root);
  const gateway = new DiscordGateway({
    token: 'fixture-token',
    intake: f.intake,
    config: { enabled: true, allowedChannels: ['channel_test'], ownerUserIds: ['user_owner'] },
    messageLedgerPath: join(root, 'chat-ledger.json'),
    interruptedNotice: 'Synthetic interruption',
  });
  await gateway.start();
  const send = vi.fn(async () => ({ id: 'sent-test' }));
  (mocks.clients[0] as MockClient).channels.fetch.mockResolvedValue({
    isSendable: () => true,
    send,
  });
  try {
    await (gateway as unknown as { accept(input: unknown): Promise<void> }).accept(
      ownerMessage('reply-test', 'user_owner')
    );
    expect(f.replies()).toEqual([]);
    await Promise.all([
      gateway.deliverResponse('discord:channel_test:reply-test', 'Sent reply'),
      gateway.deliverResponse('discord:channel_test:reply-test', 'Sent reply'),
    ]);
    expect(f.replies()).toEqual([{ author: 'agent-test', content: 'Sent reply' }]);
    await (gateway as unknown as { accept(input: unknown): Promise<void> }).accept(
      ownerMessage('retry-test', 'user_owner')
    );
    f.failProjectionAck();
    await expect(
      gateway.deliverResponse('discord:channel_test:retry-test', 'Archive retry')
    ).rejects.toThrow('synthetic projection acknowledgement failure');
    const sentCount = send.mock.calls.length;
    await gateway.recoverPendingResponses();
    expect(send.mock.calls.length).toBe(sentCount);
    expect(
      f.replies().filter((reply) => (reply as { content: string }).content === 'Archive retry')
    ).toHaveLength(1);
    f.failSave();
    await expect(
      (gateway as unknown as { accept(input: unknown): Promise<void> }).accept(
        ownerMessage('failed-test', 'user_owner')
      )
    ).rejects.toThrow('synthetic raw failure');
    expect(f.mailbox.readInput('discord:channel_test:failed-test', 'owner-test')).toBeNull();
    await gateway.recoverPendingResponses();
    expect(f.replies()).not.toContainEqual({ author: 'host', content: 'Synthetic interruption' });
    await (gateway as unknown as { accept(input: unknown): Promise<void> }).accept(
      ownerMessage('interrupted-test', 'user_owner')
    );
    f.mailbox.ack(f.mailbox.readInput('discord:channel_test:interrupted-test', 'owner-test')!.id);
    await gateway.recoverPendingResponses();
    expect(f.replies()).toContainEqual({ author: 'host', content: 'Synthetic interruption' });
    expect(send).toHaveBeenCalled();
  } finally {
    await gateway.stop();
    await f.close();
  }
});

it('archives a reply longer than the transport limit byte-for-byte from the ledger', async () => {
  const f = await chatFixture(root);
  const gateway = new DiscordGateway({
    token: 'fixture-token',
    intake: f.intake,
    config: { enabled: true, allowedChannels: ['channel_test'], ownerUserIds: ['user_owner'] },
    messageLedgerPath: join(root, 'long-ledger.json'),
  });
  const send = vi.fn(async () => ({ id: 'sent-test' }));
  (mocks.clients[0] as MockClient).channels.fetch.mockResolvedValue({
    isSendable: () => true,
    send,
  });
  await gateway.start();
  try {
    await (gateway as unknown as { accept(input: unknown): Promise<void> }).accept(
      ownerMessage('long-test', 'user_owner')
    );
    const response = 'x'.repeat(2100) + '  \nexact ending';
    await gateway.deliverResponse('discord:channel_test:long-test', response);
    expect(send.mock.calls.length).toBeGreaterThan(1);
    const archived = f.replies() as Array<{ author: string; content: string }>;
    expect(archived).toHaveLength(1);
    expect(archived[0]!.author).toBe('agent-test');
    expect(Buffer.from(archived[0]!.content).equals(Buffer.from(response))).toBe(true);
  } finally {
    await gateway.stop();
    await f.close();
  }
});

it('delivers an authorless legacy ready entry once without archiving it', async () => {
  const path = join(root, 'legacy-ledger.json');
  const key = 'discord:channel_test:legacy-test';
  const ledger = new OwnerMessageLedger(path);
  ledger.claim(key, { deliveryTarget: 'discord:channel_test', payloadIdentity: 'a'.repeat(64) });
  ledger.markReady(key, 'Legacy answer');
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  delete stored.entries[0].responseAuthor;
  writeFileSync(path, JSON.stringify(stored));
  const recordOwnerReply = vi.fn();
  const logs: string[] = [];
  const gateway = new DiscordGateway({
    token: 'fixture-token',
    intake: { recordOwnerReply, acceptOwnerMessage: () => ({ state: 'accepted' }) as never },
    config: { enabled: true, allowedChannels: ['channel_test'], ownerUserIds: ['user_owner'] },
    messageLedgerPath: path,
    log: (line) => logs.push(line),
  });
  const send = vi.fn(async () => ({ id: 'sent-test' }));
  (mocks.clients[0] as MockClient).channels.fetch.mockResolvedValue({
    isSendable: () => true,
    send,
  });
  await gateway.start();
  try {
    await gateway.recoverPendingResponses();
    expect(send).toHaveBeenCalledOnce();
    expect(new OwnerMessageLedger(path).get(key)?.state).toBe('delivered');
    expect(recordOwnerReply).not.toHaveBeenCalled();
    expect(logs).toEqual([
      expect.stringContaining(`reply archive skipped key=${key} reason=missing_response_author`),
    ]);
  } finally {
    await gateway.stop();
  }
});
