// packages/mama-core/scripts/re-embed-migration.mjs
// Local-only. Re-embeds all stored vectors with the e5 'passage' prefix and sets the
// scheme marker. NEVER call initDB here (its guard would block legacy DBs).
import { fileURLToPath } from 'node:url';

export const EMBEDDING_PREFIX_SCHEME = 'e5-prefixed-v1';

function ensureMarkerTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS embedding_meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`);
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db  writable DB
 * @param {(row:{topic:string,decision:string,reasoning:?string,outcome:?string,confidence:?number})=>Promise<Float32Array>} o.embedDecision  role='passage'
 * @param {(text:string)=>Promise<Float32Array>} o.embedWiki  role='passage'
 * @param {(msg:string)=>void} [o.log]
 * @returns {Promise<{decisions:number, wikiPages:number}>}
 */
export async function reEmbedDatabase({ db, embedDecision, embedWiki, log = () => {} }) {
  ensureMarkerTable(db);

  // 1) Decisions -> embeddings(rowid, embedding). Embed async first, write sync after.
  const decisions = db
    .prepare('SELECT rowid AS rid, topic, decision, reasoning, outcome, confidence FROM decisions')
    .all();
  log(`decisions to re-embed: ${decisions.length}`);
  const decVecs = [];
  let i = 0;
  for (const row of decisions) {
    const vec = await embedDecision(row);
    decVecs.push({ rid: row.rid, buf: Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) });
    if (++i % 50 === 0) log(`  decisions embedded: ${i}/${decisions.length}`);
  }

  // 2) Wiki pages -> wiki_page_embeddings (schema-aware; skip if table empty/absent).
  let wikiRows = [];
  let wikiSchemaVector = false;
  if (tableExists(db, 'wiki_page_embeddings') && tableExists(db, 'wiki_page_index')) {
    const embCols = tableColumns(db, 'wiki_page_embeddings');
    wikiSchemaVector = embCols.has('vector');
    wikiRows = wikiSchemaVector
      ? db.prepare(`SELECT e.wiki_page_id AS key, i.title, i.content
                    FROM wiki_page_embeddings e JOIN wiki_page_index i ON i.id = e.wiki_page_id`).all()
      : db.prepare(`SELECT e.page_id AS key, i.title, i.content
                    FROM wiki_page_embeddings e JOIN wiki_page_index i ON i.page_id = e.page_id`).all();
  }
  log(`wiki pages to re-embed: ${wikiRows.length}`);
  const wikiVecs = [];
  for (const row of wikiRows) {
    const text = `${row.title || ''}\n${row.content || ''}`.trim();
    if (!text) {
      throw new Error(
        `wiki page "${row.key}" has empty title+content and cannot be re-embedded. ` +
          `Remove its wiki_page_embeddings row and re-run (the scheme marker stays legacy until this succeeds).`
      );
    }
    const vec = await embedWiki(text);
    wikiVecs.push({ key: row.key, buf: Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) });
  }

  // 3) One sync transaction: overwrite vectors + flip marker last.
  const writeAll = db.transaction(() => {
    const putDec = db.prepare('INSERT OR REPLACE INTO embeddings (rowid, embedding) VALUES (?, ?)');
    for (const d of decVecs) putDec.run(d.rid, d.buf);
    if (wikiVecs.length) {
      const putWiki = wikiSchemaVector
        ? db.prepare('UPDATE wiki_page_embeddings SET vector = ? WHERE wiki_page_id = ?')
        : db.prepare('UPDATE wiki_page_embeddings SET embedding = ? WHERE page_id = ?');
      for (const w of wikiVecs) putWiki.run(w.buf, w.key);
    }
    db.prepare("INSERT OR REPLACE INTO embedding_meta (key, value) VALUES ('embedding_prefix_scheme', ?)")
      .run(EMBEDDING_PREFIX_SCHEME);
  });
  writeAll();

  log(`done: ${decVecs.length} decisions, ${wikiVecs.length} wiki pages; marker=${EMBEDDING_PREFIX_SCHEME}`);
  return { decisions: decVecs.length, wikiPages: wikiVecs.length };
}

async function main() {
  const dbPath = process.env.MAMA_DB_PATH;
  if (!dbPath) {
    throw new Error('MAMA_DB_PATH is required (no default - refusing to guess a personal DB path).');
  }
  const Database = (await import('better-sqlite3')).default;
  const { generateEnhancedEmbedding, generateEmbedding } = await import('../dist/embeddings.js');
  const db = new Database(dbPath); // writable
  db.pragma('journal_mode = WAL');
  const log = (m) => console.error(`[re-embed] ${m}`);
  log(`opening ${dbPath}`);
  const result = await reEmbedDatabase({
    db,
    embedDecision: (row) =>
      generateEnhancedEmbedding(
        {
          topic: row.topic,
          decision: row.decision,
          reasoning: row.reasoning || undefined,
          outcome: row.outcome || undefined,
          confidence: row.confidence ?? undefined,
        },
        'passage'
      ),
    embedWiki: (text) => generateEmbedding(text, 'passage'),
    log,
  });
  db.close();
  console.log(JSON.stringify({ db: dbPath.split('/').pop(), ...result }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
