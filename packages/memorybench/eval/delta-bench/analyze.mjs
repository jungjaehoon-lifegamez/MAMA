// analyze.mjs - decompose delta-bench results without any LLM calls.
//
// For every QA item it re-runs mama.suggest() offline and measures what the
// retrieval layer actually put in front of the model:
//   topicHit       - any row of the asked topic in top-5
//   currentPresent - the CURRENT decision row in top-5
//   currentRank    - its rank when present (1-based)
//   staleInTop5    - how many superseded versions of the topic are in top-5
// Then it joins per-condition correctness from results.jsonl and reports:
//   - chance-corrected accuracy (mean 1/optionCount baseline)
//   - mama miss decomposition: retrieval failure vs choice failure
//
// Usage:
//   MAMA_DB_PATH=/path/to/COPY.db node analyze.mjs --qa <dir> --results <dir>/full

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)

function fail(msg) {
  console.error(`[delta-bench:analyze] ${msg}`)
  process.exit(1)
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const qaDir = arg("qa", null)
const resultsDir = arg("results", null)
if (!qaDir || !resultsDir) {
  fail("--qa <dir> and --results <dir> are required.")
}

const dbPath = process.env.MAMA_DB_PATH
if (!dbPath) {
  fail("MAMA_DB_PATH (a COPY) is required.")
}
const resolved = path.resolve(dbPath)
const liveDbs = [
  path.join(os.homedir(), ".claude", "mama-memory.db"),
  path.join(os.homedir(), ".mama", "mama-memory.db"),
].map((p) => path.resolve(p))
if (liveDbs.includes(resolved)) {
  fail(`MAMA_DB_PATH points at a LIVE DB (${resolved}). Copy it first.`)
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const distDir = path.join(repoRoot, "packages/mama-core/dist")
const { initDB } = require(path.join(distDir, "db-manager.js"))
const mama = require(path.join(distDir, "mama-api.js"))
await initDB()

const qaSet = JSON.parse(fs.readFileSync(path.join(qaDir, "qa-set.json"), "utf8"))
const results = fs
  .readFileSync(path.join(resultsDir, "results.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))

const byItem = new Map()
for (const r of results) {
  if (!byItem.has(r.itemId)) {
    byItem.set(r.itemId, {})
  }
  byItem.get(r.itemId)[r.condition] = r
}

const diags = []
for (const item of qaSet) {
  const query = item.topic.replace(/_/g, " ")
  const res = await mama.suggest(query, { limit: 5 })
  if (!res || !Array.isArray(res.results)) {
    fail(`suggest() unexpected shape for "${query}"`)
  }
  const top5 = res.results
  const topicRows = top5.filter((r) => r.topic === item.topic)
  const currentIdx = top5.findIndex((r) => r.id === item.currentDecisionId)
  diags.push({
    itemId: item.id,
    topic: item.topic,
    optionCount: item.options.length,
    topicHit: topicRows.length > 0,
    currentPresent: currentIdx >= 0,
    currentRank: currentIdx >= 0 ? currentIdx + 1 : null,
    staleInTop5: topicRows.filter((r) => r.id !== item.currentDecisionId).length,
    conditions: Object.fromEntries(
      Object.entries(byItem.get(item.id) ?? {}).map(([c, r]) => [
        c,
        { choice: r.choice, correct: r.correct },
      ])
    ),
  })
}

// Chance baseline from actual option counts.
const chance = diags.reduce((s, d) => s + 1 / d.optionCount, 0) / diags.length

const retrievalStats = {
  items: diags.length,
  chanceAccuracy: +chance.toFixed(4),
  topicHitRate: +(diags.filter((d) => d.topicHit).length / diags.length).toFixed(4),
  currentPresentRate: +(diags.filter((d) => d.currentPresent).length / diags.length).toFixed(4),
  currentRank1Rate: +(diags.filter((d) => d.currentRank === 1).length / diags.length).toFixed(4),
  meanStaleInTop5: +(diags.reduce((s, d) => s + d.staleInTop5, 0) / diags.length).toFixed(2),
}

// mama miss decomposition.
const mamaMisses = diags.filter((d) => d.conditions.mama && !d.conditions.mama.correct)
const missRetrieval = mamaMisses.filter((d) => !d.currentPresent).length
const missChoice = mamaMisses.filter((d) => d.currentPresent).length

const out = {
  retrievalStats,
  mamaMissDecomposition: {
    misses: mamaMisses.length,
    retrievalFailure: missRetrieval,
    choiceFailureWithCurrentPresent: missChoice,
  },
  items: diags,
}
fs.writeFileSync(path.join(resultsDir, "analysis.json"), JSON.stringify(out, null, 2))

console.log("=== retrieval diagnostics (mama.suggest top-5) ===")
console.log(JSON.stringify(retrievalStats, null, 2))
console.log("=== mama miss decomposition ===")
console.log(
  `misses=${mamaMisses.length} retrievalFailure(current absent)=${missRetrieval} choiceFailure(current present)=${missChoice}`
)
console.log(`analysis: ${path.join(resultsDir, "analysis.json")}`)
