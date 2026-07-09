// audit.mjs - read-only aggregate retrieval audit. Usage: AUDIT_DB=/path node audit.mjs
import Database from 'better-sqlite3';
import { parseVec, statsOf, computeTop1, computeLeakage, buildLineage } from './audit-lib.mjs';

const dbPath = process.env.AUDIT_DB;
if (!dbPath) {
  console.error('AUDIT_DB is required (read-only path to a mama DB). Refusing to guess.');
  process.exit(2);
}
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const rows = db.prepare(`
  SELECT d.rowid AS rid, d.id AS id, d.decision AS decision, d.topic AS topic,
         d.supersedes AS supersedes, d.superseded_by AS superseded_by, d.refined_from AS refined_from,
         d.created_at AS created_at, e.embedding AS embedding
  FROM decisions d JOIN embeddings e ON e.rowid = d.rowid
  WHERE d.kind = 'decision'
`).all();

const items = [];
let dropped = 0;
for (const r of rows) {
  const v = parseVec(r.embedding);
  if (!v) { dropped++; continue; }
  items.push({ id: r.id, vec: v, dtext: r.decision || '', created_at: r.created_at || 0 });
}

const { top1, top1Distinct } = computeTop1(items);
const edges = (() => { try { return db.prepare('SELECT from_id, to_id FROM decision_edges').all(); } catch { return []; } })();
const linkOf = buildLineage(
  rows.map((r) => ({ id: r.id, supersedes: r.supersedes, superseded_by: r.superseded_by, refined_from: r.refined_from })),
  edges
);
const sorted = items.slice().sort((a, b) => a.created_at - b.created_at);
const leakage = computeLeakage(sorted, linkOf, 5);

const distinctTexts = new Set(items.map((i) => i.dtext)).size;
console.log(JSON.stringify({
  db_basename: dbPath.split('/').pop(),
  usable_vectors: items.length,
  dropped_non4096: dropped,
  distinct_texts: distinctTexts,
  dup_rate: items.length ? +(1 - distinctTexts / items.length).toFixed(4) : 0,
  top1_cosine: statsOf(top1),
  top1_cosine_distinct_text: statsOf(top1Distinct),
  leakage,
}, null, 2));
db.close();
