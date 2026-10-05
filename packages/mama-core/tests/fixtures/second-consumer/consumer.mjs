// A second consumer of mama-core, run from the packed tarball installed in a temporary
// directory. It imports public subpaths only, keeps its own database, principal and scope kind,
// and writes, revises, links and reads its own records. It prints one JSON line.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mama-second-consumer-db-'));
try {
  const { openDatabase } = await import('@jungjaehoon/mama-core/db-manager');
  const { createKnowledge } = await import('@jungjaehoon/mama-core/knowledge');
  const db = await openDatabase({
    path: join(dir, 'bench.db'),
    migrations: [{ name: 'bench', dir: new URL('./migrations', import.meta.url).pathname }],
  });
  try {
    const knowledge = createKnowledge({ adapter: db.adapter });
    const scopes = [{ kind: 'workbench', id: 'bench-1' }];
    const access = { principalId: 'bench-principal', agentId: 'bench-agent', scopes };

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
        privatePath,
      })
    );
  } finally {
    await db.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
