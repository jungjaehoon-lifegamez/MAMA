import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { expect, it, vi } from 'vitest';
import {
  createPrincipalRepository,
  exportPrincipalRecords,
  erasePrincipalRecords,
  type ActionResult,
  type ErasureStoreCount,
} from '@jungjaehoon/mama-core';
import { fixture, roots } from '../helpers/member-runtime.js';
import { memberPaths, memberClaudeTmpDir } from '../../src/runtime/member-paths.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import { OWNER_FILE_MAX_UPLOAD_BYTES, validateWorkspaceFile } from '../../src/api/file-delivery.js';
import Database from '../../src/storage-sqlite.js';
import { RawStore } from '../../src/storage/source-archive.js';

interface FixtureData {
  id: string;
  recordId?: string;
  confirmationToken: string;
  status: string;
  counts: Record<string, unknown>;
  fileCount: number;
  fileBytes: number;
}
const data = (r: ActionResult): FixtureData => {
  expect(r.status, JSON.stringify(r)).toBe('completed');
  return (r as { data: FixtureData }).data;
};
async function setup() {
  const uploads: Array<{ bytes: Buffer; principal: string; operationId: string }> = [];
  const receipts: Array<{ text: string; principal: string; operationId: string }> = [];
  const telegram = {
    sendFile: vi.fn(async (path, _caption, operationId, member) => {
      const file = validateWorkspaceFile(member.filesRoot, path, OWNER_FILE_MAX_UPLOAD_BYTES, true);
      uploads.push({
        bytes: fs.readFileSync(file.path),
        principal: member.access.principalId,
        operationId,
      });
      return { sentAs: 'document' as const, size: file.size, messageId: 'fixture-accepted' };
    }),
    sendMemberText: vi.fn(async (access, text, operationId) => {
      receipts.push({ text, principal: access.principalId, operationId });
      return true;
    }),
  };
  const f = await fixture('codex', true, false, 'UTC', telegram, `fixture-member-${randomUUID()}`);
  const paths = memberPaths(f.root, f.member);
  const put = (path: string, text = 'fixture bytes') => {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, text);
  };
  put(join(paths.workspaceDir, 'files', 'personal.txt'));
  put(join(paths.codexHome, 'auth.json'), 'fixture credential');
  put(join(paths.workspaceDir, 'files', 'temp', 'report.xlsx'), 'fixture report');
  put(join(paths.workspaceDir, 'files', 'config.yaml'), 'fixture config');
  put(join(paths.workspaceDir, 'files', 'runtime', 'session-credential'), 'fixture member file');
  put(join(paths.workspaceDir, 'files', 'member-export-00000000-0000-0000-0000-000000000002.zip'));
  const temp = memberClaudeTmpDir(f.member);
  roots.push(temp);
  put(join(temp, 'transcript.jsonl'));
  put(join(paths.workspaceDir, '.tmp', 'omitted.txt'));
  const suffix = '00000000-0000-0000-0000-000000000001';
  const archive = join(f.root, `.retired-${f.member}-${suffix}`);
  put(join(archive, 'runtime', 'workspace', 'archived.txt'));
  put(join(archive, 'runtime', '.codex', 'auth.json'), 'fixture credential');
  put(join(archive, 'runtime', 'runtime', 'session-credential'), 'fixture credential');
  put(
    join(archive, 'runtime', 'workspace', 'files', 'temp', 'report.xlsx'),
    'fixture retired report'
  );
  put(join(archive, 'runtime', 'workspace', 'files', 'config.yaml'), 'fixture retired config');
  put(join(archive, 'runtime', 'workspace', '.tmp', 'omitted.txt'));
  const tempArchive = join(dirname(temp), `.retired-${temp.split('/').at(-1)}-${suffix}`);
  roots.push(tempArchive);
  put(join(tempArchive, 'archived-temp.txt'));
  const neighbor = join(f.root, `.retired-${f.member}-extra-${suffix}`);
  put(join(neighbor, 'keep.txt'));
  put(join(f.home, 'workspace', 'owner.txt'), 'owner bytes');
  f.ledger.claim('owner-entry', {
    deliveryTarget: 'telegram:fixture-owner',
    payloadIdentity: 'a'.repeat(64),
  });
  f.ledger.markDelivered('owner-entry');
  f.ledger.claim('member-entry', {
    deliveryTarget: `telegram:${f.memberDm}`,
    payloadIdentity: 'a'.repeat(64),
  });
  f.ledger.markDelivered('member-entry');
  f.ledger.claim(`telegram:${f.memberDm}:123`);
  await f.settled(f.message('owner', 'owner chat'));
  const preview = async () => data((await f.act('records.erase')).result);
  const confirm = async (token: string) =>
    data((await f.act('records.erase', { confirmationToken: token })).result);
  const finish = async () => {
    await vi.waitFor(() => expect(receipts.length).toBeGreaterThan(0));
    const { text, operationId } = receipts.at(-1)!;
    expect(text).not.toMatch(/^\s*\{/);
    expect(text).toContain('Your enrollment and grants are kept.');
    const commandId = operationId.replace(/:receipt$/, '');
    const row = f.runtime.database.adapter
      .prepare('SELECT counts_json FROM principal_erasure_receipts WHERE command_id=?')
      .get(commandId) as { counts_json: string } | undefined;
    const core: Record<string, ErasureStoreCount> = Object.fromEntries(
      Object.keys(row ? JSON.parse(row.counts_json) : {}).map((name) => [
        name,
        { deleted: 0, tombstoned: 0, wiped: 0, in_flight: 0 },
      ])
    );
    const product: Record<string, number> = {};
    for (const line of text.split('\n')) {
      const count = /^([a-z_]+): (.+)\.$/.exec(line);
      if (!count) continue;
      for (const [, n, action] of count[2].matchAll(
        /(\d+) (deleted|tombstoned|wiped|in flight)/g
      )) {
        if (core[count[1]])
          core[count[1]][action.replace(' ', '_') as keyof ErasureStoreCount] = Number(n);
        else product[count[1]] = Number(n);
      }
    }
    const file = /^Files: (\d+) files, (\d+) bytes\.$/m.exec(text);
    expect(file).not.toBeNull();
    product.files = Number(file![1]);
    product.fileBytes = Number(file![2]);
    const failed = /^Erasure stopped at (.+?): (.+)\.$/m.exec(text);
    const failedStep =
      failed?.[1] === 'native session retirement' ? 'retire' : failed?.[1].replaceAll(' ', '_');
    if (failed) {
      expect(text).toContain('Earlier steps are done.');
      expect(text).toContain('Make a new erasure request');
    } else expect(text).toMatch(/^Your personal records and files were erased\./);
    return {
      text,
      commandId,
      status: failed ? 'failed' : 'erased',
      failedStep,
      error: failed?.[2],
      core,
      product,
    };
  };
  const dispatch = (
    principalId: string,
    ref: string,
    action = 'records.erase',
    input: unknown = {},
    extra = {}
  ) =>
    f.runtime.surface.dispatch(
      { action, input },
      {
        access:
          principalId === 'owner'
            ? f.runtime.surface.ownerAccess
            : resolvePrincipalAccess(principalId, {
                adapter: f.runtime.database.adapter,
                ownerAccess: f.runtime.surface.ownerAccess,
                agentId: 'fixture-agent',
              }),
        session: { sourceMessageRef: ref, ...extra },
      }
    );
  return {
    ...f,
    telegram,
    uploads,
    receipts,
    paths,
    put,
    temp,
    archive,
    tempArchive,
    neighbor,
    preview,
    confirm,
    finish,
    dispatch,
  };
}

it('exports core and product rows and regular files, excluding credentials and prior zips', async () => {
  const f = await setup();
  const r = data((await f.act('records.export')).result);
  expect(f.uploads).toHaveLength(1);
  expect(f.uploads[0].principal).toBe(f.member);
  const zip = unzipSync(f.uploads[0].bytes);
  const core = JSON.parse(strFromU8(zip['core.json']));
  const product = JSON.parse(strFromU8(zip['product.json']));
  expect(core.counts).toEqual(
    Object.fromEntries(
      Object.entries(core.stores).map(([name, rows]) => [name, (rows as unknown[]).length])
    )
  );
  expect(product.counts).toEqual(
    Object.fromEntries(
      Object.entries(product.stores).map(([name, rows]) => [name, (rows as unknown[]).length])
    )
  );
  expect(r.counts).toEqual({ core: core.counts, product: product.counts });
  expect(core.counts.decisions).toBe(
    exportPrincipalRecords(f.runtime.database.adapter, f.member).counts.decisions
  );
  const keys = Object.keys(zip).join('\n');
  expect(keys).toContain('personal.txt');
  expect(zip[`files/${f.member}/workspace/files/temp/report.xlsx`]).toBeDefined();
  expect(zip[`files/${f.member}/workspace/files/config.yaml`]).toBeDefined();
  expect(zip[`files/${f.member}/workspace/files/runtime/session-credential`]).toBeDefined();
  expect(zip[`files/${f.member}/runtime/session-credential`]).toBeUndefined();
  expect(
    zip[`files/${f.archive.split('/').at(-1)}/runtime/workspace/files/temp/report.xlsx`]
  ).toBeDefined();
  expect(
    zip[`files/${f.archive.split('/').at(-1)}/runtime/workspace/files/config.yaml`]
  ).toBeDefined();
  expect(
    zip[`files/${f.archive.split('/').at(-1)}/runtime/runtime/session-credential`]
  ).toBeUndefined();
  expect(fs.existsSync((r as FixtureData & { path: string }).path)).toBe(false);
  expect(keys).toContain('archived.txt');
  expect(keys).toContain('transcript.jsonl');
  expect(keys).toContain('archived-temp.txt');
  expect(keys).not.toMatch(/\.codex\/auth.json|member-export-00000000|keep.txt|omitted.txt/);
  expect(strFromU8(zip['product.json'])).not.toContain('owner chat');
  expect(Object.values(zip).some((bytes) => strFromU8(bytes).includes('fixture credential'))).toBe(
    false
  );
});

it.each(['owner', 'delta', 'scheduled', 'replay', 'subagent', 'unknown-ref'])(
  'denies %s and lists actions only for the member',
  async (origin) => {
    const f = await setup();
    data((await f.act('records.export')).result); // positive control fails before P9
    const own = f.message(f.member);
    await f.settled(own, f.member);
    const mailbox = f.runtime.runtime.mailbox!;
    const ref =
      origin === 'subagent'
        ? 'subagent:fixture'
        : origin === 'unknown-ref'
          ? 'missing'
          : origin === 'delta' || origin === 'scheduled'
            ? 'fixture-other'
            : own;
    if (ref === 'fixture-other')
      mailbox.enqueue({
        id: ref,
        principalId: f.member,
        kind: origin === 'delta' ? 'source_delta' : 'scheduled',
        channelKey: 'fixture',
        occurredAt: Date.now(),
      });
    for (const action of ['records.export', 'records.erase']) {
      expect(
        await f.dispatch(
          origin === 'owner' ? 'owner' : f.member,
          ref,
          action,
          {},
          origin === 'replay' ? { replaySourceEndMs: 1 } : {}
        )
      ).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
    }
    const memberHelp = JSON.stringify(data(await f.dispatch(f.member, own, 'help')));
    const ownerHelp = JSON.stringify(data(await f.dispatch('owner', own, 'help')));
    expect(memberHelp).toContain('records.export');
    expect(memberHelp).toContain('records.erase');
    expect(ownerHelp).not.toContain('records.export');
    expect(ownerHelp).not.toContain('records.erase');
  }
);

it('binds and replaces tokens and refuses issuing, pre-issued, foreign and used confirmations', async () => {
  const f = await setup();
  const early = f.message(f.member);
  await f.settled(early, f.member);
  const issued = await f.act('records.erase');
  const first = data(issued.result);
  const second = await f.preview();
  for (const [ref, token] of [
    [issued.ref, first.confirmationToken],
    [early, second.confirmationToken],
  ])
    expect(
      await f.dispatch(f.member, ref, 'records.erase', { confirmationToken: token })
    ).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
  const same = await f.act('records.erase');
  const token = data(same.result).confirmationToken;
  expect(
    await f.dispatch(f.member, same.ref, 'records.erase', { confirmationToken: token })
  ).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
  const other = createPrincipalRepository(f.runtime.database.adapter).registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-other',
    now: 4,
  });
  const otherRef = f.message(other);
  await f.settled(otherRef, other);
  expect(
    await f.dispatch(other, otherRef, 'records.erase', { confirmationToken: token })
  ).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
  expect(await f.confirm(token)).toMatchObject({ status: 'scheduled' });
  await f.finish();
  const later = f.message(f.member);
  await f.settled(later, f.member);
  expect(
    await f.dispatch(f.member, later, 'records.erase', { confirmationToken: token })
  ).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
});

it('erases after settlement, preserves owner and shared rows, receipts counts and starts a fresh session', async () => {
  const f = await setup();
  const db = f.runtime.database.adapter;
  const saved = data(
    (
      await f.act('memory.save', {
        topic: 'fixture',
        kind: 'decision',
        summary: 'fixture personal',
        details: 'fixture evidence',
        source: { package: 'fixture', source_type: 'fixture' },
      })
    ).result
  );
  const cited = data(
    (
      await f.act('memory.save', {
        topic: 'fixture-cited',
        kind: 'decision',
        summary: 'fixture cited content',
        details: 'fixture evidence',
        source: { package: 'fixture', source_type: 'fixture' },
      })
    ).result
  );
  const ownerSave = data(
    await f.runtime.surface.hostToolCall(
      'memory.save',
      {
        topic: 'fixture-owner',
        kind: 'decision',
        summary: 'owner summary',
        details: 'fixture evidence',
        source: { package: 'fixture', source_type: 'fixture' },
      },
      'fixture-owner-save'
    )
  );
  db.prepare('UPDATE decisions SET source_refs_json=? WHERE id=?').run(
    JSON.stringify([`memory:${cited.id}`]),
    ownerSave.id
  );
  const shared = data(
    await f.runtime.surface.hostToolCall(
      'work.create',
      { topic: 'fixture-work', summary: 'fixture work', set: { title: 'fixture work' } },
      'fixture-work'
    )
  );
  // Shared revisions attributed to the member remain byte-for-byte unchanged.
  db.prepare('UPDATE command_bindings SET principal_id=? WHERE command_id=?').run(
    f.member,
    'fixture-work'
  );
  const sharedBefore = db.prepare('SELECT * FROM commitment_assignments').all();
  const ownerBefore = db
    .prepare(
      "SELECT * FROM connector_event_index WHERE memory_scope_kind='user' AND memory_scope_id='owner'"
    )
    .all();
  const workTotal = db.prepare('SELECT count(*) AS n FROM commitments').get();
  const ledgerOwner = f.ledger.get('owner-entry');
  const rawStore = new RawStore(join(f.home, 'raw'));
  try {
    for (const principal of [f.member, 'owner'])
      rawStore.save(
        'chat',
        [
          {
            source: 'chat',
            sourceId: `fixture-pending-${principal}`,
            channel: 'fixture',
            author: principal,
            content: 'fixture pending payload',
            timestamp: new Date(),
            type: 'message',
            memoryScopeKind: 'user',
            memoryScopeId: principal,
          },
        ],
        { collectOnly: true }
      );
  } finally {
    rawStore.close();
  }
  const rawBefore = new Database(join(f.home, 'raw', 'chat', 'raw.db'));
  const ownerRaw = rawBefore.prepare("SELECT * FROM raw_items WHERE memory_scope_id='owner'").all();
  const memberRaw = rawBefore
    .prepare('SELECT source_id FROM raw_items WHERE memory_scope_id=?')
    .all(f.member) as Array<{ source_id: string }>;
  const ownerPending = rawBefore
    .prepare(
      "SELECT * FROM pending_core_projections WHERE json_extract(payload_json,'$.memoryScopeId')='owner'"
    )
    .all();
  rawBefore.close();
  const p = await f.preview();
  const oldSession = f.turns.at(-1)!.session;
  const oldPoolSession = f.pool.getSessionInfo(`member:${f.member}:runtime`)!.sessionId;
  expect(p.fileCount).toBeGreaterThan(0);
  expect(p.fileBytes).toBeGreaterThan(0);
  expect(await f.confirm(p.confirmationToken)).toMatchObject({ status: 'scheduled' });
  const receipt = await f.finish();
  expect(receipt.status).toBe('erased');
  const coreReceipt = erasePrincipalRecords(db, {
    principalId: f.member,
    commandId: receipt.commandId,
  });
  expect(receipt.core).toEqual(coreReceipt.counts);
  const exportedFiles = Object.entries(unzipSync(f.uploads[0].bytes)).filter(([name]) =>
    name.startsWith('files/')
  );
  expect(receipt.product.files).toBe(exportedFiles.length);
  expect(receipt.product.fileBytes).toBe(
    exportedFiles.reduce((n, [, bytes]) => n + bytes.length, 0)
  );
  expect(receipt.text).not.toContain('principal_erasure_receipts: 0');
  expect(Object.values(coreReceipt.counts).every((count) => count.in_flight === 0)).toBe(true);
  const erasedCited = db
    .prepare('SELECT erased_at, summary FROM decisions WHERE id=?')
    .get(cited.id) as { erased_at: number; summary: string | null };
  expect(erasedCited.erased_at).toBeGreaterThan(0);
  expect(erasedCited.summary).toBeNull();
  expect(receipt.product.connector_event_index).toBeGreaterThan(0);
  const exportedProduct = JSON.parse(strFromU8(unzipSync(f.uploads[0].bytes)['product.json']));
  expect(receipt.product.raw_items).toBe(exportedProduct.counts.raw_items);
  expect(receipt.product.connector_event_index).toBe(exportedProduct.counts.connector_event_index);
  expect(receipt.product.pending_core_projections).toBe(1);
  expect(receipt.product.message_ledger).toBe(2);
  expect(f.ledger.get('member-entry')).toBeNull();
  expect(f.ledger.get(`telegram:${f.memberDm}:123`)).toBeNull();
  expect(f.ledger.get('owner-entry')).toEqual(ledgerOwner);
  expect(db.prepare('SELECT count(*) AS n FROM commitments').get()).toEqual(workTotal);
  expect(db.prepare('SELECT * FROM commitment_assignments').all()).toEqual(sharedBefore);
  expect(
    db
      .prepare(
        "SELECT * FROM connector_event_index WHERE memory_scope_kind='user' AND memory_scope_id='owner'"
      )
      .all()
  ).toEqual(ownerBefore);
  expect(
    db.prepare('SELECT id FROM decisions WHERE id=?').get(saved.id ?? saved.recordId)
  ).toBeUndefined();
  expect(
    db.prepare('SELECT id FROM decisions WHERE id=?').get(ownerSave.id ?? ownerSave.recordId)
  ).toBeDefined();
  expect(shared).toBeDefined();
  for (const path of [f.archive, f.tempArchive, f.temp]) expect(fs.existsSync(path)).toBe(false);
  expect(fs.readFileSync(join(f.home, 'workspace', 'owner.txt'), 'utf8')).toBe('owner bytes');
  expect(fs.existsSync(f.neighbor)).toBe(true);
  expect(fs.existsSync(join(f.paths.workspaceDir, 'files', 'personal.txt'))).toBe(false);
  expect([...f.pool.listSessions().values()].some((s) => s.sessionId === oldPoolSession)).toBe(
    false
  );
  const chatReceipt = db
    .prepare(
      "SELECT * FROM connector_event_index WHERE memory_scope_id=? AND json_extract(metadata_json,'$.deliveryVerified')=1"
    )
    .all(f.member) as Array<{ content: string }>;
  expect(chatReceipt.some((r) => r.content === f.receipts.at(-1)!.text)).toBe(true);
  const raw = new Database(join(f.home, 'raw', 'chat', 'raw.db'));
  try {
    expect(
      raw
        .prepare(
          "SELECT count(*) AS n FROM raw_items WHERE memory_scope_id=? AND content='fixture personal'"
        )
        .get(f.member)
    ).toEqual({ n: 0 });
    for (const row of memberRaw)
      expect(
        raw.prepare('SELECT * FROM raw_items WHERE source_id=?').get(row.source_id)
      ).toBeUndefined();
    expect(raw.prepare("SELECT * FROM raw_items WHERE memory_scope_id='owner'").all()).toEqual(
      ownerRaw
    );
    expect(
      raw
        .prepare(
          "SELECT * FROM pending_core_projections WHERE json_extract(payload_json,'$.memoryScopeId')='owner'"
        )
        .all()
    ).toEqual(ownerPending);
    expect(
      raw
        .prepare(
          "SELECT * FROM pending_core_projections WHERE json_extract(payload_json,'$.memoryScopeId')=?"
        )
        .all(f.member)
    ).toEqual([]);
  } finally {
    raw.close();
  }
  await f.settled(f.message(f.member), f.member);
  expect(f.turns.at(-1)!.fresh).toBe(true);
  expect(f.turns.at(-1)!.session).not.toBe(oldSession);
  expect(
    fs
      .readdirSync(f.paths.workspaceDir)
      .filter((name) => name !== '.git' && name !== '.claude' && name !== '.tmp')
  ).toEqual([]);
  expect(fs.readdirSync(join(f.paths.workspaceDir, '.tmp'))).toEqual([]);
  const binding = db
    .prepare(
      'SELECT command_id FROM judgment_commands WHERE record_id IS NULL AND erased_at IS NOT NULL LIMIT 1'
    )
    .get() as { command_id: string };
  expect(binding).toBeDefined();
  const result = await f.runtime.surface.dispatch(
    {
      action: 'memory.save',
      input: {
        topic: 'fixture',
        kind: 'decision',
        summary: 'fixture personal',
        details: 'fixture evidence',
        source: { package: 'fixture', source_type: 'fixture' },
      },
      operationId: binding.command_id,
    },
    {
      access: resolvePrincipalAccess(f.member, {
        adapter: db,
        ownerAccess: f.runtime.surface.ownerAccess,
        agentId: 'fixture-agent',
      }),
    }
  );
  expect(result).toMatchObject({
    status: 'failed',
    error: { message: expect.stringContaining('erased') },
  });
  expect(
    db.prepare('SELECT id FROM decisions WHERE id=?').get(saved.id ?? saved.recordId)
  ).toBeUndefined();
});

it.each(['failed', 'oversize'])(
  'a %s export erases nothing and serves the member again',
  async (kind) => {
    const f = await setup();
    if (kind === 'failed') f.telegram.sendFile.mockRejectedValue(new Error('fixture rejected'));
    else
      fs.writeFileSync(
        join(f.paths.workspaceDir, 'files', 'huge.bin'),
        randomBytes(OWNER_FILE_MAX_UPLOAD_BYTES + 1)
      );
    const p = await f.preview();
    const core = exportPrincipalRecords(f.runtime.database.adapter, f.member);
    expect(await f.confirm(p.confirmationToken)).toMatchObject({ status: 'scheduled' });
    const receipt = await f.finish();
    expect(receipt.status).toBe('failed');
    expect(receipt.failedStep).toBe('export_delivery');
    if (kind === 'oversize') {
      expect(receipt.error).toMatch(/\d+ bytes/);
      expect(f.telegram.sendFile).not.toHaveBeenCalled();
    }
    expect(
      fs
        .readdirSync(join(f.paths.workspaceDir, 'files'))
        .filter(
          (name) =>
            name.startsWith('member-export-') &&
            name !== 'member-export-00000000-0000-0000-0000-000000000002.zip'
        )
    ).toEqual([]);
    expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(true);
    expect(fs.readFileSync(join(f.paths.workspaceDir, 'files', 'personal.txt'), 'utf8')).toBe(
      'fixture bytes'
    );
    expect(f.ledger.get('member-entry')).not.toBeNull();
    expect(exportPrincipalRecords(f.runtime.database.adapter, f.member).counts.decisions).toBe(
      core.counts.decisions
    );
    expect(
      f.runtime.database.adapter.prepare('SELECT * FROM principal_erasure_receipts').all()
    ).toEqual([]);
  }
);

it('prevents pending and claimed waiters from starting a turn or escaping the drain after deletion', async () => {
  const f = await setup();
  const p = await f.preview();
  let release!: () => void;
  f.blockMember(
    new Promise<void>((r) => {
      release = r;
    })
  );
  const before = f.turns.filter((t) => t.principal === f.member).length + 1;
  const confirming = f.act('records.erase', { confirmationToken: p.confirmationToken });
  await vi.waitFor(() =>
    expect(f.turns.filter((t) => t.principal === f.member)).toHaveLength(before)
  );
  // Wait until confirmation's native turn starts, then queue another delivery behind it.
  const queued = f.message(f.member);
  f.runtime.runtime.mailbox!.enqueue({
    id: 'fixture-pending-after-confirm',
    kind: 'owner_message',
    principalId: f.member,
    channelKey: 'fixture',
    occurredAt: Date.now(),
    payload: { text: 'pending' },
  });
  await vi.waitFor(() =>
    expect(f.runtime.runtime.mailbox!.readInput(queued, f.member)?.status).toBe('claimed')
  );
  release();
  f.blockMember(undefined);
  expect(data((await confirming).result).status).toBe('scheduled');
  await f.finish();
  await vi.waitFor(() => expect(f.runtime.runtime.mailbox!.readInput(queued, f.member)).toBeNull());
  expect(f.turns.filter((t) => t.principal === f.member)).toHaveLength(before);
  expect(
    f.runtime.runtime.mailbox!.readInput('fixture-pending-after-confirm', f.member)
  ).toBeNull();
  await expect(f.runtime.runtime.drainOnce()).resolves.toBeDefined();
});

it('reports the failed deletion step, restores serving, and a new confirmation finishes remaining stores', async () => {
  const f = await setup();
  const p = await f.preview();
  const rm = fs.rmSync;
  const crash = vi.spyOn(fs, 'rmSync').mockImplementation((path, opts) => {
    if (path === f.paths.runtimeRoot) throw new Error('fixture file deletion failed');
    return rm(path, opts);
  });
  syncBuiltinESMExports();
  await f.confirm(p.confirmationToken);
  const failed = await f.finish();
  expect(failed).toMatchObject({ status: 'failed', failedStep: 'files' });
  expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(true);
  crash.mockRestore();
  syncBuiltinESMExports();
  f.receipts.length = 0;
  const next = await f.preview();
  await f.confirm(next.confirmationToken);
  expect((await f.finish()).status).toBe('erased');
  expect(fs.existsSync(join(f.paths.workspaceDir, 'files', 'personal.txt'))).toBe(false);
});

it('rejects a symlinked export output before writing any private ZIP outside the member tree', async () => {
  const f = await setup();
  data((await f.act('records.export')).result);
  const files = join(f.paths.workspaceDir, 'files');
  fs.rmSync(files, { recursive: true });
  const outside = join(f.home, 'workspace');
  const before = fs.readdirSync(outside);
  fs.symlinkSync(outside, files);
  expect((await f.act('records.export')).result.status).toBe('failed');
  expect(fs.readdirSync(outside)).toEqual(before);
});

it.each(['resetSession', 'stop'] as const)(
  'restores actual serving and permits a later turn after native %s fails',
  async (method) => {
    const f = await setup();
    const preview = await f.preview();
    vi.spyOn(f.natives.get(f.member)!, method).mockRejectedValueOnce(
      new Error('fixture retirement failed')
    );
    await f.confirm(preview.confirmationToken);
    expect(await f.finish()).toMatchObject({ status: 'failed', failedStep: 'retire' });
    expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(true);
    await f.settled(f.message(f.member), f.member);
    expect(f.ledger.get('member-entry')).not.toBeNull();
    expect(fs.existsSync(join(f.paths.workspaceDir, 'files', 'personal.txt'))).toBe(true);
  }
);

it('refuses a higher-id message received before the preview was issued', async () => {
  const f = await setup();
  let release!: () => void;
  f.blockMember(
    new Promise<void>((r) => {
      release = r;
    })
  );
  const before = f.turns.length;
  const issuing = f.act('records.erase');
  await vi.waitFor(() => expect(f.turns.length).toBe(before + 1));
  const early = f.message(f.member);
  await vi.waitFor(() =>
    expect(f.runtime.runtime.mailbox!.readInput(early, f.member)?.status).toBe('claimed')
  );
  release();
  f.blockMember(undefined);
  const preview = data((await issuing).result);
  const issuingRow = f.runtime.runtime.mailbox!.readInput((await issuing).ref, f.member)!;
  const earlyRow = f.runtime.runtime.mailbox!.readInput(early, f.member)!;
  expect(earlyRow.id).toBeGreaterThan(issuingRow.id);
  expect(
    await f.dispatch(f.member, early, 'records.erase', {
      confirmationToken: preview.confirmationToken,
    })
  ).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
});

it('a new preview replaces the old token even in a valid later message', async () => {
  const f = await setup();
  const old = await f.preview();
  await f.preview();
  expect(
    (await f.act('records.erase', { confirmationToken: old.confirmationToken })).result
  ).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
});

it('records an unaccepted receipt as deliveryVerified=false and keeps enrollment and grants', async () => {
  const f = await setup();
  data(
    await f.manage('grant', {
      principalId: f.member,
      scopeKind: 'project',
      scopeId: 'fixture-partition',
    })
  );
  const grants = createPrincipalRepository(f.runtime.database.adapter).listActiveGrants(f.member);
  f.telegram.sendMemberText.mockImplementationOnce(async (access, text, operationId) => {
    f.receipts.push({ principal: access.principalId, text, operationId });
    return false;
  });
  const p = await f.preview();
  await f.confirm(p.confirmationToken);
  await f.finish();
  await vi.waitFor(() =>
    expect(
      f.runtime.database.adapter
        .prepare(
          "SELECT count(*) AS n FROM connector_event_index WHERE memory_scope_id=? AND json_extract(metadata_json,'$.deliveryVerified')=0"
        )
        .get(f.member)
    ).toEqual({ n: 1 })
  );
  expect(createPrincipalRepository(f.runtime.database.adapter).listActiveGrants(f.member)).toEqual(
    grants
  );
  expect(createPrincipalRepository(f.runtime.database.adapter).findById(f.member)?.status).toBe(
    'active'
  );
});

it('refuses inactive and unregistered principals and accepts no principal parameter', async () => {
  const f = await setup();
  data((await f.act('records.export')).result);
  const ref = f.message(f.member);
  await f.settled(ref, f.member);
  expect((await f.dispatch(f.member, ref, 'records.export', { principalId: 'owner' })).status).toBe(
    'failed'
  );
  createPrincipalRepository(f.runtime.database.adapter).suspend(f.member, Date.now());
  for (const id of [f.member, 'unknown']) {
    for (const action of ['records.export', 'records.erase']) {
      expect(
        await f.runtime.surface.dispatch(
          { action, input: {} },
          {
            access: {
              ...resolvePrincipalAccess('owner', {
                adapter: f.runtime.database.adapter,
                ownerAccess: f.runtime.surface.ownerAccess,
                agentId: 'fixture',
              }),
              principalId: id,
              actions: ['records.export', 'records.erase'],
            },
            session: { sourceMessageRef: ref },
          }
        )
      ).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
    }
  }
});

it('removes an export ZIP after Telegram rejects the standalone export', async () => {
  const f = await setup();
  const before = fs.readdirSync(join(f.paths.workspaceDir, 'files'));
  f.telegram.sendFile.mockRejectedValueOnce(new Error('fixture export rejected'));
  expect((await f.act('records.export')).result.status).toBe('failed');
  expect(fs.readdirSync(join(f.paths.workspaceDir, 'files'))).toEqual(before);
});

it.each(['dead', 'uncertain'] as const)(
  'clears a scheduled erasure when the confirming input ends %s and records a host receipt',
  async (outcome) => {
    const f = await setup();
    const preview = await f.preview();
    // The action has scheduled the erase; fail the runner before acceptance for dead, and fail
    // delivery after its accepted result for uncertain. All runtime/mailbox/session ports stay real.
    f.finishMemberTurn(outcome === 'dead' ? 'before_acceptance' : 'after_acceptance');
    const { ref, result } = await f.act('records.erase', {
      confirmationToken: preview.confirmationToken,
    });
    expect(data(result).status).toBe('scheduled');
    await vi.waitFor(() =>
      expect(
        outcome === 'dead'
          ? f.runtime.runtime.mailbox!.readInput(ref, f.member)?.status
          : f.runtime.runtime.mailbox!.readInput(ref, f.member)?.nativeDelivery?.state
      ).toBe(outcome)
    );
    await vi.waitFor(() => expect(f.receipts).toHaveLength(1));
    const text = f.receipts[0].text;
    expect(text).toContain('Erasure did not run because the confirming turn did not complete');
    expect(text).toContain(outcome);
    expect(text).toContain('Your enrollment and grants are kept.');
    expect(f.runtime.surface.memberRecords.isBlocked(f.member)).toBe(false);
    expect(f.uploads).toEqual([]);
    expect(
      f.runtime.database.adapter.prepare('SELECT * FROM principal_erasure_receipts').all()
    ).toEqual([]);
    await vi.waitFor(() =>
      expect(
        f.runtime.database.adapter
          .prepare(
            "SELECT content FROM connector_event_index WHERE memory_scope_id=? AND json_extract(metadata_json,'$.deliveryVerified')=1"
          )
          .all(f.member)
      ).toEqual([expect.objectContaining({ content: text })])
    );
    await f.settled(f.message(f.member), f.member);
    expect(f.turns.at(-1)!.principal).toBe(f.member);
    // A later reconcile/duplicate outcome must not resurrect the cancelled schedule or send twice.
    const row = f.runtime.runtime.mailbox!.readInput(ref, f.member)!;
    f.runtime.surface.memberRecords.onSettled(row);
    f.runtime.surface.memberRecords.onDead(row, 'fixture repeated');
    await f.runtime.surface.memberRecords.idle();
    expect(f.receipts).toHaveLength(1);
    expect(f.uploads).toEqual([]);
  }
);
