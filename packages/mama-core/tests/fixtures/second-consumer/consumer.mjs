// A second consumer of mama-core, run from the packed tarball unpacked in a temporary
// directory. It imports public subpaths only, keeps its own database, principal and scope kind,
// and writes, revises, links, reads and searches its own records. It keeps no vectors: its
// embedder answers null, so search goes by text. It prints one JSON line.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'mama-second-consumer-db-'));
try {
  const { openDatabase } = await import('@jungjaehoon/mama-core/db-manager');
  const { createKnowledge } = await import('@jungjaehoon/mama-core/knowledge');
  const { recallMemory, createPrincipalRepository, moveRecordsUserScope } =
    await import('@jungjaehoon/mama-core');
  const db = await openDatabase({
    path: join(dir, 'bench.db'),
    migrations: [{ name: 'bench', dir: fileURLToPath(new URL('./migrations', import.meta.url)) }],
  });
  try {
    const embedder = { embed: async () => null };
    const knowledge = createKnowledge({ adapter: db.adapter, embedder: null });
    const scopes = [{ kind: 'workbench', id: 'bench-1' }];
    const access = { principalId: 'bench-principal', agentId: 'bench-agent', scopes };
    const principals = createPrincipalRepository(db.adapter);
    principals.ensureOwner({ principalId: 'bench-common', now: 1 });
    const memberId = principals.registerMember({
      connector: 'instrument',
      namespace: 'bench',
      externalId: 'reviewer-1',
      now: 2,
    });
    principals.grantRole({ principalId: memberId, role: 'bench-reviewer', now: 3 });
    const checkpointId = db.adapter
      .prepare('INSERT INTO checkpoints (timestamp, summary) VALUES (?, ?)')
      .run(1, 'personal calibration checkpoint').lastInsertRowid;
    const scopeMove = moveRecordsUserScope(db.adapter, {
      recordIds: [Number(checkpointId)],
      fromPrincipalId: 'bench-common',
      toPrincipalId: memberId,
      bindUnscoped: true,
    });
    const movedRecordVisible =
      db.adapter
        .prepare(
          "SELECT 1 FROM checkpoint_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id WHERE b.checkpoint_id=? AND s.kind='user' AND s.external_id=?"
        )
        .get(checkpointId, memberId) !== undefined;

    const finding = await knowledge.appendJudgment(
      {
        commandId: 'bench-finding-1',
        topic: 'bench/finding',
        summary: 'the sample drifts after an hour',
        recordKind: 'judgment',
        scopes,
      },
      access
    );
    const created = await knowledge.createWork(
      {
        commandId: 'bench-run-42',
        topic: 'bench/run-42',
        summary: 'run 42 started',
        set: { title: 'Run 42', status: 'pending', operator: 'bench' },
        scopes,
      },
      access
    );
    const revised = await knowledge.reviseWork(
      {
        commandId: 'bench-run-42-done',
        commitmentId: created.commitmentId,
        expectedRevision: created.revision,
        summary: 'run 42 finished and showed the drift',
        set: { status: 'done' },
        scopes,
      },
      access
    );
    const link = knowledge.appendLink(
      {
        commandId: 'bench-link-1',
        from: revised.recordRef,
        to: { kind: 'memory', id: finding.recordId },
        relation: 'builds_on',
        reason: 'run 42 confirmed the drift finding',
      },
      access
    );
    const elsewhere = [{ kind: 'workbench', id: 'bench-2' }];
    const other = await knowledge.appendJudgment(
      {
        commandId: 'bench-other-1',
        topic: 'bench/other',
        summary: 'the sample in the other bench drifts as well',
        recordKind: 'judgment',
        scopes: elsewhere,
      },
      { ...access, scopes: elsewhere }
    );
    const searchStarted = Date.now();
    const recalled = await recallMemory(db.adapter, 'sample drifts', { scopes, embedder });
    const searchMs = Date.now() - searchStarted;
    const chain = knowledge.readWork(
      { commitmentId: created.commitmentId, history: 'chain' },
      access
    );
    const graph = knowledge.queryGraph({ view: 'neighbors', seeds: [revised.recordRef] }, access);

    let privatePath = 'imported';
    try {
      await import('@jungjaehoon/mama-core/knowledge/judgments');
    } catch (error) {
      privatePath = error.code ?? String(error);
    }

    const tables = db.adapter
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    const item = chain.items[0];
    console.log(
      JSON.stringify({
        ownTable: tables.includes('bench_notes'),
        foreignTables: tables.filter((name) => name.startsWith('connector_')),
        scopeKinds: db.adapter
          .prepare('SELECT DISTINCT kind FROM memory_scopes ORDER BY kind')
          .all()
          .map((row) => row.kind),
        judgment: finding.status,
        revision: item.revision,
        status: item.values.status,
        latestRecord: item.latestJudgmentRef.id,
        revisedRecord: revised.recordRef.id,
        linkId: link.edgeId,
        graphEdges: graph.edges.map((edge) => ({
          relation: edge.relation,
          from: edge.from.id,
          to: edge.to.id,
        })),
        findingId: finding.recordId,
        otherId: other.recordId,
        searchHits: recalled.memories.map((memory) => memory.id),
        searchMs,
        privatePath,
        role: principals.listRoles(memberId)[0]?.role,
        roleMember: principals.listActiveMembersWithRole('bench-reviewer')[0]?.principalId,
        memberId,
        commonIdentityCount: db.adapter
          .prepare('SELECT COUNT(*) AS n FROM external_identities WHERE principal_id=?')
          .get('bench-common').n,
        scopeMove,
        movedRecordVisible,
      })
    );
  } finally {
    await db.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
