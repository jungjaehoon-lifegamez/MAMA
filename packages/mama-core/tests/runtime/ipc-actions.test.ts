import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge, type Knowledge } from '../../src/knowledge/index.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';
import {
  createCatalog,
  coreActionRegistrations,
  type ActionRegistration,
} from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import type { WorkWriteResult } from '../../src/knowledge/commitments.js';
import { JudgmentError } from '../../src/knowledge/judgments.js';
import type { ActionContract, ActionResult } from '../../src/action-contracts.js';
import { createClient, type Client } from '../../src/client/client.js';
import {
  createActionIpcServer,
  encodeFrame,
  newRequestId,
  type ActionIpcServer,
} from '../../src/client/ipc.js';

const ACCESS = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [{ kind: 'project' as const, id: 'scope-test' }] as MemoryScopeRef[],
  // The grant this test stands on: exactly the actions it calls.
  actions: [
    'graph.query',
    // getOperation on the client is operation.get on the wire.
    'operation.get',
    'test.echo_absent',
    'test.echo_session',
    'test.slowcommit',
    'test.create',
    'work.list',
  ],
};

const GOOD_CREDENTIAL = 'test-session-credential';
const OTHER_CREDENTIAL = 'other-principal-credential';

const OTHER_ACCESS = {
  principalId: 'principal-other',
  agentId: 'agent-other',
  // Granted the same read, so what hides another principal's operation is the
  // principal binding rather than the grant.
  actions: ['operation.get'],
  scopes: [{ kind: 'project' as const, id: 'scope-other' }] as MemoryScopeRef[],
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Test-only write. These tests are about the socket, the dispatch and the operation
 * log; they used the owner-work action because it was a handy write, and when that
 * action moved to the product that owns its vocabulary they went with it. A mechanism
 * test writes through a mechanism.
 */
function makeTestCreate(knowledge: Knowledge): ActionRegistration {
  return {
    contract: {
      name: 'test.create',
      summary: 'test-only action: commits one work record over the socket.',
      inputSchema: {
        type: 'object',
        required: ['topic', 'summary'],
        additionalProperties: true,
        properties: {
          topic: { type: 'string', minLength: 1 },
          summary: { type: 'string', minLength: 1 },
        },
      },
    },
    exec: (input, context) => {
      const body = (input ?? {}) as { topic: string; summary: string };
      return knowledge.createWork(
        {
          commandId: context.operationId ?? 'missing-op-id',
          topic: body.topic,
          summary: body.summary,
          set: { title: body.topic },
        },
        context.access
      );
    },
  };
}

/** Test-only action: commits a real work record, then delays so the reply can be lost post-commit. */
function makeSlowCommit(knowledge: Knowledge): ActionRegistration {
  return {
    contract: {
      name: 'test.slowcommit',
      summary:
        'test-only action: commits a work record, then delays so the reply can be lost after the commit',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { delayMs: { type: 'integer', minimum: 0 } },
      },
    },
    exec: async (input, context) => {
      const { delayMs = 150 } = (input ?? {}) as { delayMs?: number };
      const result = knowledge.createWork(
        {
          commandId: context.operationId ?? 'missing-op-id',
          topic: 'committed work whose reply was lost',
          summary: 'a disconnect after commit must surface unknown, never failed',
          set: { title: 'lost-reply work', status: 'pending' },
        },
        context.access
      );
      await sleep(delayMs);
      return result;
    },
  };
}

function makeServer(
  socketPath: string,
  dispatch: Parameters<typeof createActionIpcServer>[0]['dispatch'],
  catalog: Parameters<typeof createActionIpcServer>[0]['catalog']
): Promise<ActionIpcServer> {
  return createActionIpcServer({
    socketPath,
    catalog,
    dispatch,
    resolveAccess: (credential) => {
      if (credential === GOOD_CREDENTIAL) {
        return ACCESS;
      }
      if (credential === OTHER_CREDENTIAL) {
        return OTHER_ACCESS;
      }
      throw new JudgmentError('ACCESS_DENIED', 'unresolved session credential');
    },
  });
}

/** Read one complete length-prefixed frame off a raw socket. */
function readOneFrame(
  socket: ReturnType<typeof createConnection>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) {
        return;
      }
      const length = buffered.readUInt32BE(0);
      if (buffered.length < 4 + length) {
        return;
      }
      resolve(JSON.parse(buffered.subarray(4, 4 + length).toString('utf8')));
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('socket closed before a complete frame')));
  });
}

describe('Story R2: client/ipc — describe, call, getOperation over a real Unix socket', () => {
  let dbPath = '';
  let dir = '';
  let socketPath = '';
  let journalPath = '';
  let knowledge: Knowledge;
  let server: ActionIpcServer;
  let client: Client;

  beforeAll(async () => {
    dbPath = await initTestDB('ipc-actions');
    knowledge = createKnowledge({ adapter: getAdapter(), embedder: null });

    const catalog = createCatalog([
      ...coreActionRegistrations(knowledge, getAdapter()),
      makeTestCreate(knowledge),
      makeSlowCommit(knowledge),
    ]);
    const dispatch = createDispatcher(catalog);

    dir = mkdtempSync(join(tmpdir(), 'mama-ipc-'));
    socketPath = join(dir, 'runtime.sock');
    journalPath = join(dir, 'operations.jsonl');
    server = await makeServer(socketPath, dispatch, catalog);
    client = createClient({ socketPath, journalPath, credential: GOOD_CREDENTIAL });
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM commitment_assignments').run();
    db.prepare('DELETE FROM commitments').run();
    db.prepare('DELETE FROM judgment_commands').run();
    db.prepare('DELETE FROM command_bindings').run();
    db.prepare('DELETE FROM twin_edges').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM memory_scope_bindings').run();
    db.prepare('DELETE FROM memory_scopes').run();
    db.prepare('DELETE FROM embeddings').run();
    db.prepare('DELETE FROM decisions').run();
    db.prepare('DELETE FROM record_actors').run();
  });

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    await cleanupTestDB(dbPath);
  });

  it('describe lists the whole callable surface and one contract by name', async () => {
    const all = await client.describe();
    const names = all.map((contract: ActionContract) => contract.name);
    expect(names).toContain('graph.query');
    // The owner-work WRITES moved to the product that owns that vocabulary; what the
    // core still lists is the reads over the same commitments.
    expect(names).toContain('work.list');
    expect(names).not.toContain('work.create');

    const one = await client.describe('memory.save');
    expect(one.name).toBe('memory.save');
    expect(one.inputSchema.required).toContain('topic');
  });

  it('a call round-trips socket → dispatch → commitment log → graph read', async () => {
    const created = await client.call({
      action: 'test.create',
      input: {
        topic: 'Ship the unified socket',
        summary: 'first real client call',
        set: {
          title: 'Ship the unified socket',
          status: 'pending',
          priority: 'normal',
          completionCriteria: 'client call commits over the wire',
        },
        scopes: ACCESS.scopes,
      },
    });
    expect(created.status).toBe('completed');
    if (created.status !== 'completed') {
      return;
    }
    expect(created.operationId).toMatch(/^op_/);
    const written = created.data as WorkWriteResult;

    const detail = await client.call({
      action: 'graph.query',
      input: { view: 'detail', seeds: [written.recordRef] },
    });
    expect(detail.status).toBe('completed');
    if (detail.status !== 'completed') {
      return;
    }
    const page = detail.data as { nodes: Array<{ ref: { kind: string; id: string } }> };
    expect(page.nodes.some((node) => node.ref.id === written.recordRef.id)).toBe(true);
  });

  it('retransmitting the same operationId replays to the same commitment — no second row', async () => {
    const input = {
      topic: 'Retry-safe task',
      summary: 'send once, resend identical',
      set: { title: 'Retry-safe task', status: 'pending', completionCriteria: 'one row' },
      scopes: ACCESS.scopes,
    };
    const first = await client.call({ action: 'test.create', input, operationId: 'op_retry_1' });
    const second = await client.call({ action: 'test.create', input, operationId: 'op_retry_1' });
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    if (first.status !== 'completed' || second.status !== 'completed') {
      return;
    }
    expect((second.data as WorkWriteResult).commitmentId).toBe(
      (first.data as WorkWriteResult).commitmentId
    );
    expect(
      (getAdapter().prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n
    ).toBe(1);
  });

  it('input.commandId that disagrees with operationId is COMMAND_CONFLICT before anything writes', async () => {
    const result = await client.call({
      action: 'test.create',
      operationId: 'op_conflict_1',
      input: {
        topic: 'conflicting ids',
        summary: 'two different ids for one call',
        commandId: 'cmd_someone_else',
        set: { title: 'x', status: 'pending' },
      },
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') {
      return;
    }
    expect(result.error.code).toBe('COMMAND_CONFLICT');
    expect(
      (getAdapter().prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n
    ).toBe(0);
  });

  it('an unresolvable credential is denied before reaching the action', async () => {
    const bad = createClient({ socketPath, journalPath, credential: 'forged-credential' });
    const result = await bad.call({
      action: 'test.create',
      input: { topic: 'x', summary: 'x', set: { status: 'pending' } },
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') {
      return;
    }
    expect(result.error.kind).toBe('denied');
  });

  it('unknown action returns unknown_action through the wire', async () => {
    const result = await client.call({ action: 'memory.delete_everything', input: {} });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') {
      return;
    }
    expect(result.error.kind).toBe('unknown_action');
  });

  it('a disconnect after the write reports unknown — and the commit still landed', async () => {
    // A dedicated server so the shared fixture keeps serving later tests.
    const dyingSocket = join(dir, 'dying.sock');
    const dyingCatalog = createCatalog([
      ...coreActionRegistrations(knowledge, getAdapter()),
      makeSlowCommit(knowledge),
    ]);
    const dyingServer = await makeServer(dyingSocket, createDispatcher(dyingCatalog), dyingCatalog);
    const dying = createClient({
      socketPath: dyingSocket,
      journalPath,
      credential: GOOD_CREDENTIAL,
    });

    const pending = dying.call({ action: 'test.slowcommit', input: { delayMs: 250 } });
    await sleep(60);
    await dyingServer.close();

    const result = (await pending) as ActionResult;
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') {
      return;
    }
    const operationId = result.operationId;
    expect(operationId).toBeDefined();

    // The dispatch kept running after the socket died — the command bound and committed.
    const bound = getAdapter()
      .prepare('SELECT record_id FROM judgment_commands WHERE command_id = ?')
      .get(operationId) as { record_id: string } | undefined;
    expect(bound).toBeDefined();
    expect(
      (getAdapter().prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n
    ).toBe(1);

    // The unknown answer settles through operation.get — the receipt proves
    // the commit, and the commitment id agrees with what the write returned.
    const lookup = await client.getOperation(operationId as string);
    expect(lookup.status).toBe('completed');
    if (lookup.status !== 'completed') {
      return;
    }
    const operation = lookup.data as {
      action: string;
      receipt: { work?: { commitmentId: string } } | null;
    };
    expect(operation.action).toBe('judgment.append');
    expect(operation.receipt?.work?.commitmentId).toBeDefined();
  });

  it('getOperation returns the bound record of a completed call', async () => {
    const created = await client.call({
      action: 'test.create',
      operationId: 'op_lookup_1',
      input: {
        topic: 'lookup me',
        summary: 'the operation record should name this command',
        set: { title: 'lookup me', status: 'pending' },
        scopes: ACCESS.scopes,
      },
    });
    expect(created.status).toBe('completed');
    if (created.status !== 'completed') {
      return;
    }
    const written = created.data as WorkWriteResult;

    const found = await client.getOperation('op_lookup_1');
    expect(found.status).toBe('completed');
    if (found.status !== 'completed') {
      return;
    }
    const operation = found.data as {
      operationId: string;
      action: string;
      principalId: string;
      receiptKind: string | null;
      receiptKey: string | null;
      receipt: {
        recordId: string;
        work?: { commitmentId: string; revision: number };
      } | null;
    };
    expect(operation.operationId).toBe('op_lookup_1');
    expect(operation.principalId).toBe(ACCESS.principalId);
    expect(operation.receiptKind).toBe('judgment');
    expect(operation.receipt?.work?.commitmentId).toBe(written.commitmentId);
  });

  it('an operationId that is absent or not yours answers unavailable — existence stays hidden', async () => {
    const absent = await client.getOperation('op_never_issued');
    expect(absent.status).toBe('failed');
    if (absent.status === 'failed') {
      expect(absent.error.code).toBe('OPERATION_UNAVAILABLE');
    }

    await client.call({
      action: 'test.create',
      operationId: 'op_mine_hidden',
      input: {
        topic: 'mine',
        summary: 'bound to principal-test',
        set: { title: 'mine', status: 'pending' },
        scopes: ACCESS.scopes,
      },
    });
    const other = createClient({ socketPath, journalPath, credential: OTHER_CREDENTIAL });
    const denied = await other.getOperation('op_mine_hidden');
    expect(denied.status).toBe('failed');
    if (denied.status === 'failed') {
      expect(denied.error.code).toBe('OPERATION_UNAVAILABLE');
    }
  });

  it('a missing socket reports failed — nothing was ever sent', async () => {
    const absent = createClient({
      socketPath: join(dir, 'absent.sock'),
      journalPath,
      credential: GOOD_CREDENTIAL,
    });
    const result = await absent.call({
      action: 'test.create',
      input: { topic: 'x', summary: 'x', set: { status: 'pending' } },
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') {
      return;
    }
    expect(result.error.code).toBe('ipc_unavailable');
  });

  it('the journal names the operation before the wire ever sees it', async () => {
    const result = await client.call({
      action: 'test.create',
      input: {
        topic: 'journaled',
        summary: 'journal before send',
        set: { title: 'journaled', status: 'pending' },
        scopes: ACCESS.scopes,
      },
    });
    expect(result.status).toBe('completed');
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n');
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const mine = entries.find((entry) => entry.operationId === result.operationId);
    expect(mine).toBeDefined();
    expect(mine?.action).toBe('test.create');
    expect(mine?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a request frame split across partial writes still answers', async () => {
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const requestId = newRequestId();
    const frame = encodeFrame({ requestId, kind: 'describe', credential: GOOD_CREDENTIAL });
    socket.write(frame.subarray(0, 9));
    await sleep(40);
    socket.write(frame.subarray(9));

    const response = (await readOneFrame(socket)) as { requestId: string; ok: boolean };
    expect(response.requestId).toBe(requestId);
    expect(response.ok).toBe(true);
    socket.destroy();
  });

  it('sessionFacts lands in context.session — composed server-side, never from the payload', async () => {
    let seen: { session?: unknown; access?: unknown } = {};
    const echoCatalog = createCatalog([
      {
        contract: {
          name: 'test.echo_session',
          summary: 'test-only: echoes the host-composed session facts',
          inputSchema: { type: 'object', additionalProperties: true },
        },
        exec: (_input, context) => {
          seen = { session: context.session, access: context.access };
          return { ok: true };
        },
      },
    ]);
    const factsSocket = join(dir, 'facts.sock');
    const factsServer = await createActionIpcServer({
      socketPath: factsSocket,
      catalog: echoCatalog,
      dispatch: createDispatcher(echoCatalog),
      resolveAccess: () => ACCESS,
      sessionFacts: (access, request) => ({
        toolName: request.action,
        gatewayCallId: request.requestId,
        envelopeHash: `session:${request.credential}`,
        nativeCaller: request.session?.nativeCaller,
      }),
    });
    const factsClient = createClient({
      socketPath: factsSocket,
      journalPath,
      credential: GOOD_CREDENTIAL,
    });
    const result = await factsClient.call({
      action: 'test.echo_session',
      input: { forged: 'session facts cannot ride the payload' },
      session: {
        nativeCaller: {
          session_id: 'native-session',
          tool_use_id: 'native-call',
          agent_id: 'child',
        },
      },
    });
    await factsServer.close();

    expect(result.status).toBe('completed');
    const session = seen.session as {
      toolName?: string;
      gatewayCallId?: string;
      envelopeHash?: string;
    };
    expect(session.toolName).toBe('test.echo_session');
    expect(session.gatewayCallId).toBeTruthy();
    expect(session.envelopeHash).toBe(`session:${GOOD_CREDENTIAL}`);
    expect(seen.session).toMatchObject({
      nativeCaller: { session_id: 'native-session', tool_use_id: 'native-call', agent_id: 'child' },
    });
    expect((seen.access as { principalId: string }).principalId).toBe(ACCESS.principalId);
  });

  // A call over the socket used to leave NO receipt: the row was written by the
  // host's gateway tool executor, and a program reaching an action through the
  // client never passed through it. Lane verification reads exactly those rows,
  // so work done the newer way could only read as unproven. The receipt is a
  // dispatcher port now, which is the one place both callers pass.
  it('a call over the socket leaves a receipt carrying the server-composed facts', async () => {
    const observed: Array<{ action: string; status: string; session: unknown }> = [];
    const echoCatalog = createCatalog([
      {
        contract: {
          name: 'test.echo_session',
          summary: 'test-only: a call worth a receipt',
          inputSchema: { type: 'object', additionalProperties: true },
        },
        exec: () => ({ ok: true }),
      },
    ]);
    const receiptSocket = join(dir, 'receipt.sock');
    const receiptServer = await createActionIpcServer({
      socketPath: receiptSocket,
      catalog: echoCatalog,
      dispatch: createDispatcher(echoCatalog, {
        observeCall: ({ action, result, context }) => {
          observed.push({ action, status: result.status, session: context.session });
          return `trace_${observed.length}`;
        },
      }),
      resolveAccess: () => ACCESS,
      sessionFacts: (_access, request) => ({
        toolName: request.action,
        gatewayCallId: request.requestId,
      }),
    });
    const receiptClient = createClient({
      socketPath: receiptSocket,
      journalPath,
      credential: GOOD_CREDENTIAL,
    });
    const result = await receiptClient.call({ action: 'test.echo_session', input: {} });
    const denied = await receiptClient.call({ action: 'work.list', input: {} });
    await receiptServer.close();

    expect(result.status).toBe('completed');
    // The receipt points back at itself, so the caller can read its own run.
    expect(result.experienceRef).toBe('trace_1');
    expect(observed[0]?.action).toBe('test.echo_session');
    expect((observed[0]?.session as { gatewayCallId?: string }).gatewayCallId).toBeTruthy();
    // A refusal is a call too, and it is the one most worth reading back.
    expect(denied.status).toBe('failed');
    expect(observed[1]).toMatchObject({ action: 'work.list', status: 'failed' });
  });

  it('a socket without sessionFacts dispatches with access alone — no fabricated facts', async () => {
    let seen: unknown = 'unset';
    const echoCatalog = createCatalog([
      {
        contract: {
          name: 'test.echo_absent',
          summary: 'test-only: observes an absent session',
          inputSchema: { type: 'object', additionalProperties: true },
        },
        exec: (_input, context) => {
          seen = context.session;
          return { ok: true };
        },
      },
    ]);
    const bare = join(dir, 'bare.sock');
    const bareServer = await makeServer(bare, createDispatcher(echoCatalog), echoCatalog);
    const bareClient = createClient({
      socketPath: bare,
      journalPath,
      credential: GOOD_CREDENTIAL,
    });
    await bareClient.call({ action: 'test.echo_absent', input: {} });
    await bareServer.close();
    expect(seen).toBeUndefined();
  });
});
