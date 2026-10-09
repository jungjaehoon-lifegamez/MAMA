import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createKnowledge,
  createPrincipalRepository,
  type ActionResult,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import type { InputFile } from 'grammy';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import { memberPaths } from '../../src/runtime/member-paths.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';
import type { AttachmentActionPorts } from '../../src/api/attachment-actions.js';

// Keep the gateway and InputFile real; replace only the external grammy Bot/API.
const seams = vi.hoisted(() => ({
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 101 }),
    sendPhoto: vi.fn(),
    sendDocument: vi.fn(),
    editMessageText: vi.fn(),
    deleteMessage: vi.fn(),
  },
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
    start: vi.fn().mockImplementation(() => new Promise(() => {})),
    stop: vi.fn().mockResolvedValue(undefined),
    botInfo: { id: 101, username: 'fixture_bot' },
    api: seams.api,
  })),
}));

const OWNER = 'owner-test';
const OWNER_DM = '20001';
const MEMBER_DM = '20002';
const OTHER_DM = '20003';
const DOCUMENT = readFileSync(new URL('../fixtures/file-delivery/result.xlsx', import.meta.url));
const PHOTO = readFileSync(new URL('../fixtures/file-delivery/result.png', import.meta.url));

function completed(result: ActionResult): unknown {
  if (result.status !== 'completed') throw new Error(JSON.stringify(result.error));
  return result.data;
}

describe('P5 principal file delivery through the product dispatcher and TelegramGateway', () => {
  let root: string;
  let database: Awaited<ReturnType<typeof openCoreDatabase>>;
  let repository: ReturnType<typeof createPrincipalRepository>;
  let surface: ReturnType<typeof createActionSurface>;
  let gateway: TelegramGateway;
  let member: string;
  let other: string;
  let ownerWorkspace: string;
  let ports: AttachmentActionPorts;
  let uploaded: Array<{ chatId: string; bytes: Buffer; filename: string }>;
  const intake = {
    acceptOwnerMessage: vi.fn().mockReturnValue({ inputId: 'fixture-input', state: 'accepted' }),
    recordOwnerReply: () => {},
  };

  const paths = (principalId: string) =>
    principalId === OWNER
      ? { workspaceDir: ownerWorkspace, downloadsDir: join(root, 'owner-downloads') }
      : memberPaths(join(root, 'members'), principalId);
  const file = (principalId = member, name = 'result.xlsx') =>
    join(paths(principalId).workspaceDir, 'files', name);
  const access = (principalId = member) =>
    resolvePrincipalAccess(principalId, {
      adapter: database.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: `agent-${principalId}`,
    });
  // Match the runtime's per-call resolution; no socket or native model is started.
  const dispatch = async (
    principalId: string,
    operationId: string,
    input: Record<string, unknown>,
    action = 'deliver.telegram.file'
  ) => surface.dispatch({ action, operationId, input }, { access: access(principalId) });
  const buildSurface = () =>
    createActionSurface({
      adapter: database.adapter,
      knowledge: createKnowledge({ adapter: database.adapter, embedder: null }),
      runtimeRoot: join(root, 'runtime'),
      configPath: join(root, 'config.yaml'),
      ownerPrincipalId: OWNER,
      agentId: 'agent-owner-test',
      timeZone: createTimeZoneSetting('UTC'),
      isOwnerMessageTurn: () => false,
      attachmentPorts: ports,
      driveDelivery: {
        workspaceDir: ownerWorkspace,
        stagingDir: join(root, 'outgoing'),
        delivery: { folder: 'folder_test_0123456789', readers: [{ domain: 'example.test' }] },
      },
    });
  const clearCalls = () => Object.values(seams.api).forEach((mock) => mock.mockClear());
  const noApiCalls = () =>
    Object.values(seams.api).forEach((mock) => expect(mock).not.toHaveBeenCalled());
  // A refusal after a real successful member send catches lost file authority as well as leaks.
  // It also makes every new case fail against the pre-P5 role, rather than pass by denying all files.
  const memberControl = async () => {
    completed(await dispatch(member, 'control', { path: file() }));
    expect(uploaded).toEqual([{ chatId: MEMBER_DM, bytes: DOCUMENT, filename: 'result.xlsx' }]);
    clearCalls();
    uploaded.length = 0;
  };

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'principal-files-')));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    database = await openCoreDatabase({ path: process.env.MAMA_DB_PATH! });
    repository = createPrincipalRepository(database.adapter);
    repository.ensureOwner({
      principalId: OWNER,
      connector: 'telegram',
      namespace: 'private',
      externalId: OWNER_DM,
      now: 1,
    });
    member = repository.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: MEMBER_DM,
      now: 2,
    });
    other = repository.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: OTHER_DM,
      now: 3,
    });
    ownerWorkspace = join(root, 'owner-workspace');
    for (const id of [OWNER, member, other]) {
      mkdirSync(join(paths(id).workspaceDir, 'files'), { recursive: true });
      mkdirSync(paths(id).downloadsDir, { recursive: true });
      writeFileSync(file(id), DOCUMENT);
      writeFileSync(file(id, 'result.png'), PHOTO);
    }
    uploaded = [];
    const upload = (messageId: number) => async (chatId: string, value: InputFile) => {
      const chunks: Buffer[] = [];
      for await (const chunk of await value.toRaw()) chunks.push(Buffer.from(chunk));
      uploaded.push({ chatId, bytes: Buffer.concat(chunks), filename: value.filename! });
      return { message_id: messageId };
    };
    Object.values(seams.api).forEach((mock) => mock.mockReset());
    intake.acceptOwnerMessage.mockClear();
    seams.api.sendPhoto.mockImplementation(upload(102));
    seams.api.sendDocument.mockImplementation(upload(103));
    seams.api.sendMessage.mockResolvedValue({ message_id: 101 });
    gateway = new TelegramGateway({
      token: 'fixture-token',
      intake,
      config: { allowedChats: [OWNER_DM], ownerChatId: OWNER_DM, polling: false },
      filesRoot: join(ownerWorkspace, 'files'),
      messageLedgerPath: join(root, 'ledger.json'),
      log: () => {},
    });
    await gateway.start();
    ports = {
      workspaceDir: ownerWorkspace,
      principalPaths: paths,
      telegram: () => gateway,
      slack: () => ({ sendFile: vi.fn() }),
      discord: () => ({ sendFile: vi.fn() }),
    };
    surface = buildSurface();
  });

  afterEach(async () => {
    await gateway?.stop();
    await database?.close();
    seams.handlers.clear();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps owner uploads unchanged while member xlsx and png reach only their own DM', async () => {
    for (const id of [OWNER, member]) {
      expect(
        completed(
          await dispatch(id, `${id}-document`, { path: file(id), caption: 'fixture caption' })
        )
      ).toEqual({ path: file(id), messageId: 103, sentAs: 'document', size: DOCUMENT.length });
      expect(
        completed(await dispatch(id, `${id}-photo`, { path: file(id, 'result.png') }))
      ).toEqual({
        path: file(id, 'result.png'),
        messageId: 102,
        sentAs: 'photo',
        size: PHOTO.length,
      });
      const dm = id === OWNER ? OWNER_DM : MEMBER_DM;
      expect(uploaded).toEqual([
        { chatId: dm, bytes: DOCUMENT, filename: 'result.xlsx' },
        { chatId: dm, bytes: PHOTO, filename: 'result.png' },
      ]);
      expect(seams.api.sendDocument.mock.calls[0]).toEqual([
        dm,
        expect.anything(),
        { caption: 'fixture caption' },
      ]);
      expect(seams.api.sendPhoto.mock.calls[0]).toEqual([dm, expect.anything(), undefined]);
      expect(seams.api.sendMessage).not.toHaveBeenCalled();
      clearCalls();
      uploaded.length = 0;
    }
    const ledger = new TelegramMessageLedger(join(root, 'ledger.json'));
    expect(ledger.get(`file:${OWNER}-document`)).toMatchObject({
      state: 'delivered',
      deliveryTarget: `telegram:${OWNER_DM}`,
      payloadIdentity: 'a55212ff05b28df92a8f6784a7b0408cfc50212026b4064825c6442816a3d4ad',
    });
    expect(ledger.get(`file:${OWNER}-photo`)).toMatchObject({
      state: 'delivered',
      deliveryTarget: `telegram:${OWNER_DM}`,
      payloadIdentity: '876918d8582532867efacd23ea60a2b53e18e8aca571a3bdd381d98bf01f9055',
    });
    const trace = database.adapter
      .prepare('SELECT actor_principal_id FROM tool_traces WHERE operation_id = ?')
      .get(`${member}-document`);
    expect(trace).toEqual({ actor_principal_id: member });
  });

  it.each([
    'owner',
    'other member',
    'symlink',
    'outside files',
    'downloads',
    'directory',
    'oversized',
  ])('refuses a member %s path without any API call', async (kind) => {
    await memberControl();
    let path = file();
    if (kind === 'owner') path = file(OWNER);
    if (kind === 'other member') path = file(other);
    if (kind === 'outside files') {
      path = join(paths(member).workspaceDir, 'outside.xlsx');
      writeFileSync(path, DOCUMENT);
    }
    if (kind === 'downloads') {
      path = join(paths(member).downloadsDir, 'result.xlsx');
      writeFileSync(path, DOCUMENT);
    }
    if (kind === 'symlink') {
      path = file(member, 'link.xlsx');
      symlinkSync(file(OWNER), path);
    }
    if (kind === 'directory') {
      path = file(member, 'directory');
      mkdirSync(path);
    }
    if (kind === 'oversized') {
      path = file(member, 'oversized.xlsx');
      writeFileSync(path, '');
      truncateSync(path, 50 * 1024 * 1024 + 1);
    }
    const result = await dispatch(member, 'refused-path', { path });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.code).not.toBe('action_not_granted');
    noApiCalls();
  });

  it('refuses a member without principal paths rather than using the owner root', async () => {
    await memberControl();
    delete ports.principalPaths;
    surface = buildSurface();
    const result = await dispatch(member, 'missing-paths', { path: file(OWNER) });
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/principal paths/) },
    });
    noApiCalls();
  });

  it('resolves suspension again on the next call without any API call', async () => {
    await memberControl();
    repository.suspend(member, 4);
    await expect(dispatch(member, 'suspended', { path: file() })).rejects.toThrow(/suspended/);
    noApiCalls();
  });

  it.each([0, 2])('refuses %s registry Telegram identities on the next call', async (count) => {
    await memberControl();
    if (count === 0)
      database.adapter
        .prepare('DELETE FROM external_identities WHERE principal_id = ?')
        .run(member);
    else repository.bindIdentity(member, 'telegram', 'private', '20004', 4);
    await expect(dispatch(member, 'identities', { path: file() })).rejects.toThrow(
      /exactly one Telegram private identity/
    );
    noApiCalls();
  });

  it.each([
    { name: 'absent', destinations: undefined },
    { name: 'empty', destinations: [] },
    { name: 'non-Telegram', destinations: [{ kind: 'slack', id: 'fixture-channel' }] },
    {
      name: 'two Telegram destinations',
      destinations: [
        { kind: 'telegram', id: MEMBER_DM },
        { kind: 'telegram', id: OTHER_DM },
      ],
    },
    { name: 'blank Telegram id', destinations: [{ kind: 'telegram', id: '' }] },
  ])('refuses $name host destinations without any API call', async ({ destinations }) => {
    await memberControl();
    const caller: JudgmentAccess = { ...access(), destinations };
    const result = await surface.dispatch(
      { action: 'deliver.telegram.file', operationId: 'destinations', input: { path: file() } },
      { access: caller }
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/exactly one Telegram destination/) },
    });
    noApiCalls();
  });

  it.each(['chatId', 'chat_id', 'destinations', 'access'])(
    'refuses model-supplied %s without any API call',
    async (key) => {
      await memberControl();
      const result = await dispatch(member, 'chat-input', { path: file(), [key]: OWNER_DM });
      expect(result).toMatchObject({ status: 'failed', error: { code: 'invalid_input' } });
      noApiCalls();
    }
  );

  it.each(['deliver.slack.file', 'deliver.discord.file', 'deliver.drive.file', 'report.publish'])(
    'keeps %s action_not_granted for a member',
    async (action) => {
      await memberControl();
      const input =
        action === 'report.publish' ? { slots: { full: '<p>fixture</p>' } } : { path: file() };
      const result = await dispatch(member, 'owner-only', input, action);
      expect(result).toMatchObject({ status: 'failed', error: { code: 'action_not_granted' } });
      noApiCalls();
    }
  );

  it('sends a repeated member operation once under the unchanged file ledger key', async () => {
    completed(await dispatch(member, 'repeat', { path: file() }));
    expect(completed(await dispatch(member, 'repeat', { path: file() }))).toEqual({
      path: file(),
      sentAs: 'document',
      size: DOCUMENT.length,
      idempotent: true,
    });
    expect(uploaded).toEqual([{ chatId: MEMBER_DM, bytes: DOCUMENT, filename: 'result.xlsx' }]);
    expect(seams.api.sendDocument).toHaveBeenCalledOnce();
    expect(new TelegramMessageLedger(join(root, 'ledger.json')).get('file:repeat')).toMatchObject({
      state: 'delivered',
      deliveryTarget: `telegram:${MEMBER_DM}`,
    });
  });

  it('holds the member file descriptor through upload when its path is replaced', async () => {
    seams.api.sendDocument.mockImplementationOnce(async (chatId: string, upload: InputFile) => {
      renameSync(file(), file(member, 'original.xlsx'));
      writeFileSync(file(OWNER), 'owner private bytes');
      symlinkSync(file(OWNER), file());
      const chunks: Buffer[] = [];
      for await (const chunk of await upload.toRaw()) chunks.push(Buffer.from(chunk));
      expect(chatId).toBe(MEMBER_DM);
      expect(Buffer.concat(chunks)).toEqual(DOCUMENT);
      return { message_id: 103 };
    });
    completed(await dispatch(member, 'swap', { path: file() }));
    expect(seams.api.sendDocument).toHaveBeenCalledOnce();
  });

  it('keeps member text sends and inbound admission outside the file exception', async () => {
    await memberControl();
    await expect(gateway.sendMessage(MEMBER_DM, 'fixture', 'member-text')).rejects.toThrow(
      /allowlist/
    );
    await seams.handlers.get('message')!({
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: Number(MEMBER_DM), type: 'private' },
        from: { id: Number(MEMBER_DM), is_bot: false },
        text: 'fixture',
      },
    });
    expect(intake.acceptOwnerMessage).not.toHaveBeenCalled();
    await seams.handlers.get('message')!({
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: Number(OWNER_DM), type: 'private' },
        from: { id: Number(OWNER_DM), is_bot: false },
        text: 'fixture',
      },
    });
    expect(intake.acceptOwnerMessage).toHaveBeenCalledOnce();
  });
});
