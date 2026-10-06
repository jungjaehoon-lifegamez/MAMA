import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge } from '../../src/knowledge/index.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';
import { coreActionRegistrations, createCatalog } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import { createClient } from '../../src/client/client.js';
import { sendIpcRequest, newRequestId } from '../../src/client/ipc.js';
import { startRuntime, type RuntimeHandle } from '../../src/runtime/runtime.js';

const ACCESS = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [{ kind: 'project' as const, id: 'scope-test' }] as MemoryScopeRef[],
  // The grant this test stands on: exactly the actions it calls.
  actions: ['memory.save', 'work.list'],
};

describe('Story R3: runtime.start/stop — the single owner of the action socket', () => {
  let dir = '';
  let socketPath = '';
  let credentialPath = '';
  let journalPath = '';
  let catalog: ReturnType<typeof createCatalog>;
  let dispatch: ReturnType<typeof createDispatcher>;
  let runtime: RuntimeHandle | undefined;

  beforeAll(async () => {
    await initTestDB('runtime-lifecycle');
    const adapter = getAdapter();
    const knowledge = createKnowledge({ adapter, embedder: null });
    catalog = createCatalog(coreActionRegistrations(knowledge, adapter));
    dispatch = createDispatcher(catalog);
    dir = mkdtempSync(join(tmpdir(), 'mama-runtime-'));
    socketPath = join(dir, 'runtime.sock');
    credentialPath = join(dir, 'session-credential');
    journalPath = join(dir, 'operations.jsonl');
  });

  afterEach(async () => {
    await runtime?.stop().catch(() => {});
    runtime = undefined;
  });

  afterAll(async () => {
    await runtime?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    await cleanupTestDB();
  });

  const start = () =>
    startRuntime({
      paths: { socketPath },
      catalog,
      dispatch,
      principals: [{ access: ACCESS, credentialPath }],
      reclaimStaleSocket: true,
    });

  const clientFor = (credential?: string) => createClient({ socketPath, journalPath, credential });

  it('start writes a 0600 credential and serves describe plus a real call', async () => {
    runtime = await start();

    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    const credential = readFileSync(credentialPath, 'utf8').trim();
    expect(credential.length).toBeGreaterThan(0);

    const client = clientFor(credential);
    const surface = await client.describe();
    expect(surface.some((contract) => contract.name === 'memory.save')).toBe(true);

    const created = await client.call({
      action: 'memory.save',
      input: {
        topic: 'runtime-owned socket round trip',
        kind: 'decision',
        summary: 'the action socket commits through the shared dispatch',
        details: 'One write over the socket, to prove the socket writes.',
        source: { package: 'mama-core', source_type: 'test' },
      },
    });
    expect(created.status).toBe('completed');
    const work = await client.call({ action: 'work.list', input: {} });
    expect(work.status).toBe('completed');
  });

  it('a credential the runtime did not issue is denied before any action runs', async () => {
    runtime = await start();
    const denied = await clientFor('forged-credential').call({
      action: 'work.list',
      input: {},
    });
    expect(denied.status).toBe('failed');
    expect(denied.error?.code).toBe('access_denied');
  });

  it('serves a newly registered principal without restarting and revokes its socket identity', async () => {
    runtime = await start();
    const memberPath = join(dir, 'member-credential');
    const member = {
      credentialPath: memberPath,
      access: {
        principalId: 'principal-member',
        agentId: 'agent-member',
        scopes: [],
        actions: ['work.list'],
      },
    };

    expect(runtime.servesPrincipal(member.access.principalId)).toBe(false);
    writeFileSync(memberPath, 'stale', { mode: 0o644 });
    runtime.servePrincipal(member);
    expect(runtime.servesPrincipal(member.access.principalId)).toBe(true);
    expect(statSync(memberPath).mode & 0o777).toBe(0o600);
    const credential = readFileSync(memberPath, 'utf8').trim();
    expect(runtime.principalFor(credential)).toMatchObject(member);
    expect(await clientFor(credential).call({ action: 'work.list', input: {} })).toMatchObject({
      status: 'completed',
    });

    runtime.unservePrincipal(member.access.principalId);
    expect(runtime.servesPrincipal(member.access.principalId)).toBe(false);
    expect(runtime.principalFor(credential)).toBeUndefined();
    expect(existsSync(memberPath)).toBe(false);
    expect(await clientFor(credential).call({ action: 'work.list', input: {} })).toMatchObject({
      status: 'failed',
      error: { code: 'access_denied' },
    });
    expect(runtime.servesPrincipal(ACCESS.principalId)).toBe(true);
    runtime.servePrincipal(member);
    expect(readFileSync(memberPath, 'utf8').trim()).not.toBe(credential);
    await runtime.stop();
    runtime = undefined;
    expect(existsSync(memberPath)).toBe(false);
  });

  it('a second start on a live socket is refused — one start subject per profile', async () => {
    runtime = await start();
    const firstCredential = readFileSync(credentialPath, 'utf8').trim();
    await expect(start()).rejects.toThrow(/live runtime/);
    expect(readFileSync(credentialPath, 'utf8').trim()).toBe(firstCredential);
    expect(await clientFor(firstCredential).call({ action: 'work.list', input: {} })).toMatchObject(
      { status: 'completed' }
    );
  });

  it('a dead socket file is reclaimed, not served alongside', async () => {
    writeFileSync(socketPath, 'stale');
    runtime = await start();
    const credential = readFileSync(credentialPath, 'utf8').trim();
    const surface = await clientFor(credential).describe();
    expect(surface.length).toBeGreaterThan(0);
  });

  it('stop closes only what start opened: socket dead, credential gone', async () => {
    runtime = await start();
    const credential = readFileSync(credentialPath, 'utf8').trim();
    const keepPath = join(dir, 'not-runtime-owned');
    writeFileSync(keepPath, 'keep');

    await runtime.stop();
    runtime = undefined;

    expect(existsSync(credentialPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(keepPath)).toBe(true);
    await expect(
      sendIpcRequest(socketPath, {
        requestId: newRequestId(),
        kind: 'call',
        credential,
        action: 'work.list',
        input: {},
      })
    ).rejects.toMatchObject({ name: 'IpcTransportError', phase: 'connect' });
  });
});
