import { ensureMemoryScope } from '@jungjaehoon/mama-core/db-manager';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NativeSessionHandle } from '@jungjaehoon/mama-core/runtime/runtime';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { readOwnerMemoryRecords, createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { createOwnerPolicyProvider } from '../../src/runtime/owner-policy.js';
import { createClient } from '@jungjaehoon/mama-core/client/client';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('owner runtime assembly', () => {
  it('omits erased records from the session and report memory reader', async () => {
    const home = mkdtempSync(join(tmpdir(), 'owner-erased-memory-'));
    homes.push(home);
    const handle = await openCoreDatabase({ path: join(home, 'state.db') });
    try {
      const db = handle.adapter;
      const scopeId = ensureMemoryScope(db, 'user', 'test-principal');
      for (const id of ['kept-record', 'erased-record']) {
        db.prepare(
          "INSERT INTO decisions (id, topic, decision, summary, kind, status, created_at, erased_at) VALUES (?, 'fixture', 'fixture content', 'fixture summary', 'preference', 'active', 1, ?)"
        ).run(id, id === 'erased-record' ? 2 : null);
        db.prepare('INSERT INTO memory_scope_bindings (memory_id, scope_id) VALUES (?, ?)').run(
          id,
          scopeId
        );
      }
      const scopes = [{ kind: 'user', id: 'test-principal' }];
      expect(
        (
          await readOwnerMemoryRecords(db, scopes, { status: 'active', excludeAmendments: true })
        ).map((r) => r.id)
      ).toEqual(['kept-record']);
      expect(
        (await readOwnerMemoryRecords(db, scopes, { status: 'active', kind: ['preference'] })).map(
          (r) => r.id
        )
      ).toEqual(['kept-record']);
    } finally {
      handle.close();
    }
  });

  it('routes authenticated Claude socket caller facts to the active native session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'caller-socket-'));
    homes.push(home);
    const callAction = vi.fn(async () => ({ status: 'completed' as const, data: { ok: true } }));
    const owner = await createOwnerRuntime({
      backend: 'claude',
      model: 'fixture-model',
      rawPath: join(home, 'raw'),
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      timeZone: createTimeZoneSetting('UTC'),
      workspaceDir: join(home, 'workspace'),
      ownerPrincipalId: 'owner',
      agentId: 'agent',
      scopes: [],
      nativeSession: { stop: async () => {}, callAction },
      maxTurns: 10,
      timeout: 1_000,
    });
    try {
      const client = createClient({
        socketPath: join(home, 'runtime.sock'),
        journalPath: join(home, 'journal.jsonl'),
        credential: readFileSync(join(home, 'credential'), 'utf8').trim(),
      });
      const caller = { session_id: 'session', tool_use_id: 'call', agent_id: 'child' };
      expect(
        await client.call({
          action: 'work.create',
          input: { topic: 'fixture' },
          operationId: 'op-fixture',
          session: { nativeCaller: caller },
        })
      ).toMatchObject({ status: 'completed' });
      expect(callAction).toHaveBeenCalledWith(
        { action: 'work.create', input: { topic: 'fixture' }, operationId: 'op-fixture' },
        caller
      );
    } finally {
      await owner.stop();
    }
  });
  it('reloads an external owner policy and fingerprints exact file bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-owner-policy-'));
    homes.push(home);
    const provider = createOwnerPolicyProvider(home);

    expect(provider()).toMatchObject({ content: null, loaded: false });

    writeFileSync(join(home, 'owner-policy.md'), 'title format: owner policy\n', 'utf8');
    const first = provider();
    writeFileSync(join(home, 'owner-policy.md'), 'title format: updated policy\n', 'utf8');
    const second = provider();

    expect(first).toMatchObject({ content: 'title format: owner policy\n', loaded: true });
    expect(second).toMatchObject({ content: 'title format: updated policy\n', loaded: true });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('passes the embedder into real knowledge so work.create stores a vector', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-owner-runtime-'));
    homes.push(home);
    const nativeSession: NativeSessionHandle = { stop: async () => {} };
    const embed = vi.fn(async () => new Float32Array(1024).fill(0.25));
    const owner = await createOwnerRuntime({
      backend: 'codex',
      model: 'test-model',
      rawPath: join(home, 'raw'),
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      timeZone: createTimeZoneSetting('UTC'),
      workspaceDir: join(home, 'workspace'),
      ownerPrincipalId: 'owner',
      agentId: 'agent',
      scopes: [{ kind: 'project', id: 'scope' }],
      embedder: { embed },
      nativeSession,
      maxTurns: 20,
      timeout: 1_000,
    });
    try {
      const result = await owner.surface.hostToolCall(
        'work.create',
        {
          topic: 'topic',
          summary: 'summary',
          set: { title: 'work' },
        },
        'operation-1'
      );
      expect(result.status).toBe('completed');
      expect(embed).toHaveBeenCalled();
      expect(
        owner.database.adapter.prepare('SELECT COUNT(*) AS count FROM embeddings').get()
      ).toEqual({ count: 1 });
    } finally {
      await owner.stop();
    }
  });

  it('lets the owner save a correction under user and connector channel scopes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-owner-memory-scope-'));
    homes.push(home);
    const nativeSession: NativeSessionHandle = { stop: async () => {} };
    const embed = vi.fn(async () => new Float32Array(1024).fill(0.25));
    const owner = await createOwnerRuntime({
      backend: 'codex',
      model: 'test-model',
      rawPath: join(home, 'raw'),
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      timeZone: createTimeZoneSetting('UTC'),
      workspaceDir: join(home, 'workspace'),
      ownerPrincipalId: 'owner',
      agentId: 'agent',
      scopes: [{ kind: 'global', id: 'system' }],
      embedder: { embed },
      nativeSession,
      maxTurns: 20,
      timeout: 1_000,
    });
    try {
      const result = await owner.surface.hostToolCall(
        'memory.save',
        {
          topic: 'owner-correction',
          kind: 'lesson',
          summary: 'The owner correction is durable',
          details: 'The correction was linked to the source evidence.',
          appliesWhen: 'When the owner corrects this procedure',
          scopes: [
            { kind: 'user', id: 'owner' },
            { kind: 'channel', id: 'chatwork' },
          ],
          source: { package: 'standalone', source_type: 'owner-correction' },
        },
        'operation-memory-scope'
      );
      expect(result.status).toBe('completed');
    } finally {
      await owner.stop();
    }
  });
  it('reads report and recording rules from the policy and memory through their procedures', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-owner-report-rules-'));
    homes.push(home);
    const owner = await createOwnerRuntime({
      backend: 'codex',
      model: 'test-model',
      rawPath: join(home, 'raw'),
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      timeZone: createTimeZoneSetting('UTC'),
      workspaceDir: join(home, 'workspace'),
      ownerPrincipalId: 'owner',
      agentId: 'agent',
      scopes: [{ kind: 'global', id: 'system' }],
      nativeSession: { stop: async () => {} },
      maxTurns: 20,
      timeout: 1_000,
    });
    try {
      const report = await owner.surface.hostToolCall('help', { topic: 'full-report' }, 'help-1');
      const record = await owner.surface.hostToolCall('help', { topic: 'record' }, 'help-2');
      expect(report.status).toBe('completed');
      expect(record.status).toBe('completed');
      if (report.status !== 'completed' || record.status !== 'completed') return;
      expect(report.data).toContain('Full report');
      expect(report.data).toContain('The owner policy carries the standing report rules');
      expect(report.data).toContain('read situational owner rules on reports with memory.search');
      expect(report.data).not.toContain('<owner_rules>');
      expect(record.data).toContain('The owner policy carries the standing recording rules');
      expect(record.data).toContain('read situational owner rules on recording with memory.search');
      expect(record.data).not.toContain('<owner_rules>');
    } finally {
      await owner.stop();
    }
  });

  it('starts a session with recent decisions, not the records that amend them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-owner-session-start-'));
    homes.push(home);
    let prompt = '';
    const runTurn = vi.fn<NonNullable<NativeSessionHandle['runTurn']>>(
      async (_content, request) => {
        request?.streamCallbacks?.onInputDispatch?.({
          backend: 'codex',
          sessionId: 'owner-thread',
          inputId: request.nativeInputId!,
        });
        request?.streamCallbacks?.onAccepted?.({
          backend: 'codex',
          sessionId: 'owner-thread',
          turnId: 'turn-1',
        });
        const prepared = await request?.prepareSessionContent?.({
          sessionId: 'owner-thread',
          isNewSession: true,
        });
        prompt = prepared?.map((block) => ('text' in block ? block.text : '')).join('\n') ?? '';
        return { response: '[ack]', modelRunId: 'run-1' } as never;
      }
    );
    const owner = await createOwnerRuntime({
      backend: 'codex',
      model: 'test-model',
      rawPath: join(home, 'raw'),
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      timeZone: createTimeZoneSetting('UTC'),
      workspaceDir: join(home, 'workspace'),
      ownerPrincipalId: 'owner',
      agentId: 'agent',
      scopes: [{ kind: 'global', id: 'system' }],
      embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
      nativeSession: { stop: async () => {}, runTurn },
      maxTurns: 20,
      timeout: 1_000,
    });
    try {
      const save = async (topic: string) => {
        const saved = await owner.surface.hostToolCall(
          'memory.save',
          {
            topic,
            kind: 'decision',
            summary: `${topic} summary`,
            details: `${topic} details`,
            scopes: [{ kind: 'global', id: 'system' }],
            source: { package: 'standalone', source_type: 'test' },
          },
          `save-${topic}`
        );
        expect(saved).toMatchObject({ status: 'completed' });
        return (saved as { data: { id: string } }).data.id;
      };
      await save('kept-decision');
      const retired = await save('retired-decision');
      const retirement = await owner.surface.hostToolCall(
        'memory.retire',
        { memory_id: retired, status: 'stale', reason: 'no longer true' },
        'retire-decision'
      );
      expect(retirement).toMatchObject({ status: 'completed' });

      owner.intake.acceptOwnerMessage({
        id: 'owner-1',
        channelKey: 'owner-chat',
        occurredAt: Date.now(),
        text: 'hello',
      });
      await vi.waitFor(() => expect(runTurn).toHaveBeenCalledOnce());
      expect(prompt).toContain('kept-decision');
      expect(prompt).not.toContain('retired-decision');
      expect(prompt).not.toContain('no longer true');
    } finally {
      await owner.stop();
    }
  });
});
