import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledge, type ActionContext } from '@jungjaehoon/mama-core';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createOwnerPolicyProvider } from '../../src/runtime/owner-policy.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { ChatSources } from '../../src/storage/chat-sources.js';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { SessionPool } from '@jungjaehoon/mama-core/runtime/session-pool';
import type { IModelRunner, PromptOptions } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { createNativeSession } from '../../src/runtime/native-session.js';
import {
  createStimulusDelivery,
  createStimulusIntake,
} from '../../src/runtime/stimulus-delivery.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

let root: string;
let database: Awaited<ReturnType<typeof openCoreDatabase>>;
let raw: RawStore;
let chat: ChatSources;
let surface: ReturnType<typeof createActionSurface>;
let operation: number;
const original = 'Keep answers brief.\n';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

beforeEach(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'owner-policy-actions-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('MAMA_DB_PATH', join(root, 'state.db'));
  vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
  database = await openCoreDatabase({ path: join(root, 'state.db') });
  raw = new RawStore(join(root, 'raw'));
  chat = new ChatSources(raw, database.adapter, 'owner-test', 'agent-test');
  surface = createActionSurface({
    runtimeRoot: root,
    adapter: database.adapter,
    knowledge: createKnowledge({ adapter: database.adapter }),
    ownerPrincipalId: 'owner-test',
    agentId: 'agent-test',
    timeZone: createTimeZoneSetting('UTC'),
    configPath: join(root, 'config.yaml'),
    isOwnerMessageTurn: () => true,
    storedSourceReader: createStoredSourceReader({
      adapter: database.adapter,
      ownerPrincipalId: () => 'owner-test',
      rawStore: () => raw,
    }),
  });
  fs.writeFileSync(join(root, 'owner-policy.md'), original);
  operation = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  raw.close();
  await database.close();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function ownerTurn(text = 'Always put the requested actions first.'): ActionContext {
  const id = `telegram:room-test:message-${operation++}`;
  const ref = chat.saveOwnerMessage({
    id,
    channelKey: 'room-test',
    occurredAt: Date.parse('2026-01-01T00:00:00Z') + operation,
    text,
  });
  return {
    access: surface.ownerAccess,
    session: { sourceMessageRef: id, sourceRefs: [ref] },
  };
}

interface PolicyResult {
  text: string | null;
  fingerprint: string;
  loaded: boolean;
  revision: { id: string; fingerprint: string } | null;
  mismatch: boolean;
  revisionId: string;
  baseRevisionId: string | null;
  events: unknown[];
}

async function call(action: string, input: unknown, context: ActionContext = ownerTurn()) {
  const result = await surface.dispatch(
    { action, input, operationId: `policy-test-${operation++}` },
    context
  );
  expect(result.status, JSON.stringify(result)).toBe('completed');
  return (result as { data: PolicyResult }).data;
}

const revisions = () =>
  database.adapter
    .prepare(
      "SELECT id, summary, reasoning, provenance_json FROM decisions WHERE json_extract(provenance_json, '$.tool_name') = 'manage.policy.update' ORDER BY rowid"
    )
    .all() as Array<{ id: string; summary: string; reasoning: string; provenance_json: string }>;

describe('owner policy actions', () => {
  it('reads exact policy bytes with the session fingerprint and reports no recorded revision yet', async () => {
    const result = await call('manage.policy.read', {});
    expect(result).toMatchObject({
      text: original,
      fingerprint: hash(original),
      loaded: true,
      revision: null,
      mismatch: false,
    });
    expect(result.fingerprint).toBe(createOwnerPolicyProvider(root)().fingerprint);
  });

  it.each([
    'record:source_delta:test:1',
    'scheduled:full:test',
    'source_delta:test',
    'subagent:thread-test',
  ])('refuses a policy update in %s', async (sourceMessageRef) => {
    const result = await surface.dispatch(
      {
        action: 'manage.policy.update',
        input: { text: 'Changed', fingerprint: hash(original), reason: 'Correction' },
        operationId: 'refused-turn',
      },
      { access: surface.ownerAccess, session: { sourceMessageRef } }
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'denied' } });
    expect(revisions()).toEqual([]);
    expect(fs.readFileSync(join(root, 'owner-policy.md'), 'utf8')).toBe(original);
  });

  it('refuses replay and non-owner turns even with an owner-chat ref', async () => {
    const context = ownerTurn();
    for (const changed of [
      { ...context, session: { ...context.session, replaySourceEndMs: 1 } },
      { ...context, access: { ...context.access, principalId: 'member-test' } },
    ]) {
      // Call the registration directly to test authority independently of the action grant.
      await expect(
        surface.catalog
          .entry('manage.policy.update')
          .exec({ text: 'Changed', fingerprint: hash(original), reason: 'Correction' }, changed)
      ).rejects.toMatchObject({ name: 'denied' });
    }
    expect(revisions()).toEqual([]);
  });

  it('refuses a stale fingerprint without writing a revision or changing the file', async () => {
    const result = await surface.dispatch(
      {
        action: 'manage.policy.update',
        input: { text: 'Changed', fingerprint: hash('old'), reason: 'Correction' },
        operationId: 'stale-policy',
      },
      ownerTurn()
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/fingerprint/) },
    });
    expect(revisions()).toEqual([]);
    expect(fs.readFileSync(join(root, 'owner-policy.md'), 'utf8')).toBe(original);
  });

  it('supports an absent policy and preserves an empty replacement text in history', async () => {
    fs.rmSync(join(root, 'owner-policy.md'));
    expect(await call('manage.policy.read', {})).toMatchObject({
      text: null,
      loaded: false,
      fingerprint: hash(''),
    });
    const first = await call('manage.policy.update', {
      text: 'First policy\n',
      fingerprint: hash(''),
      reason: 'Create standing rules',
    });
    expect(first.baseRevisionId).toBeNull();
    const cleared = await call('manage.policy.update', {
      text: '',
      fingerprint: first.fingerprint,
      reason: 'Withdraw standing rules',
    });
    expect(await call('manage.policy.read', {})).toMatchObject({
      text: '',
      loaded: true,
      fingerprint: hash(''),
      mismatch: false,
      revision: { id: cleared.revisionId },
    });
    expect(revisions().at(-1)!.reasoning).toBe('');
  });

  it('ignores ordinary memories with the same topic when finding policy history', async () => {
    const first = await call('manage.policy.update', {
      text: 'Standing policy\n',
      fingerprint: hash(original),
      reason: 'Standing correction',
    });
    await call(
      'memory.save',
      {
        topic: 'owner-policy',
        kind: 'decision',
        summary: 'Situational decision',
        details: 'Separate from standing rules',
        source: { package: 'test-product', source_type: 'memory.save' },
      },
      { access: surface.ownerAccess, session: { sourceMessageRef: 'source_delta:test' } }
    );
    expect(await call('manage.policy.read', {})).toMatchObject({
      mismatch: false,
      revision: { id: first.revisionId },
    });
  });

  it('refuses a concurrent update so one fingerprint cannot fork the revision chain', async () => {
    const context = ownerTurn();
    const input = {
      text: 'First policy\n',
      fingerprint: hash(original),
      reason: 'First correction',
    };
    const first = surface.catalog
      .entry('manage.policy.update')
      .exec(input, { ...context, operationId: 'concurrent-first' });
    const second = surface.catalog
      .entry('manage.policy.update')
      .exec(
        { ...input, text: 'Second policy\n' },
        { ...context, operationId: 'concurrent-second' }
      );
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { name: 'conflict', message: expect.stringContaining('in progress') },
    });
    expect(revisions().map((record) => record.reasoning)).toEqual([original, 'First policy\n']);
  });

  it('refuses to overwrite a hand edit made while the revisions are being saved', async () => {
    const current = ownerTurn();
    const revision = surface.catalog
      .entry('manage.policy.update')
      .exec(
        { text: 'Agent policy\n', fingerprint: hash(original), reason: 'Standing correction' },
        { ...current, operationId: 'edit-during-write' }
      );
    fs.writeFileSync(join(root, 'owner-policy.md'), 'Hand edit during write\n');
    await expect(revision).rejects.toMatchObject({
      name: 'conflict',
      message: expect.stringContaining('fingerprint changed during'),
    });
    expect(fs.readFileSync(join(root, 'owner-policy.md'), 'utf8')).toBe('Hand edit during write\n');
    expect(await call('manage.policy.read', {})).toMatchObject({ mismatch: true });
  });

  it('keeps each full text and reason in the chain with the owner message as readable provenance', async () => {
    const firstMessage = 'Always list actions first.';
    const first = await call(
      'manage.policy.update',
      {
        text: 'List actions first.\n',
        fingerprint: hash(original),
        reason: 'Actions need priority',
      },
      ownerTurn(firstMessage)
    );
    const second = await call(
      'manage.policy.update',
      {
        text: 'List actions first.\nKeep notices brief.\n',
        fingerprint: first.fingerprint,
        reason: 'Shorten notices',
      },
      ownerTurn('Always keep notices brief.')
    );
    const records = revisions();
    expect(records.map(({ summary, reasoning }) => ({ summary, reasoning }))).toEqual([
      { summary: 'Record current owner policy before: Actions need priority', reasoning: original },
      { summary: 'Actions need priority', reasoning: 'List actions first.\n' },
      { summary: 'Shorten notices', reasoning: 'List actions first.\nKeep notices brief.\n' },
    ]);
    for (const [id, sourceText] of [
      [first.baseRevisionId, firstMessage],
      [first.revisionId, firstMessage],
      [second.revisionId, 'Always keep notices brief.'],
    ]) {
      const provenance = await call('memory.read:provenance', { memory_id: id });
      expect(provenance.events).toEqual([
        expect.objectContaining({ connector: 'chat', excerpt: sourceText }),
      ]);
      const scopes = database.adapter
        .prepare(
          'SELECT s.kind, s.external_id FROM memory_scope_bindings b JOIN memory_scopes s ON s.id = b.scope_id WHERE b.memory_id = ?'
        )
        .all(id);
      expect(scopes).toEqual([{ kind: 'user', external_id: 'owner-test' }]);
    }
    const record = await call('memory.read:record', { memory_id: second.revisionId });
    expect(JSON.stringify(record)).toContain('Shorten notices');
    const edges = database.adapter
      .prepare(
        "SELECT subject_id, object_id, reason_text FROM twin_edges WHERE edge_type = 'supersedes' ORDER BY rowid"
      )
      .all();
    expect(edges).toEqual([
      {
        subject_id: first.revisionId,
        object_id: first.baseRevisionId,
        reason_text: 'Actions need priority',
      },
      {
        subject_id: second.revisionId,
        object_id: first.revisionId,
        reason_text: 'Shorten notices',
      },
    ]);
    expect(await call('manage.policy.read', {})).toMatchObject({
      fingerprint: second.fingerprint,
      mismatch: false,
      revision: { id: second.revisionId },
    });
  });

  it('reports a hand edit and records it as the base of the next update', async () => {
    const first = await call('manage.policy.update', {
      text: 'First policy\n',
      fingerprint: hash(original),
      reason: 'First revision',
    });
    fs.writeFileSync(join(root, 'owner-policy.md'), 'Hand edited\n');
    expect(await call('manage.policy.read', {})).toMatchObject({
      text: 'Hand edited\n',
      fingerprint: hash('Hand edited\n'),
      mismatch: true,
      revision: { id: first.revisionId, fingerprint: hash('First policy\n') },
    });
    const next = await call('manage.policy.update', {
      text: 'Next policy\n',
      fingerprint: hash('Hand edited\n'),
      reason: 'Keep the hand edit',
    });
    const records = revisions();
    expect(records.slice(-2).map((record) => record.reasoning)).toEqual([
      'Hand edited\n',
      'Next policy\n',
    ]);
    expect(records.at(-2)!.id).toBe(next.baseRevisionId);
    expect(await call('manage.policy.read', {})).toMatchObject({ mismatch: false });
  });

  it('writes the revision before atomic rename and reports a failed file replacement for recovery', async () => {
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
      expect(String(from)).toContain(root);
      expect(String(to)).toBe(join(root, 'owner-policy.md'));
      expect(revisions().at(-1)!.reasoning).toBe('Unwritten policy\n');
      expect(fs.readFileSync(join(root, 'owner-policy.md'), 'utf8')).toBe(original);
      throw new Error('Synthetic rename failure');
    });
    const result = await surface.dispatch(
      {
        action: 'manage.policy.update',
        input: {
          text: 'Unwritten policy\n',
          fingerprint: hash(original),
          reason: 'Interrupted change',
        },
        operationId: 'interrupted-policy',
      },
      ownerTurn()
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: 'Synthetic rename failure' },
    });
    rename.mockRestore();
    expect(await call('manage.policy.read', {})).toMatchObject({ text: original, mismatch: true });
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const recovered = await call('manage.policy.update', {
      text: 'Recovered policy\n',
      fingerprint: hash(original),
      reason: 'Recover file replacement',
    });
    expect(
      revisions()
        .slice(-2)
        .map((record) => record.reasoning)
    ).toEqual([original, 'Recovered policy\n']);
    expect(revisions().at(-2)!.id).toBe(recovered.baseRevisionId);
  });

  it('protects decision revisions from ordinary memory writes in every turn, including owner chat', async () => {
    const saved = await call('manage.policy.update', {
      text: 'New policy\n',
      fingerprint: hash(original),
      reason: 'Standing correction',
    });
    for (const context of [
      ownerTurn(),
      { access: surface.ownerAccess, session: { sourceMessageRef: 'source_delta:test' } },
    ]) {
      for (const [action, input] of [
        [
          'memory.save',
          {
            topic: 'other-topic',
            kind: 'decision',
            summary: 'Replace',
            details: 'Replacement',
            source: { package: 'test-product', source_type: 'memory.save' },
            replaces: [{ id: saved.revisionId, reason: 'Replace policy' }],
          },
        ],
        [
          'memory.retire',
          { memory_id: saved.revisionId, status: 'stale', reason: 'Retire policy' },
        ],
        [
          'memory.save',
          {
            topic: 'other-topic',
            kind: 'decision',
            summary: 'Forged',
            details: 'Forged policy',
            source: { package: 'test-product', source_type: 'manage.policy.update' },
          },
        ],
        [
          'memory.save',
          {
            topic: 'other-topic',
            kind: 'decision',
            summary: 'Forged',
            details: 'Forged policy',
            source: { package: 'test-product', source_type: 'memory.save' },
            provenance: { tool_name: 'manage.policy.update' },
          },
        ],
      ] as const) {
        await expect(
          surface.catalog.entry(action).exec(input, {
            ...context,
            operationId: `forbidden-${operation++}`,
          })
        ).rejects.toMatchObject({ name: 'denied' });
      }
    }
    expect(revisions()).toHaveLength(2);
  });

  it('offers policy contracts and examples through help and the owner tool catalog', async () => {
    for (const action of ['manage.policy.read', 'manage.policy.update']) {
      expect(surface.ownerAccess.actions).toContain(action);
      expect(surface.hostToolDefinitions().map(({ name }) => name)).toContain(action);
      const help = await call('help', { actions: [action] });
      expect(JSON.stringify(help)).toContain(action);
      expect(JSON.stringify(help)).toContain('example');
    }
  });

  it('uses the stored owner stimulus for the revision and opens the next native session with the full changed policy', async () => {
    const mailbox = new Mailbox(database.adapter);
    const intake = createStimulusIntake(
      {
        mailbox,
        accept: (stimulus) => ({ inputId: mailbox.enqueue(stimulus)!, state: 'accepted' }),
      },
      'owner-test',
      chat
    );
    const message = {
      id: 'telegram:room-test:policy-request',
      channelKey: 'room-test',
      occurredAt: Date.parse('2026-01-01T00:00:00Z'),
      text: 'Always keep notices brief.',
    };
    intake.acceptOwnerMessage(message);
    const prompts: PromptOptions[] = [];
    let activeFingerprint: string | undefined;
    let revisionId: string;
    const changed = 'Keep answers brief.\nKeep notices brief.\n';
    const model = {
      backendType: 'codex',
      reportsModelRuns: false,
      getSessionPolicyStatus: ({ sessionPolicyFingerprint }: PromptOptions) => {
        const status =
          activeFingerprint === undefined
            ? 'missing'
            : activeFingerprint === sessionPolicyFingerprint
              ? 'compatible'
              : 'mismatch';
        activeFingerprint = sessionPolicyFingerprint;
        return status;
      },
      prompt: async (_content: unknown, _callbacks: unknown, options: PromptOptions) => {
        prompts.push(options);
        if (prompts.length === 1) {
          const read = await options.hostToolBridge!.execute({
            callId: 'policy-read',
            name: 'manage.policy.read',
            input: {},
          });
          const current = JSON.parse(read.content) as { data: { fingerprint: string } };
          const update = await options.hostToolBridge!.execute({
            callId: 'policy-update',
            name: 'manage.policy.update',
            input: {
              text: changed,
              fingerprint: current.data.fingerprint,
              reason: 'Keep notices brief',
            },
          });
          const receipt = JSON.parse(update.content) as {
            success: boolean;
            data: { revisionId: string };
          };
          expect(receipt.success).toBe(true);
          revisionId = receipt.data.revisionId;
        }
        return {
          response: 'Recorded',
          session_id: options.sessionId,
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
    const pool = new SessionPool({ cleanupIntervalMs: 60_000 });
    const session = createNativeSession({
      backend: 'codex',
      model: 'fixture-model',
      workspaceDir: join(root, 'workspace'),
      runtimeRoot: root,
      actionSurface: surface,
      agent: model,
      sessionPool: pool,
      ownerSystemPrompt: 'Standing instructions',
      ownerPolicyProvider: createOwnerPolicyProvider(root),
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
        nativeInputId: 'policy-input',
        resultForReceipt: () => null,
      };
      await delivery.deliver(mailbox.readInput(message.id, 'owner-test')!, context as never);
      expect(await call('memory.read:provenance', { memory_id: revisionId! })).toMatchObject({
        events: [
          expect.objectContaining({
            connector: 'chat',
            sourceId: message.id,
            excerpt: message.text,
          }),
        ],
      });
      const next = {
        ...message,
        id: 'telegram:room-test:next-request',
        text: 'Read the policy again.',
      };
      intake.acceptOwnerMessage(next);
      await delivery.deliver(mailbox.readInput(next.id, 'owner-test')!, context as never);
      expect(prompts[0]!.systemPrompt).toContain(original);
      expect(prompts[1]!.systemPrompt).toContain(changed);
      expect(prompts[1]!.sessionPolicyFingerprint).not.toBe(prompts[0]!.sessionPolicyFingerprint);
      expect(prompts[1]!.sessionId).not.toBe(prompts[0]!.sessionId);
    } finally {
      await session.stop();
      pool.dispose();
    }
  });
});
