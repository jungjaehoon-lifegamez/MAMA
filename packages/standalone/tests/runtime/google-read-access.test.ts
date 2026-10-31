import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createKnowledge,
  createPrincipalRepository,
  type ActionContext,
  type ActionResult,
} from '@jungjaehoon/mama-core';

import { createActionSurface } from '../../src/runtime/action-surface.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import {
  memberRoomSessionKey,
  resolvePrincipalAccess,
} from '../../src/runtime/principal-access.js';

const COMMON = 'common-fixture';
const read = {
  service: 'gmail',
  argv: ['users', 'messages', 'list'],
  params: { userId: 'me', q: 'subject:estimate', maxResults: 5 },
};

/** Who may read Google through the host (owner, 2026-10-31): owner sessions, never members (P6). */
describe('google.read grants and traces', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof openCoreDatabase>>;
  let surface: ReturnType<typeof createActionSurface>;
  let plain: string;
  let ownerRole: string;
  let operation = 0;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'google-read-access-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    // The gws stand-in the daemon finds on its PATH.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gws'),
      `#!/bin/sh\necho '{"messages":[{"id":"m1","threadId":"t1"}],"resultSizeEstimate":1}'\n`
    );
    chmodSync(join(bin, 'gws'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    db = await openCoreDatabase({ path: process.env.MAMA_DB_PATH! });
    const repo = createPrincipalRepository(db.adapter);
    repo.ensureOwner({ principalId: COMMON, now: 1 });
    plain = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'fixture-plain-dm',
      now: 2,
    });
    ownerRole = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'fixture-owner-dm',
      now: 3,
    });
    repo.grantRole({ principalId: ownerRole, role: 'owner', now: 4 });
    surface = createActionSurface({
      adapter: db.adapter,
      knowledge: createKnowledge({ adapter: db.adapter, embedder: null }),
      runtimeRoot: join(root, 'mama'),
      configPath: join(root, 'mama', 'config.yaml'),
      ownerPrincipalId: COMMON,
      agentId: 'common-agent',
      timeZone: createTimeZoneSetting('UTC'),
      isOwnerMessageTurn: () => true,
    });
  });
  afterEach(async () => {
    await db?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const access = (principalId: string, sessionKey?: string) =>
    resolvePrincipalAccess(principalId, {
      adapter: db.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: `agent-${principalId}`,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    });
  const call = (context: Omit<ActionContext, 'operationId'>, input: unknown = read) =>
    surface.dispatch(
      { action: 'google.read', input, operationId: `fixture-${++operation}` },
      { ...context, operationId: `fixture-${operation}` }
    );
  const traces = () =>
    db.adapter
      .prepare(
        `SELECT actor_principal_id AS actor, execution_status AS status, failure_code AS failure,
                input_summary AS input
         FROM tool_traces WHERE tool_name = 'google.read' ORDER BY created_at, rowid`
      )
      .all() as Array<{ actor: string; status: string; failure: string | null; input: string }>;

  it('reads for the common session in a chat turn and in a turn with no person', async () => {
    const chat = await call({
      access: surface.ownerAccess,
      session: { sourceMessageRef: 'telegram:fixture-common-room:1' },
    });
    const delta = await call({ access: surface.ownerAccess });
    for (const result of [chat, delta])
      expect(result).toMatchObject({
        status: 'completed',
        data: { messages: [{ id: 'm1', threadId: 't1' }] },
      });
  });

  it("reads in an owner-role person's own DM", async () => {
    expect(await call({ access: access(ownerRole) })).toMatchObject({ status: 'completed' });
    expect(surface.hostToolDefinitions(access(ownerRole)).map((tool) => tool.name)).toContain(
      'google.read'
    );
  });

  it('refuses a member without the owner role, and any room session, at the grant', async () => {
    const denied: ActionResult[] = [
      await call({ access: access(plain) }),
      // A room is a group: other people read what its session reads.
      await call({ access: access(ownerRole, memberRoomSessionKey(ownerRole, 'fixture-room')) }),
      await call({ access: access(plain, memberRoomSessionKey(plain, 'fixture-room')) }),
    ];
    for (const result of denied)
      expect(result).toMatchObject({
        status: 'failed',
        error: { kind: 'denied', code: 'action_not_granted' },
      });
    expect(surface.hostToolDefinitions(access(plain)).map((tool) => tool.name)).not.toContain(
      'google.read'
    );
  });

  it('records each call in tool_traces with its argv, a refusal with its code', async () => {
    await call({ access: surface.ownerAccess });
    await call({ access: access(plain) });
    await call(
      { access: surface.ownerAccess },
      { service: 'gmail', argv: ['users', 'messages', 'send'], params: { userId: 'me' } }
    );
    const rows = traces();
    expect(rows.map(({ actor, status, failure }) => ({ actor, status, failure }))).toEqual([
      { actor: COMMON, status: 'completed', failure: null },
      { actor: plain, status: 'failed', failure: 'action_not_granted' },
      { actor: COMMON, status: 'failed', failure: 'google_method_not_allowed' },
    ]);
    expect(JSON.parse(rows[0]!.input)).toEqual(read);
    expect(JSON.parse(rows[2]!.input).argv).toEqual(['users', 'messages', 'send']);
  });
});
