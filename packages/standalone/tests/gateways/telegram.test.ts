import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const seams = vi.hoisted(() => ({
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 101 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 102 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 103 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  },
  start: vi.fn().mockImplementation(() => new Promise(() => {})),
  handlers: new Map<string, (ctx: unknown) => Promise<void>>(),
}));

vi.mock('grammy', async (importOriginal) => ({
  InputFile: (await importOriginal<typeof import('grammy')>()).InputFile,
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void>) => {
      seams.handlers.set(event, handler);
    }),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    start: seams.start,
    stop: vi.fn().mockResolvedValue(undefined),
    botInfo: { id: 101, username: 'fixture_bot' },
    api: seams.api,
  })),
}));

import { TelegramGateway } from '../../src/gateways/telegram.js';
import type { OwnerMessageInput, TurnIntake } from '../../src/gateways/turn-contract.js';
import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';
import { createReportScheduler } from '../../src/runtime/report-scheduler.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  seams.handlers.clear();
  seams.start.mockReset().mockImplementation(() => new Promise(() => {}));
  seams.api.sendMessage.mockClear();
  seams.api.sendPhoto.mockClear();
  seams.api.sendDocument.mockClear();
  seams.api.editMessageText.mockClear();
  seams.api.deleteMessage.mockClear();
  if (vi.isMockFunction(console.log)) console.log.mockRestore();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 11,
    date: 1_700_000_000,
    chat: { id: 7, type: 'private' },
    from: { id: 9, is_bot: false },
    text: 'owner text',
    ...overrides,
  };
}

function intakeFor(received: OwnerMessageInput[]): TurnIntake {
  return {
    acceptOwnerMessage: vi.fn((input: OwnerMessageInput) => {
      received.push(input);
      return { inputId: 'accepted-1', state: 'accepted' };
    }),
  };
}

async function gatewayFor(
  intake: TurnIntake,
  ledgerPath?: string,
  filesRoot?: string,
  interruptedNotice?: string
): Promise<TelegramGateway> {
  const root = mkdtempSync(join(tmpdir(), 'mama-telegram-fixture-'));
  temporaryRoots.push(root);
  vi.stubEnv('HOME', root);
  const gateway = new TelegramGateway({
    token: 'fixture-token',
    intake,
    messageLedgerPath: ledgerPath ?? join(root, 'telegram-ledger.json'),
    config: {
      allowedChats: ['7'],
      ownerUserIds: ['9'],
      ownerChatId: '7',
      polling: false,
    },
    ...(filesRoot === undefined ? {} : { filesRoot }),
    ...(interruptedNotice === undefined ? {} : { interruptedNotice }),
  });
  await gateway.start();
  return gateway;
}

describe('TelegramGateway', () => {
  it.each([400, 403, 429, 503, undefined])(
    'recovers the next entry and starts polling after a send error (%s)',
    async (code) => {
      const root = mkdtempSync(join(tmpdir(), 'telegram-recovery-error-'));
      temporaryRoots.push(root);
      const path = join(root, 'ledger.json');
      const ledger = new TelegramMessageLedger(path);
      for (const key of ['outbound:failed', 'outbound:next']) {
        ledger.claim(key, { deliveryTarget: 'telegram:7', payloadIdentity: 'a'.repeat(64) });
        ledger.markReady(key, key);
      }
      const log = vi.fn();
      seams.api.sendMessage.mockImplementationOnce(async () => {
        throw Object.assign(new Error('fixture send error'), { error_code: code });
      });
      const gateway = new TelegramGateway({
        token: 'fixture-token',
        intake: intakeFor([]),
        messageLedgerPath: path,
        config: { allowedChats: ['7'] },
        log,
      });
      try {
        await expect(gateway.start()).resolves.toBeUndefined();
        expect(seams.start).toHaveBeenCalledOnce();
        const entries = new TelegramMessageLedger(path);
        // A definitive refusal stays ready at its chunk; anything else may have reached Telegram.
        expect(entries.get('outbound:failed')).toMatchObject({
          state: 'ready',
          nextChunkIndex: 0,
          deliveryUncertain: !(code !== undefined && code < 500),
        });
        expect(entries.get('outbound:next')?.state).toBe('delivered');
        expect(log.mock.calls.flat().join('\n')).toMatch(
          /recovery failed key=outbound:failed.*fixture send error/
        );
      } finally {
        await gateway.stop();
      }
    }
  );

  it('skips a regenerated report after its first delivery even when schedule persistence failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-report-regenerated-'));
    temporaryRoots.push(root);
    const gateway = await gatewayFor(intakeFor([]), join(root, 'ledger.json'));
    const statePath = join(root, 'schedule.json');
    const scheduler = createReportScheduler({
      config: { full_report_hours: [13], reminder_start_hour: 9, reminder_end_hour: 21 },
      statePath,
      intake: { acceptScheduled: () => ({ state: 'accepted', inputId: 'fixture' }) },
      hasPendingReport: () => false,
      sendToOwner: (text, key) => gateway.sendToOwner(text, key),
      onError: () => {},
    });
    const row = {
      stimulusId: 'report-attempt',
      payload: { report: 'full', hourKey: '2026-01-01:13' },
    };
    mkdirSync(`${statePath}.tmp`);
    try {
      await expect(scheduler.onResult(row, { response: 'first report' })).rejects.toThrow();
      rmSync(`${statePath}.tmp`, { recursive: true });
      await expect(
        scheduler.onResult(row, { response: 'regenerated report' })
      ).resolves.toBeUndefined();
      expect(seams.api.sendMessage).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).lastFullKey).toBe('2026-01-01:13');
    } finally {
      await gateway.stop();
    }
  });

  it.each(['chunkFormat', 'nextChunkIndex'])(
    'logs an incomplete outbound recovery entry lacking %s without aborting startup',
    async (field) => {
      const root = mkdtempSync(join(tmpdir(), 'outbound-incomplete-'));
      temporaryRoots.push(root);
      const ledgerPath = join(root, 'ledger.json');
      const gateway = await gatewayFor(intakeFor([]), ledgerPath);
      seams.api.sendMessage.mockRejectedValueOnce(
        Object.assign(new Error('rejected'), { error_code: 429 })
      );
      await expect(gateway.sendToOwner('stored response', 'incomplete')).rejects.toThrow(
        'rejected'
      );
      await gateway.stop();
      const stored = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      delete stored.entries[0][field];
      writeFileSync(ledgerPath, JSON.stringify(stored));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const restarted = await gatewayFor(intakeFor([]), ledgerPath);
      expect(log.mock.calls.flat().join('\n')).toMatch(
        /recovery failed key=.*incomplete delivery metadata/
      );
      expect(new TelegramMessageLedger(ledgerPath).get(stored.entries[0].key)?.state).toBe('ready');
      expect(seams.api.sendMessage).toHaveBeenCalledOnce();
      await restarted.stop();
    }
  );

  it('persists outbound keys and every chunk receipt, logs once, and suppresses sends after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'outbound-receipts-'));
    temporaryRoots.push(root);
    const ledgerPath = join(root, 'ledger.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gateway = await gatewayFor(intakeFor([]), ledgerPath);
    seams.api.sendMessage
      .mockResolvedValueOnce({ message_id: 201 })
      .mockResolvedValueOnce({ message_id: 202 });
    const body = 'private-body '.repeat(400);
    await gateway.sendToOwner(body, 'source_delta:fixture');
    const saved = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(saved.version).toBe(3);
    expect(saved.entries).toEqual([
      expect.objectContaining({
        key: expect.stringMatching(/^outbound:[a-f0-9]{64}$/),
        state: 'delivered',
        idempotencyKey: 'source_delta:fixture',
        messageIds: [201, 202],
      }),
    ]);
    const reopened = new TelegramMessageLedger(ledgerPath);
    expect(reopened.get(saved.entries[0].key)).toMatchObject({ messageIds: [201, 202] });
    await gateway.stop();
    const restarted = await gatewayFor(intakeFor([]), ledgerPath);
    await restarted.sendToOwner(body, 'source_delta:fixture');
    expect(seams.api.sendMessage).toHaveBeenCalledTimes(2);
    const lines = log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('telegram outbound delivered'));
    expect(lines).toEqual([
      'telegram outbound delivered idempotency_key="source_delta:fixture" message_ids=[201,202]',
    ]);
    expect(lines.join('')).not.toContain('private-body');
    await restarted.stop();
  });

  it('keeps confirmed chunk ids when a later send fails and the gateway reopens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'outbound-partial-'));
    temporaryRoots.push(root);
    const ledgerPath = join(root, 'ledger.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gateway = await gatewayFor(intakeFor([]), ledgerPath);
    seams.api.sendMessage
      .mockResolvedValueOnce({ message_id: 301 })
      .mockRejectedValueOnce(new Error('send failed'));
    await expect(gateway.sendToOwner('x'.repeat(5000), 'scheduled:fixture')).rejects.toThrow(
      'send failed'
    );
    const entry = JSON.parse(readFileSync(ledgerPath, 'utf8')).entries[0];
    expect(new TelegramMessageLedger(ledgerPath).get(entry.key)).toMatchObject({
      state: 'ready',
      idempotencyKey: 'scheduled:fixture',
      messageIds: [301],
      nextChunkIndex: 1,
      deliveryUncertain: true,
    });
    expect(
      log.mock.calls.filter(([line]) => String(line).startsWith('telegram outbound delivered'))
    ).toEqual([]);
    await gateway.stop();
    const restarted = await gatewayFor(intakeFor([]), ledgerPath);
    expect(seams.api.sendMessage).toHaveBeenCalledTimes(2);
    await expect(restarted.sendToOwner('x'.repeat(5000), 'scheduled:fixture')).rejects.toThrow(
      /uncertain/
    );
    expect(seams.api.sendMessage).toHaveBeenCalledTimes(2);
    await restarted.stop();
  });

  it('recovers ready outbound chunks after a definitive Telegram API rejection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'outbound-rejected-'));
    temporaryRoots.push(root);
    const ledgerPath = join(root, 'ledger.json');
    const gateway = await gatewayFor(intakeFor([]), ledgerPath);
    seams.api.sendMessage
      .mockResolvedValueOnce({ message_id: 301 })
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { error_code: 429 }));
    await expect(gateway.sendToOwner('x'.repeat(5000), 'scheduled:rejected')).rejects.toThrow(
      'rate limited'
    );
    const entry = JSON.parse(readFileSync(ledgerPath, 'utf8')).entries[0];
    expect(entry).toMatchObject({ state: 'ready', nextChunkIndex: 1, deliveryUncertain: false });
    await gateway.stop();
    const restarted = await gatewayFor(intakeFor([]), ledgerPath);
    expect(seams.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(seams.api.sendMessage.mock.calls[2]?.[1]).toBe('x'.repeat(904));
    expect(new TelegramMessageLedger(ledgerPath).get(entry.key)).toMatchObject({
      state: 'delivered',
      messageIds: [301, 101],
    });
    await restarted.stop();
  });

  it('does not resend an outbound entry when concurrent recovery scans see it ready', async () => {
    const gateway = await gatewayFor(intakeFor([]));
    seams.api.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error('send failed'), { error_code: 429 })
    );
    await expect(gateway.sendToOwner('recover once', 'concurrent-recovery')).rejects.toThrow(
      'send failed'
    );
    let completeSend!: () => void;
    const sent = new Promise<void>((resolve) => {
      completeSend = resolve;
    });
    seams.api.sendMessage.mockImplementationOnce(async () => {
      await sent;
      return { message_id: 301 };
    });
    const first = gateway.recoverPendingResponses();
    const second = gateway.recoverPendingResponses();
    completeSend();
    await Promise.all([first, second]);
    expect(seams.api.sendMessage).toHaveBeenCalledTimes(2);
    await gateway.stop();
  });

  it('reports fatal polling rejection to the process owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-poll-fatal-'));
    temporaryRoots.push(root);
    const fatal = vi.fn();
    const error = new Error('polling token rejected');
    seams.start.mockRejectedValueOnce(error);
    const gateway = new TelegramGateway({
      token: 'fixture-token',
      intake: intakeFor([]),
      messageLedgerPath: join(root, 'ledger.json'),
      config: { allowedChats: ['7'] },
      onFatalError: fatal,
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await gateway.start();
      await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith(error));
      expect(gateway.getLastError()).toBe('polling token rejected');
    } finally {
      logged.mockRestore();
      await gateway.stop();
    }
  });

  it('resumes at the confirmed chunk after presenter finalization fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-finalize-failed-'));
    temporaryRoots.push(root);
    const ledgerPath = join(root, 'ledger.json');
    const gateway = await gatewayFor(intakeFor([]), ledgerPath);
    await seams.handlers.get('message')!({ message: message() });
    seams.api.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error('final chunk failed'), { error_code: 400 })
    );
    await expect(gateway.deliverResponse('telegram:7:11', 'x'.repeat(5000))).rejects.toThrow(
      'final chunk failed'
    );
    expect(new TelegramMessageLedger(ledgerPath).get('telegram:7:11')).toMatchObject({
      state: 'ready',
      nextChunkIndex: 1,
    });
    await gateway.deliverResponse('telegram:7:11', 'x'.repeat(5000));
    expect(seams.api.sendMessage.mock.calls.map(([, body]) => body)).toEqual([
      '⏳',
      'x'.repeat(904),
      'x'.repeat(904),
    ]);
    expect(new TelegramMessageLedger(ledgerPath).get('telegram:7:11')?.state).toBe('delivered');
    await gateway.stop();
  });

  it('retains uncertain response progress and refuses to resend it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-response-uncertain-'));
    temporaryRoots.push(root);
    const ledgerPath = join(root, 'ledger.json');
    const gateway = await gatewayFor(intakeFor([]), ledgerPath);
    await seams.handlers.get('message')!({ message: message() });
    seams.api.sendMessage.mockRejectedValueOnce(new Error('response disconnected'));
    await expect(gateway.deliverResponse('telegram:7:11', 'x'.repeat(5000))).rejects.toThrow(
      'response disconnected'
    );
    await expect(gateway.deliverResponse('telegram:7:11', 'x'.repeat(5000))).rejects.toThrow(
      /uncertain/
    );
    await gateway.recoverPendingResponses();
    expect(seams.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(new TelegramMessageLedger(ledgerPath).get('telegram:7:11')).toMatchObject({
      state: 'ready',
      nextChunkIndex: 1,
      deliveryUncertain: true,
    });
    await gateway.stop();
  });

  it('uploads an image above the photo limit as a document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-large-photo-'));
    temporaryRoots.push(root);
    const filesRoot = join(root, 'files');
    mkdirSync(filesRoot);
    const path = join(filesRoot, 'large.png');
    writeFileSync(path, '');
    truncateSync(path, 10 * 1024 * 1024 + 1);
    const gateway = await gatewayFor(intakeFor([]), join(root, 'ledger.json'), filesRoot);
    const result = await gateway.sendFile(path, undefined, 'large-photo');
    expect(result).toMatchObject({ sentAs: 'document', messageId: 103 });
    expect(seams.api.sendPhoto).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it('persists a failed file claim instead of leaving it processing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-file-failed-'));
    temporaryRoots.push(root);
    const filesRoot = join(root, 'files');
    mkdirSync(filesRoot);
    const path = join(filesRoot, 'result.txt');
    writeFileSync(path, 'result');
    const ledgerPath = join(root, 'ledger.json');
    const gateway = await gatewayFor(intakeFor([]), ledgerPath, filesRoot);
    seams.api.sendDocument.mockRejectedValueOnce(new Error('upload disconnected'));
    await expect(gateway.sendFile(path, undefined, 'failed-file')).rejects.toThrow(
      'upload disconnected'
    );
    expect(new TelegramMessageLedger(ledgerPath).get('file:failed-file')).toMatchObject({
      state: 'failed',
      deliveryUncertain: true,
    });
    await expect(gateway.sendFile(path, undefined, 'failed-file')).rejects.toThrow(/uncertain/);
    expect(seams.api.sendDocument).toHaveBeenCalledTimes(1);
    await gateway.stop();
  });

  it('rejects messages outside the configured owner allowlist', async () => {
    const received: OwnerMessageInput[] = [];
    const gateway = await gatewayFor(intakeFor(received));
    const handler = seams.handlers.get('message');
    expect(handler).toBeTypeOf('function');

    await handler!({ message: message({ chat: { id: 8, type: 'private' } }) });
    await handler!({ message: message({ from: { id: 10, is_bot: false } }) });

    expect(received).toEqual([]);
    expect(seams.api.sendMessage).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it.each([false, true])(
    'logs one hashed audit event for a dropped message without its content or identifiers (bot=%s)',
    async (isBot) => {
      const received: OwnerMessageInput[] = [];
      const gateway = await gatewayFor(intakeFor(received));
      const audit = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await seams.handlers.get('message')!({
          message: message({
            chat: { id: 876543210, type: 'private' },
            from: { id: 987654321, is_bot: isBot, first_name: 'private-sender-label' },
            text: 'private-message-body',
          }),
        });
        expect(received).toEqual([]);
        expect(audit).toHaveBeenCalledTimes(1);
        const line = String(audit.mock.calls[0]?.[0]);
        expect(line).toMatch(
          /^telegram message dropped reason=non_owner chat_hash=[a-f0-9]{64} sender_hash=[a-f0-9]{64}$/
        );
        for (const privateValue of [
          '876543210',
          '987654321',
          'private-sender-label',
          'private-message-body',
        ]) {
          expect(line).not.toContain(privateValue);
        }
      } finally {
        audit.mockRestore();
        await gateway.stop();
      }
    }
  );

  it('submits owner text to the runtime with the Telegram source reference', async () => {
    const received: OwnerMessageInput[] = [];
    const gateway = await gatewayFor(intakeFor(received));
    const handler = seams.handlers.get('message');

    await handler!({ message: message() });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: 'telegram:7:11',
      channelKey: '7',
      text: 'owner text',
    });
    expect(seams.api.sendMessage).toHaveBeenCalledWith(7, '⏳');
    await gateway.stop();
  });

  it('does not submit a Telegram retry after the completed response is delivered', async () => {
    const received: OwnerMessageInput[] = [];
    const gateway = await gatewayFor(intakeFor(received));
    const handler = seams.handlers.get('message');
    const sourceMessageRef = 'telegram:7:11';

    await handler!({ message: message() });
    await gateway.deliverResponse(sourceMessageRef, 'completed answer');
    await gateway.deliverResponse(sourceMessageRef, 'completed answer');
    await handler!({ message: message() });

    expect(received).toHaveLength(1);
    expect(seams.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(seams.api.editMessageText).toHaveBeenCalledTimes(1);
    await gateway.stop();
  });

  it("tells the owner about an interrupted turn in the configured words, in the request's reply slot", async () => {
    const received: OwnerMessageInput[] = [];
    const gateway = await gatewayFor(intakeFor(received), undefined, undefined, 'Cut off; resend.');
    const handler = seams.handlers.get('message');
    await handler!({ message: message() });

    // The runtime no longer holds the message (no isPending): recovery sends the notice.
    await gateway.recoverPendingResponses();

    expect(seams.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(seams.api.editMessageText).toHaveBeenCalledWith(
      7,
      expect.any(Number),
      'Cut off; resend.'
    );
    await gateway.stop();
  });

  it('recovers a ready response from the durable ledger without resubmitting the message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-telegram-recovery-'));
    temporaryRoots.push(root);
    const ledgerPath = join(root, 'telegram-ledger.json');
    const sourceMessageRef = 'telegram:7:11';
    const ledger = new TelegramMessageLedger(ledgerPath);
    ledger.claim(sourceMessageRef);
    ledger.markReady(sourceMessageRef, 'recovered answer', 'html-v1');
    const received: OwnerMessageInput[] = [];

    const gateway = await gatewayFor(intakeFor(received), ledgerPath);

    expect(received).toEqual([]);
    expect(seams.api.sendMessage).toHaveBeenCalledWith(7, 'recovered answer');
    expect(new TelegramMessageLedger(ledgerPath).get(sourceMessageRef)?.state).toBe('delivered');
    await gateway.stop();
  });

  it('sends an image to the configured owner chat and deduplicates an operation id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-telegram-file-'));
    temporaryRoots.push(root);
    const filesRoot = join(root, 'files');
    mkdirSync(filesRoot, { recursive: true });
    const imagePath = join(filesRoot, 'result-test.png');
    writeFileSync(imagePath, 'image-bytes');
    const ledgerPath = join(root, 'telegram-ledger.json');
    const gateway = await gatewayFor(intakeFor([]), ledgerPath, filesRoot);

    const first = await gateway.sendFile(imagePath, 'caption-test', 'file-operation');
    const second = await gateway.sendFile(imagePath, 'caption-test', 'file-operation');

    expect(first).toMatchObject({ sentAs: 'photo', size: 11, messageId: 102 });
    expect(second).toMatchObject({ sentAs: 'photo', size: 11, idempotent: true });
    expect(seams.api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(seams.api.sendPhoto.mock.calls[0]?.[0]).toBe('7');
    expect(seams.api.sendPhoto.mock.calls[0]?.[2]).toEqual({ caption: 'caption-test' });
    await gateway.stop();
  });

  it('uploads the opened file even when its path is replaced before the API consumes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-file-swap-'));
    temporaryRoots.push(root);
    const filesRoot = join(root, 'files');
    mkdirSync(filesRoot);
    const path = join(filesRoot, 'result.txt');
    const outside = join(root, 'outside.txt');
    writeFileSync(path, 'intended file');
    writeFileSync(outside, 'outside secret');
    let uploaded = '';
    seams.api.sendDocument.mockImplementationOnce(async (_chatId, upload) => {
      renameSync(path, join(filesRoot, 'original.txt'));
      symlinkSync(outside, path);
      const chunks = [];
      for await (const chunk of await upload.toRaw()) chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks).toString();
      return { message_id: 103 };
    });
    const gateway = await gatewayFor(intakeFor([]), join(root, 'ledger.json'), filesRoot);
    await gateway.sendFile(path, undefined, 'swap-file');
    expect(uploaded).toBe('intended file');
    await gateway.stop();
  });

  it('rejects a changed file payload for a delivered operation id and sends once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-telegram-document-'));
    temporaryRoots.push(root);
    const filesRoot = join(root, 'files');
    mkdirSync(filesRoot, { recursive: true });
    const documentPath = join(filesRoot, 'result-test.pdf');
    const changedPath = join(filesRoot, 'changed-test.pdf');
    writeFileSync(documentPath, 'document');
    writeFileSync(changedPath, 'changed');
    const gateway = await gatewayFor(intakeFor([]), join(root, 'telegram-ledger.json'), filesRoot);

    await gateway.sendFile(documentPath, undefined, 'document-operation');
    await expect(gateway.sendFile(changedPath, undefined, 'document-operation')).rejects.toThrow(
      /binding mismatch/
    );

    expect(seams.api.sendDocument).toHaveBeenCalledTimes(1);
    expect(seams.api.sendPhoto).not.toHaveBeenCalled();
    await gateway.stop();
  });
});
