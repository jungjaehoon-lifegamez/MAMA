import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
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
  commandId: string;
}
const data = (r: ActionResult): FixtureData => {
  expect(r.status, JSON.stringify(r)).toBe('completed');
  return (r as { data: FixtureData }).data;
};
async function setup() {
  const uploads: Array<{ bytes: Buffer; principal: string; operationId: string; path?: string }> =
    [];
  const receipts: Array<{ text: string; principal: string; operationId: string }> = [];
  const telegram = {
    sendFile: vi.fn(async (path, _caption, operationId, member) => {
      const file = validateWorkspaceFile(member.filesRoot, path, OWNER_FILE_MAX_UPLOAD_BYTES, true);
      uploads.push({
        bytes: fs.readFileSync(file.path),
        principal: member.access.principalId,
        operationId,
        path,
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
  let latestCommand: string | undefined;
  const confirm = async (token: string) => {
    const result = data((await f.act('records.erase', { confirmationToken: token })).result);
    latestCommand = result.commandId;
    return result;
  };
  const finish = async () => {
    await vi.waitFor(() =>
      expect(
        receipts.some((r) => !latestCommand || r.operationId === `${latestCommand}:receipt`)
      ).toBe(true)
    );
    const { text, operationId } = latestCommand
      ? receipts.find((r) => r.operationId === `${latestCommand}:receipt`)!
      : receipts.at(-1)!;
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
      if (!text.includes('delivery is uncertain') && failedStep !== 'file_check') {
        expect(text).toContain('Earlier steps are done.');
        expect(text).toContain('Make a new erasure request');
      }
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
  const request = await runExport(f);
  expect(data(request.result).status).toBe('scheduled');
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
  expect(fs.existsSync(f.uploads[0].path!)).toBe(false);
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
    await runExport(f); // positive control fails before P9
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
  const expectedFiles = { count: 0, bytes: 0 };
  const countFiles = (path: string) => {
    const stat = fs.lstatSync(path);
    if (stat.isDirectory()) for (const entry of fs.readdirSync(path)) countFiles(join(path, entry));
    else if (stat.isFile() && path !== f.paths.credentialPath) {
      expectedFiles.count++;
      expectedFiles.bytes += stat.size;
    }
  };
  for (const tree of [f.paths.runtimeRoot, f.archive, f.temp, f.tempArchive]) countFiles(tree);
  expect(await f.confirm(p.confirmationToken)).toMatchObject({ status: 'scheduled' });
  const receipt = await f.finish();
  expect(receipt.status).toBe('erased');
  const coreReceipt = erasePrincipalRecords(db, {
    principalId: f.member,
    commandId: receipt.commandId,
  });
  expect(receipt.core).toEqual(coreReceipt.counts);
  expect(receipt.product.files).toBe(expectedFiles.count);
  expect(receipt.product.fileBytes).toBe(expectedFiles.bytes);
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
    expect(receipt.failedStep).toBe(kind === 'oversize' ? 'export' : 'export_delivery');
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

it.each(['created', 'rewritten', 'omitted_rewritten'] as const)(
  'keeps every store and queued message when a file is %s during export delivery',
  async (change) => {
    const f = await setup();
    const db = f.runtime.database.adapter;
    await f.act('memory.save', {
      topic: 'fixture',
      kind: 'decision',
      summary: 'fixture personal',
      details: 'fixture evidence',
      source: { package: 'fixture', source_type: 'fixture' },
    });
    const rawStore = new RawStore(join(f.home, 'raw'));
    try {
      rawStore.save(
        'chat',
        [
          {
            source: 'chat',
            sourceId: 'fixture-pending',
            channel: 'fixture',
            author: f.member,
            content: 'fixture pending payload',
            timestamp: new Date(),
            type: 'message',
            memoryScopeKind: 'user',
            memoryScopeId: f.member,
          },
        ],
        { collectOnly: true }
      );
      const file = join(f.paths.workspaceDir, 'files', 'personal.txt');
      if (change === 'omitted_rewritten')
        fs.linkSync(file, join(f.home, 'workspace', 'outside-link.txt'));
      const preview = await f.preview();
      const send = f.telegram.sendFile.getMockImplementation()!;
      let uploading = false;
      let accept!: () => void;
      const wait = new Promise<void>((r) => {
        accept = r;
      });
      let core!: ReturnType<typeof exportPrincipalRecords>;
      let index!: unknown[];
      let raw!: ReturnType<RawStore['exportScope']>;
      const ledger = f.ledger.listForTelegramDm(f.memberDm);
      const session = f.pool.getSessionInfo(`member:${f.member}:runtime`)!.sessionId;
      f.telegram.sendFile.mockImplementationOnce(async (...args) => {
        const sent = await send(...args);
        core = exportPrincipalRecords(db, f.member);
        index = db
          .prepare(
            "SELECT * FROM connector_event_index WHERE source_connector='chat' AND memory_scope_id=?"
          )
          .all(f.member);
        raw = rawStore.exportScope('chat', 'user', f.member);
        uploading = true;
        await wait;
        if (change === 'created') f.put(join(f.paths.workspaceDir, 'files', 'new.txt'));
        else {
          const before = fs.statSync(file);
          f.put(file, 'changed bytes'); // Same inode and size; mtime must still be compared.
          fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
          expect(fs.statSync(file).size).toBe(before.size);
          expect(fs.statSync(file).ino).toBe(before.ino);
        }
        return sent;
      });
      try {
        await f.confirm(preview.confirmationToken);
        await vi.waitFor(() => expect(uploading).toBe(true));
        const queued = f.message(f.member);
        const turns = f.turns.length;
        accept();
        const receipt = await f.finish();
        expect(receipt).toMatchObject({ status: 'failed', failedStep: 'file_check' });
        expect(receipt.text).toContain('Your files changed while the export was being sent.');
        expect(receipt.text).toContain('Nothing was erased.');
        expect(receipt.text).toContain('Ask again');
        expect(receipt.text).toContain('0 messages');
        const remaining = exportPrincipalRecords(db, f.member);
        for (const [store, rows] of Object.entries(core.stores))
          for (const row of rows) expect(remaining.stores[store], store).toContainEqual(row);
        const indexAfter = db
          .prepare(
            "SELECT * FROM connector_event_index WHERE source_connector='chat' AND memory_scope_id=?"
          )
          .all(f.member);
        for (const row of index) expect(indexAfter).toContainEqual(row);
        const rawAfter = rawStore.exportScope('chat', 'user', f.member);
        for (const store of ['raw_items', 'pending_core_projections'] as const)
          for (const row of raw[store]) expect(rawAfter[store]).toContainEqual(row);
        expect(f.ledger.listForTelegramDm(f.memberDm)).toEqual(ledger);
        expect(db.prepare('SELECT * FROM principal_erasure_receipts').all()).toEqual([]);
        expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(true);
        expect(f.pool.getSessionInfo(`member:${f.member}:runtime`)!.sessionId).toBe(session);
        expect(fs.existsSync(f.archive)).toBe(true);
        expect(fs.existsSync(f.temp)).toBe(true);
        expect(fs.existsSync(f.tempArchive)).toBe(true);
        expect(fs.readFileSync(file, 'utf8')).toBe(
          change === 'created' ? 'fixture bytes' : 'changed bytes'
        );
        if (change === 'created')
          expect(fs.existsSync(join(f.paths.workspaceDir, 'files', 'new.txt'))).toBe(true);
        expect(fs.existsSync(f.uploads[0].path!)).toBe(false);
        await f.settled(queued, f.member);
        expect(f.turns).toHaveLength(turns + 1);
        expect(
          db
            .prepare('SELECT content FROM connector_event_index WHERE source_id=?')
            .get(`host:${receipt.commandId}:reply`)
        ).toEqual({ content: receipt.text });
      } finally {
        accept();
      }
    } finally {
      rawStore.close();
    }
  }
);

it.each(['export', 'erase'] as const)(
  'labels the %s host receipt with its job kind',
  async (kind) => {
    const f = await setup();
    let commandId: string;
    if (kind === 'export') commandId = data((await runExport(f)).result).commandId;
    else {
      const preview = await f.preview();
      await f.confirm(preview.confirmationToken);
      commandId = (await f.finish()).commandId;
    }
    const db = f.runtime.database.adapter;
    expect(
      db
        .prepare('SELECT content FROM connector_event_index WHERE source_id=?')
        .get(`host:${commandId}`)
    ).toEqual({
      content: `Personal records ${kind === 'export' ? 'export' : 'erasure'} host receipt`,
    });
    expect(
      db
        .prepare('SELECT content, metadata_json FROM connector_event_index WHERE source_id=?')
        .get(`host:${commandId}:reply`)
    ).toMatchObject({
      content: f.receipts.at(-1)!.text,
      metadata_json: expect.stringContaining('"deliveryVerified":true'),
    });
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
    expect(['pending', 'claimed']).toContain(
      f.runtime.runtime.mailbox!.readInput(queued, f.member)?.status
    )
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
  await runExport(f);
  const files = join(f.paths.workspaceDir, 'files');
  fs.rmSync(files, { recursive: true });
  const outside = join(f.home, 'workspace');
  const before = fs.readdirSync(outside);
  fs.symlinkSync(outside, files);
  expect((await runExport(f)).text).toContain('Export not sent');
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
  await runExport(f);
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
  expect((await runExport(f)).text).toContain('Export not sent');
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

async function runExport(f: Awaited<ReturnType<typeof setup>>) {
  const request = await f.act('records.export');
  if (request.result.status === 'completed' && data(request.result).status === 'scheduled') {
    await f.settled(request.ref, f.member);
    await f.runtime.surface.memberRecords.idle();
  }
  const text =
    f.receipts.at(-1)?.text ??
    (request.result.status === 'failed'
      ? request.result.error.message
      : JSON.stringify(data(request.result)));
  return { ...request, text };
}

it('refuses a sparse 100 GiB export by size before reading a file', async () => {
  const f = await setup();
  const huge = join(f.paths.workspaceDir, 'files', 'huge.bin');
  f.put(huge, '');
  fs.truncateSync(huge, 100 * 1024 ** 3);
  const read = vi.spyOn(fs, 'readSync').mockImplementation(() => {
    throw new Error('fixture file read must not happen');
  });
  syncBuiltinESMExports();
  const result = await runExport(f);
  expect(read).not.toHaveBeenCalled();
  expect(Number(/Member export is (\d+) bytes/.exec(result.text)![1])).toBeGreaterThanOrEqual(
    100 * 1024 ** 3
  );
  expect(f.uploads).toEqual([]);
});

it('caps output before a growing file writes over 50 MiB and removes the partial ZIP', async () => {
  const f = await setup();
  const file = join(f.paths.workspaceDir, 'files', 'growing.bin');
  f.put(file, 'x');
  const open = fs.openSync,
    read = fs.readSync,
    write = fs.writeSync;
  let input = -1;
  let output = -1;
  let readBytes = 0;
  let written = 0;
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    const fd = open(path, flags, mode);
    if (path === file) input = fd;
    if (String(path).endsWith('.zip')) output = fd;
    return fd;
  });
  vi.spyOn(fs, 'readSync').mockImplementation(((fd, buffer, offset, length, position) => {
    if (fd !== input) return read(fd, buffer, offset, length, position);
    if (readBytes >= 51 * 1024 ** 2) return 0;
    buffer.fill(0, offset, offset + length);
    readBytes += length;
    return length;
  }) as typeof fs.readSync);
  vi.spyOn(fs, 'writeSync').mockImplementation(((
    fd,
    buffer,
    offset = 0,
    length = buffer.length - offset,
    position = null
  ) => {
    const n = write(fd, buffer, offset, length, position);
    if (fd === output) written += n;
    return n;
  }) as typeof fs.writeSync);
  syncBuiltinESMExports();
  const result = await runExport(f);
  expect(result.text).toContain('50 MiB');
  expect(written).toBeLessThanOrEqual(OWNER_FILE_MAX_UPLOAD_BYTES);
  expect(readBytes).toBeLessThanOrEqual(OWNER_FILE_MAX_UPLOAD_BYTES + 64 * 1024);
  expect(f.uploads).toEqual([]);
  expect(
    fs
      .readdirSync(join(f.paths.workspaceDir, 'files'))
      .filter((name) => /^member-export-/.test(name))
  ).toEqual(['member-export-00000000-0000-0000-0000-000000000002.zip']);
});

it('retries short writes until every ZIP chunk is written', async () => {
  const f = await setup();
  const write = fs.writeSync;
  vi.spyOn(fs, 'writeSync').mockImplementation(((
    fd,
    buffer,
    offset = 0,
    length = buffer.length - offset,
    position = null
  ) =>
    write(
      fd,
      buffer,
      offset,
      Math.max(1, Math.floor(length / 2)),
      position
    )) as typeof fs.writeSync);
  syncBuiltinESMExports();
  await runExport(f);
  expect(f.uploads).toHaveLength(1);
  expect(
    strFromU8(unzipSync(f.uploads[0].bytes)[`files/${f.member}/workspace/files/personal.txt`])
  ).toBe('fixture bytes');
});

it.each(['fifo', 'inode', 'ancestor link'] as const)(
  'refuses a file swapped to %s after the walk without a blocking read',
  async (swap) => {
    const f = await setup();
    const target = join(f.paths.workspaceDir, 'files', 'swap.txt');
    f.put(target);
    const open = fs.openSync;
    let swapped = false;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      if (path === target && !swapped) {
        swapped = true;
        expect(Number(flags) & fs.constants.O_NONBLOCK).not.toBe(0);
        if (process.platform === 'darwin') expect(Number(flags) & 0x20000000).not.toBe(0);
        fs.renameSync(target, join(f.paths.workspaceDir, 'original.txt'));
        if (swap === 'fifo') execFileSync('mkfifo', [target]);
        else if (swap === 'inode') fs.writeFileSync(target, 'replacement bytes');
        else {
          const dir = join(f.paths.workspaceDir, 'files');
          fs.renameSync(dir, join(f.paths.workspaceDir, 'moved-files'));
          fs.symlinkSync(join(f.paths.workspaceDir, 'moved-files'), dir);
        }
      }
      return open(path, flags, mode);
    });
    syncBuiltinESMExports();
    const result = await runExport(f);
    expect(swapped).toBe(true);
    expect(f.uploads).toEqual([]);
    expect(result.text).toContain('Export not sent');
  }
);

it('omits outside hard links by name but exports all inside links and erases only the member links', async () => {
  const f = await setup();
  const outside = join(f.home, 'workspace', 'outside.txt');
  f.put(outside, 'outside bytes');
  const external = join(f.paths.workspaceDir, 'files', 'outside-link.txt');
  fs.linkSync(outside, external);
  const inside = join(f.paths.workspaceDir, 'files', 'inside-a.txt');
  f.put(inside, 'inside bytes');
  fs.linkSync(inside, join(f.paths.workspaceDir, 'files', 'inside-b.txt'));
  const p = await f.preview();
  await f.confirm(p.confirmationToken);
  const receipt = await f.finish();
  expect(receipt.status).toBe('erased');
  const zip = unzipSync(f.uploads[0].bytes);
  expect(zip[`files/${f.member}/workspace/files/outside-link.txt`]).toBeUndefined();
  for (const name of ['inside-a.txt', 'inside-b.txt'])
    expect(strFromU8(zip[`files/${f.member}/workspace/files/${name}`])).toBe('inside bytes');
  expect(receipt.text).toContain('outside-link.txt');
  expect(fs.existsSync(external)).toBe(false);
  expect(fs.readFileSync(outside, 'utf8')).toBe('outside bytes');
});

it('exports only transcripts/history/journal from managed directories, including retired trees', async () => {
  const f = await setup();
  for (const root of [f.paths.runtimeRoot, join(f.archive, 'runtime')]) {
    for (const path of [
      'claude-config/.claude.json',
      '.codex/auth.json.42.00000000-0000-0000-0000-000000000001.tmp',
      'runtime/session-credential.00000000-0000-0000-0000-000000000001.tmp',
      '.codex/config.toml',
      'codex-runtime/home/account.json',
    ])
      f.put(join(root, path), 'fixture account details');
    for (const path of [
      'claude-config/history.jsonl',
      '.codex/history.jsonl',
      'claude-config/projects/fixture/session.jsonl',
      '.codex/sessions/fixture/session.jsonl',
      'runtime/client-journal.jsonl',
    ])
      f.put(join(root, path), 'fixture transcript');
  }
  fs.linkSync(
    join(f.paths.claudeConfigDir, '.claude.json'),
    join(f.paths.workspaceDir, 'files', 'account-link.json')
  );
  await runExport(f);
  const zip = unzipSync(f.uploads[0].bytes);
  const keys = Object.keys(zip);
  expect(
    Object.values(zip).some((bytes) => strFromU8(bytes).includes('fixture account details'))
  ).toBe(false);
  for (const prefix of [`files/${f.member}`, `files/${basename(f.archive)}/runtime`]) {
    for (const path of [
      'claude-config/history.jsonl',
      '.codex/history.jsonl',
      'claude-config/projects/fixture/session.jsonl',
      '.codex/sessions/fixture/session.jsonl',
      'runtime/client-journal.jsonl',
    ])
      expect(strFromU8(zip[`${prefix}/${path}`])).toBe('fixture transcript');
  }
  expect(keys.some((key) => key.endsWith('.claude.json'))).toBe(false);
});

it('schedules export until settlement and runs it ahead of waiting member turns on the chain', async () => {
  const f = await setup();
  let complete!: () => void;
  f.holdMemberCompletion(
    new Promise<void>((r) => {
      complete = r;
    })
  );
  const request = await f.act('records.export');
  expect(data(request.result).status).toBe('scheduled');
  expect(f.uploads).toEqual([]);
  const before = f.turns.length;
  const queued = f.message(f.member);
  await Promise.resolve();
  expect(f.turns).toHaveLength(before);
  f.telegram.sendFile.mockImplementationOnce(async (path, _caption, operationId, member) => {
    expect(f.turns).toHaveLength(before);
    const file = validateWorkspaceFile(member.filesRoot, path, OWNER_FILE_MAX_UPLOAD_BYTES, true);
    f.uploads.push({
      bytes: fs.readFileSync(file.path),
      principal: member.access.principalId,
      operationId,
    });
    return { sentAs: 'document', size: file.size, messageId: 'fixture-accepted' };
  });
  complete();
  f.holdMemberCompletion(undefined);
  await f.settled(queued, f.member);
  await f.runtime.surface.memberRecords.idle();
  const receipt = f.receipts.at(-1)!.text;
  expect(receipt).toContain('Export sent');
  expect(receipt).toMatch(/Files: \d+ files, \d+ bytes/);
  expect(
    f.runtime.database.adapter
      .prepare('SELECT content FROM connector_event_index WHERE memory_scope_id=? AND content=?')
      .all(f.member, receipt)
  ).toHaveLength(1);
});

it.each(['failed', 'success'] as const)(
  'keeps queued messages until %s delivery and reports cancellation accurately',
  async (outcome) => {
    const f = await setup();
    const preview = await f.preview();
    let accept!: () => void;
    let uploading = false;
    const wait = new Promise<void>((r) => {
      accept = r;
    });
    f.telegram.sendFile.mockImplementationOnce(async () => {
      uploading = true;
      await wait;
      if (outcome === 'failed') throw new Error('fixture rejected');
      return { sentAs: 'document', size: 1, messageId: 'fixture-accepted' };
    });
    try {
      await f.confirm(preview.confirmationToken);
      await vi.waitFor(() => expect(uploading).toBe(true));
      const queued = f.message(f.member);
      const n = f.turns.length;
      await vi.waitFor(() =>
        expect(f.runtime.runtime.mailbox!.readInput(queued, f.member)).not.toBeNull()
      );
      expect(['pending', 'claimed']).toContain(
        f.runtime.runtime.mailbox!.readInput(queued, f.member)!.status
      );
      expect(f.turns).toHaveLength(n);
      accept();
      const receipt = await f.finish();
      if (outcome === 'failed') {
        await f.settled(queued, f.member);
        expect(receipt.text).toContain('0 messages');
      } else {
        expect(f.runtime.runtime.mailbox!.readInput(queued, f.member)).toBeNull();
        expect(receipt.text).toContain('1 message');
        expect(f.turns).toHaveLength(n);
      }
    } finally {
      accept();
    }
  }
);

it.each(['export', 'erase'] as const)(
  'still records a serve failure receipt in the %s job',
  async (kind) => {
    const f = await setup();
    const prepare = f.runtime.database.adapter.prepare.bind(f.runtime.database.adapter);
    let fail = false;
    const inject = () => {
      fail = true;
      vi.spyOn(f.runtime.database.adapter, 'prepare').mockImplementation((sql) => {
        if (fail && /SELECT kind, status FROM principals/.test(sql)) {
          fail = false;
          throw new Error('fixture serve failed');
        }
        return prepare(sql);
      });
    };
    if (kind === 'export') {
      f.telegram.sendFile.mockImplementationOnce(async () => {
        inject();
        return { sentAs: 'document', size: 1, messageId: 'fixture-accepted' };
      });
      const result = await runExport(f);
      expect(result.text).toContain('serve');
      expect(result.text).toContain('fixture serve failed');
    } else {
      const p = await f.preview();
      const rm = fs.rmSync;
      vi.spyOn(fs, 'rmSync').mockImplementation((path, opts) => {
        rm(path, opts);
        if (path === f.paths.runtimeRoot) inject();
      });
      syncBuiltinESMExports();
      await f.confirm(p.confirmationToken);
      await vi.waitFor(() => expect(f.receipts).toHaveLength(1));
      expect(f.receipts[0].text).toContain('serve');
      expect(f.receipts[0].text).toContain('fixture serve failed');
    }
    expect(
      f.runtime.database.adapter
        .prepare('SELECT content FROM connector_event_index WHERE memory_scope_id=? AND content=?')
        .all(f.member, f.receipts[0].text)
    ).toHaveLength(1);
  }
);

it('drops a confirmation that settles during stop without starting a job or cancelling messages', async () => {
  const f = await setup();
  const p = await f.preview();
  let release!: () => void;
  f.holdMemberCompletion(
    new Promise<void>((r) => {
      release = r;
    })
  );
  const request = await f.act('records.erase', { confirmationToken: p.confirmationToken });
  expect(data(request.result).status).toBe('scheduled');
  const queued = f.message(f.member);
  let finishStop!: () => void;
  let stopping = false;
  vi.spyOn(f.runtime.surface.memberRecords, 'idle').mockImplementation(async () => {
    stopping = true;
    await new Promise<void>((r) => {
      finishStop = r;
    });
  });
  const stop = f.runtime.stop();
  try {
    await vi.waitFor(() => expect(stopping).toBe(true));
    release();
    f.holdMemberCompletion(undefined);
    await f.settled(request.ref, f.member);
    expect(f.telegram.sendFile).not.toHaveBeenCalled();
    expect(f.runtime.runtime.mailbox!.readInput(queued, f.member)?.status).not.toBe('dead');
    expect(
      f.runtime.database.adapter.prepare('SELECT * FROM principal_erasure_receipts').all()
    ).toEqual([]);
  } finally {
    release();
    finishStop?.();
    await stop;
  }
});

it('keeps records and asks the member to check an uncertain upload before asking again', async () => {
  const f = await setup();
  const p = await f.preview();
  f.telegram.sendFile.mockImplementationOnce(async (_path, _caption, operationId) => {
    f.ledger.claim(`file:${operationId}`, {
      deliveryTarget: `telegram:${f.memberDm}`,
      payloadIdentity: 'a'.repeat(64),
    });
    f.ledger.markFailed(`file:${operationId}`);
    throw new Error('fixture upload timed out');
  });
  await f.confirm(p.confirmationToken);
  const receipt = await f.finish();
  expect(receipt.status).toBe('failed');
  expect(receipt.text).toContain('Check whether the file arrived');
  expect(receipt.text).not.toContain('Make a new erasure request');
  expect(fs.existsSync(join(f.paths.workspaceDir, 'files', 'personal.txt'))).toBe(true);
});

it.each(['dead', 'uncertain'] as const)(
  'drops a scheduled export on %s and permits the next member turn',
  async (outcome) => {
    const f = await setup();
    f.finishMemberTurn(outcome === 'dead' ? 'before_acceptance' : 'after_acceptance');
    const request = await f.act('records.export');
    expect(data(request.result).status).toBe('scheduled');
    await vi.waitFor(() => expect(f.receipts).toHaveLength(1));
    expect(f.receipts[0].text).toContain(
      'Export did not run because the requesting turn did not complete'
    );
    expect(f.receipts[0].text).toContain(outcome);
    expect(f.uploads).toEqual([]);
    await f.settled(f.message(f.member), f.member);
    expect(
      f.runtime.database.adapter
        .prepare('SELECT content FROM connector_event_index WHERE memory_scope_id=? AND content=?')
        .all(f.member, f.receipts[0].text)
    ).toHaveLength(1);
  }
);
