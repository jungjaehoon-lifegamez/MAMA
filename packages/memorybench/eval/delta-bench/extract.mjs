// extract.mjs - build the temporal-truth QA set and the raw-context corpus
// from a MAMA decisions DB. Read-only: opens the DB with { readonly: true },
// never calls initDB, never writes to the source DB.
//
// Usage:
//   MAMA_DB_PATH=/path/to/mama-memory.db node extract.mjs --out ./out [--seed 20260719] [--max-items 40]
//
// Outputs (in --out dir):
//   qa-set.json   - [{ id, topic, question, options[], answerLabel, ... }]
//   corpus.json   - all decision rows, chronological (for the raw-context condition)
//   meta.json     - counts and filter stats

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { buildChains, buildQaItem, mulberry32, normalizeCreatedAt } from "./lib.mjs"

const require = createRequire(import.meta.url)
const Database = require("better-sqlite3")

function fail(msg) {
  console.error(`[delta-bench:extract] ${msg}`)
  process.exit(1)
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dbPath = process.env.MAMA_DB_PATH
if (!dbPath) {
  fail("MAMA_DB_PATH is required (never defaults to a live DB).")
}
if (!fs.existsSync(dbPath)) {
  fail(`DB not found: ${dbPath}`)
}

const outDir = arg("out", null)
if (!outDir) {
  fail("--out <dir> is required.")
}
const seed = Number(arg("seed", "20260719"))
const maxItems = Number(arg("max-items", "40"))
if (!Number.isFinite(seed) || !Number.isFinite(maxItems)) {
  fail("--seed/--max-items must be numbers.")
}

fs.mkdirSync(outDir, { recursive: true })

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
const rawRows = db
  .prepare(
    `SELECT id, topic, decision, reasoning, created_at, status, kind
     FROM decisions
     WHERE kind IN ('decision', 'preference', 'constraint', 'lesson', 'fact')`
  )
  .all()
db.close()

if (rawRows.length === 0) {
  fail("No decision rows in DB.")
}

// Normalize timestamps in JS (the DB mixes seconds / ms / TEXT datetimes, so
// SQL ORDER BY created_at is unreliable across encodings).
let droppedBadTimestamp = 0
const rows = []
for (const r of rawRows) {
  const ts = normalizeCreatedAt(r.created_at)
  if (ts === null) {
    droppedBadTimestamp += 1
    continue
  }
  rows.push({ ...r, created_at: ts })
}
rows.sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)))
if (rows.length === 0) {
  fail("All rows dropped by timestamp normalization.")
}

const chains = buildChains(rows)
if (chains.length === 0) {
  fail("No usable chains (length>=2 with a real delta) after filtering.")
}

// Sample chains deterministically when there are more than maxItems.
const rand = mulberry32(seed)
const shuffled = chains
  .map((c) => ({ c, r: rand() }))
  .sort((a, b) => a.r - b.r)
  .map((x) => x.c)
const picked = shuffled.slice(0, maxItems).sort((a, b) => a.topic.localeCompare(b.topic))

const qaSet = []
for (const chain of picked) {
  // Per-item seed derived from the global seed + topic for stable option order.
  let topicSeed = seed
  for (const ch of chain.topic) {
    topicSeed = (topicSeed * 31 + ch.charCodeAt(0)) >>> 0
  }
  const item = buildQaItem(chain, topicSeed)
  if (item) {
    qaSet.push(item)
  }
}
if (qaSet.length === 0) {
  fail("Chain sampling produced zero QA items.")
}

// Raw-context corpus: every decision row, chronological, as a user would dump
// their full history into a long context window. Decision text only by default
// (reasoning inclusion would roughly double the context; enable via flag later
// if the experiment needs it).
const corpus = rows.map((r) => ({
  topic: r.topic,
  decision: r.decision,
  created_at: r.created_at,
  iso: new Date(r.created_at).toISOString(),
}))

const meta = {
  db: path.resolve(dbPath),
  extractedAt: new Date().toISOString(),
  seed,
  totals: {
    decisionRows: rows.length,
    droppedBadTimestamp,
    chains: chains.length,
    qaItems: qaSet.length,
    corpusRows: corpus.length,
  },
  chainLengthHistogram: qaSet.reduce((h, q) => {
    h[q.chainLength] = (h[q.chainLength] || 0) + 1
    return h
  }, {}),
}

fs.writeFileSync(path.join(outDir, "qa-set.json"), JSON.stringify(qaSet, null, 2))
fs.writeFileSync(path.join(outDir, "corpus.json"), JSON.stringify(corpus))
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2))

console.log(
  `[delta-bench:extract] rows=${rows.length} chains=${chains.length} qaItems=${qaSet.length} -> ${outDir}`
)
