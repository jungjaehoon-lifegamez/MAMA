import { chatFixture } from './chat-fixture.js';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sockets: [] as unknown[], webClients: [] as unknown[] }));
vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: class MockSocket extends EventEmitter {
    start = vi.fn(async () => undefined);
    disconnect = vi.fn(async () => undefined);
    constructor() {
      super();
      mocks.sockets.push(this);
    }
  },
}));
vi.mock('@slack/web-api', () => ({
  WebClient: class MockWebClient {
    chat = { postMessage: vi.fn(async () => ({ ok: true, ts: '2.0' })) };
    files = { uploadV2: vi.fn(async () => ({ files: [{ id: 'file_test' }] })) };
    constructor() {
      mocks.webClients.push(this);
    }
  },
}));
import { SlackGateway } from '../../src/gateways/slack.js';
import { OwnerMessageLedger } from '../../src/gateways/telegram-message-ledger.js';

type MockWebClient = {
  chat: { postMessage: ReturnType<typeof vi.fn> };
  files: { uploadV2: ReturnType<typeof vi.fn> };
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-owner-'));
  mocks.sockets.length = 0;
  mocks.webClients.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('Slack owner gateway', () => {
  it('acks events, drops non-owners with hashed ids, and accepts duplicate owner messages once', async () => {
    const accepted: unknown[] = [];
    const order: string[] = [];
    const logs: string[] = [];
    const gateway = new SlackGateway({
      token: 'fixture-bot-token',
      appToken: 'fixture-app-token',
      intake: {
        recordOwnerReply: () => {},
        acceptOwnerMessage: (input) => {
          accepted.push(input);
          order.push('accepted');
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
    const socket = mocks.sockets[0] as EventEmitter;
    const ack = vi.fn(async () => {
      order.push('ack');
    });
    socket.emit('message', {
      ack,
      event: { channel: 'channel_test', user: 'user_stranger', ts: '1.0', text: 'private' },
    });
    socket.emit('message', {
      ack,
      event: { channel: 'channel_test', user: 'user_owner', ts: '2.0', text: 'owner input' },
    });
    socket.emit('message', {
      ack,
      event: { channel: 'channel_test', user: 'user_owner', ts: '2.0', text: 'owner input' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ack).toHaveBeenCalledTimes(3);
    expect(accepted).toHaveLength(1);
    expect(order.lastIndexOf('ack')).toBeGreaterThan(order.indexOf('accepted'));
    expect(accepted[0]).toMatchObject({ id: 'slack:channel_test:2.0', channelKey: 'channel_test' });
    expect(logs.join('\n')).toContain('sender_hash=');
    expect(logs.join('\n')).not.toContain('user_stranger');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('download unavailable');
      })
    );
    socket.emit('message', {
      ack,
      event: {
        channel: 'channel_test',
        user: 'user_owner',
        ts: '3.0',
        text: 'file request',
        files: [
          {
            id: 'file_test',
            name: 'result.pdf',
            mimetype: 'application/pdf',
            url_private_download: 'https://files.example.test/result.pdf',
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(accepted[1]).toMatchObject({
      payload: { attachments: [{ name: 'result.pdf', error: 'download unavailable' }] },
    });
    await gateway.stop();
  });

  it('recovers only Slack entries, sends a startup interruption notice, and continues after a failed entry', async () => {
    const ledgerPath = join(root, 'ledger.json');
    const ledger = new OwnerMessageLedger(ledgerPath);
    ledger.claim('slack:channel_test:failed', {
      deliveryTarget: 'slack:channel_test',
      payloadIdentity: 'b'.repeat(64),
    });
    ledger.markReady('slack:channel_test:failed', 'first attempt');
    ledger.claim('slack:channel_test:interrupted', {
      deliveryTarget: 'slack:channel_test',
      payloadIdentity: 'a'.repeat(64),
    });
    ledger.claim('discord:channel_test:foreign', {
      deliveryTarget: 'discord:channel_test',
      payloadIdentity: 'c'.repeat(64),
    });
    ledger.markReady('discord:channel_test:foreign', 'foreign');
    const logs: string[] = [];
    const gateway = new SlackGateway({
      token: 'fixture-bot',
      appToken: 'fixture-app',
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
    const send = (mocks.webClients[0] as MockWebClient).chat.postMessage;
    send.mockRejectedValueOnce(new Error('provider unavailable'));
    await gateway.start();
    await gateway.recoverPendingResponses();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0].text).toContain('interrupted');
    expect(logs.join('\n')).toContain('slack recovery failed key=slack:channel_test:failed');
    expect(new OwnerMessageLedger(ledgerPath).get('discord:channel_test:foreign')?.state).toBe(
      'ready'
    );
    await gateway.stop();
  });

  it('treats a live processing duplicate as in flight even when the mailbox callback says false', async () => {
    const accepted = vi.fn(() => ({ state: 'accepted' }) as never);
    const gateway = new SlackGateway({
      token: 'fixture-bot',
      appToken: 'fixture-app',
      intake: { recordOwnerReply: () => {}, acceptOwnerMessage: accepted, isPending: () => false },
      config: {
        enabled: true,
        ownerChannelId: 'channel_test',
        allowedChannels: ['channel_test'],
        ownerUserIds: ['user_owner'],
      },
      messageLedgerPath: join(root, 'ledger.json'),
    });
    await gateway.start();
    const socket = mocks.sockets[0] as EventEmitter;
    const event = { channel: 'channel_test', user: 'user_owner', ts: '7.0', text: 'one message' };
    socket.emit('message', { event, ack: vi.fn() });
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    socket.emit('app_mention', { event, ack: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(accepted).toHaveBeenCalledOnce();
    expect((mocks.webClients[0] as MockWebClient).chat.postMessage).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it('marks a chunk uncertain before sending and keeps a delivered idempotency key after regenerated text', async () => {
    const ledgerPath = join(root, 'ledger.json');
    const gateway = new SlackGateway({
      token: 'fixture-bot',
      appToken: 'fixture-app',
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
    const send = (mocks.webClients[0] as MockWebClient).chat.postMessage;
    let release!: (value: { ok: boolean; ts: string }) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as never
    );
    const pending = gateway.sendMessage('channel_test', 'report v1', 'report-key');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(new OwnerMessageLedger(ledgerPath).listUndelivered()[0]?.deliveryUncertain).toBe(true);
    release({ ok: true, ts: '3.0' });
    await pending;
    await expect(
      gateway.sendMessage('channel_test', 'report v2', 'report-key')
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
    const gateway = new SlackGateway({
      token: 'fixture-bot',
      appToken: 'fixture-app',
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
    (mocks.sockets[0] as EventEmitter).emit('message', {
      ack: vi.fn(),
      event: {
        channel: 'channel_test',
        user: 'user_owner',
        ts: '42.0',
        text: '',
        files: [
          { id: 'file-a', name: 'same.pdf', url_private_download: 'https://example.test/a' },
          { id: 'file-b', name: 'same.pdf', url_private_download: 'https://example.test/b' },
        ],
      },
    });
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    const paths = accepted[0]!.payload!.attachments!.map((item) => item.path);
    expect(new Set(paths).size).toBe(2);
    await gateway.stop();
  });

  it('uploads a file once for an operation id and returns the durable receipt on repeat', async () => {
    const filesRoot = join(root, 'workspace', 'files');
    mkdirSync(filesRoot, { recursive: true });
    const filePath = join(filesRoot, 'result.pdf');
    writeFileSync(filePath, 'result');
    const gateway = new SlackGateway({
      token: 'fixture-bot',
      appToken: 'fixture-app',
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
    const upload = (mocks.webClients[0] as MockWebClient).files.uploadV2;
    expect(await gateway.sendFile(filePath, undefined, 'operation_test')).toMatchObject({
      messageId: 'file_test',
      size: 6,
    });
    expect(await gateway.sendFile(filePath, undefined, 'operation_test')).toMatchObject({
      idempotent: true,
      size: 6,
    });
    expect(upload).toHaveBeenCalledTimes(1);
    await gateway.stop();
  });

  it('resumes a known-unsent reply after restart and keeps its receipt', async () => {
    const ledgerPath = join(root, 'ledger.json');
    const ledger = new OwnerMessageLedger(ledgerPath);
    ledger.claim('slack:channel_test:message_test', {
      deliveryTarget: 'slack:channel_test',
      payloadIdentity: 'a'.repeat(64),
    });
    ledger.markReady('slack:channel_test:message_test', 'recovered response');
    const gateway = new SlackGateway({
      token: 'fixture-bot',
      appToken: 'fixture-app',
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
    await gateway.recoverPendingResponses();
    expect((mocks.webClients[0] as MockWebClient).chat.postMessage).toHaveBeenCalledTimes(1);
    expect(new OwnerMessageLedger(ledgerPath).get('slack:channel_test:message_test')).toMatchObject(
      {
        state: 'delivered',
        messageIds: ['2.0'],
      }
    );
    await gateway.stop();
  });
});

it('archives only sent replies once and failed intake recovery as host text', async () => {
  const f = await chatFixture(root);
  const gateway = new SlackGateway({
    token: 'fixture-token',
    appToken: 'fixture-app-token',
    intake: f.intake,
    config: { enabled: true, allowedChannels: ['channel_test'], ownerUserIds: ['user_owner'] },
    messageLedgerPath: join(root, 'chat-ledger.json'),
    interruptedNotice: 'Synthetic interruption',
  });
  await gateway.start();
  const send = (mocks.webClients[0] as MockWebClient).chat.postMessage;
  try {
    await (gateway as unknown as { accept(input: unknown): Promise<void> }).accept({
      channel: 'channel_test',
      user: 'user_owner',
      ts: '3.0',
      text: 'owner input',
    });
    expect(f.replies()).toEqual([]);
    await Promise.all([
      gateway.deliverResponse('slack:channel_test:3.0', 'Sent reply'),
      gateway.deliverResponse('slack:channel_test:3.0', 'Sent reply'),
    ]);
    expect(f.replies()).toEqual([{ author: 'agent-test', content: 'Sent reply' }]);
    await (gateway as unknown as { accept(input: unknown): Promise<void> }).accept({
      channel: 'channel_test',
      user: 'user_owner',
      ts: '5.0',
      text: 'owner input',
    });
    f.failProjectionAck();
    await expect(
      gateway.deliverResponse('slack:channel_test:5.0', 'Archive retry')
    ).rejects.toThrow('synthetic projection acknowledgement failure');
    const sentCount = send.mock.calls.length;
    await gateway.recoverPendingResponses();
    expect(send.mock.calls.length).toBe(sentCount);
    expect(
      f.replies().filter((reply) => (reply as { content: string }).content === 'Archive retry')
    ).toHaveLength(1);
    f.failSave();
    await expect(
      (gateway as unknown as { accept(input: unknown): Promise<void> }).accept({
        channel: 'channel_test',
        user: 'user_owner',
        ts: '4.0',
        text: 'owner input',
      })
    ).rejects.toThrow('synthetic raw failure');
    expect(f.mailbox.readInput('slack:channel_test:4.0', 'owner-test')).toBeNull();
    await gateway.recoverPendingResponses();
    expect(f.replies()).toContainEqual({ author: 'host', content: 'Synthetic interruption' });
    expect(send).toHaveBeenCalled();
  } finally {
    await gateway.stop();
    await f.close();
  }
});
