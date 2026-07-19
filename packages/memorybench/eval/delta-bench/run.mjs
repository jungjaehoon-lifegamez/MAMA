// run.mjs - run the delta experiment over a QA set (truth + lineage items).
//
// Conditions:
//   vanilla      - question only (floor reference; near-chance by construction)
//   raw          - full chronological decision dump in context (what "just use
//                  long context" actually looks like), then the question
//   mama         - whatever mama.suggest() returns for the topic query (the real
//                  MCP search runtime path, including its retrieval imperfections)
//   mama-lineage - mama.suggest() results grouped by topic, each topic's FULL
//                  chain re-fetched from the DB copy and rendered as a lineage
//                  block (v1 (reasoning head) -> ... -> CURRENT: decision). This
//                  rendering is the R2 reasoning-precompute prototype under test.
//   oracle       - the context a CORRECT projection WOULD return (ceiling): for
//                  truth items the current decision marked current; for lineage
//                  items the asked chain rendered perfectly.
//
// Both QA types run under every condition. Model calls go through the Claude CLI
// (`claude -p`, prompt on stdin) - no API keys. Results append to
// <out>/results.jsonl (safe to re-run; answered (condition,item) pairs skipped).
//
// Usage:
//   node run.mjs --qa <dir> --out <dir>/results
//                [--conditions vanilla,raw,mama,mama-lineage,oracle]
//                [--limit 40] [--model <model>] [--timeout-s 600]
//   The mama and mama-lineage conditions additionally require MAMA_DB_PATH
//   pointing to a COPY of a MAMA DB - live DB paths are refused.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import {
  approxTokens,
  normalizeCreatedAt,
  parseChoice,
  renderLineageBlock,
  renderOptions,
  scoreResults,
} from "./lib.mjs"

const require = createRequire(import.meta.url)

function fail(msg) {
  console.error(`[delta-bench:run] ${msg}`)
  process.exit(1)
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const qaDir = arg("qa", null)
if (!qaDir) {
  fail("--qa <dir> is required (extract.mjs output dir).")
}
const outDir = arg("out", path.join(qaDir, "results"))
const conditions = arg("conditions", "vanilla,raw,mama")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const limit = Number(arg("limit", "40"))
const model = arg("model", null)
const timeoutS = Number(arg("timeout-s", "600"))
if (!Number.isFinite(limit) || !Number.isFinite(timeoutS)) {
  fail("--limit/--timeout-s must be numbers.")
}

const VALID_CONDITIONS = new Set(["vanilla", "raw", "mama", "mama-lineage", "oracle"])
for (const c of conditions) {
  if (!VALID_CONDITIONS.has(c)) {
    fail(`Unknown condition "${c}".`)
  }
}

const qaSet = JSON.parse(fs.readFileSync(path.join(qaDir, "qa-set.json"), "utf8")).slice(0, limit)
const corpus = JSON.parse(fs.readFileSync(path.join(qaDir, "corpus.json"), "utf8"))
fs.mkdirSync(outDir, { recursive: true })
const resultsPath = path.join(outDir, "results.jsonl")

// Resume support: skip (condition,item) pairs that already have a result.
const done = new Set()
const priorResults = []
if (fs.existsSync(resultsPath)) {
  for (const line of fs.readFileSync(resultsPath, "utf8").split("\n")) {
    if (!line.trim()) {
      continue
    }
    const r = JSON.parse(line)
    done.add(`${r.condition}:${r.itemId}`)
    priorResults.push(r)
  }
}

// --- mama / mama-lineage condition setup (real MCP search runtime path) ---
// Both conditions call mama.suggest(); mama-lineage additionally re-fetches each
// returned topic's full chain from a read-only handle on the DB copy.
const needsSuggest = conditions.includes("mama") || conditions.includes("mama-lineage")
const needsLineageDb = conditions.includes("mama-lineage")
const KIND_FILTER = "('decision', 'preference', 'constraint', 'lesson', 'fact')"
let mamaApi = null
let lineageDb = null
if (needsSuggest) {
  const dbPath = process.env.MAMA_DB_PATH
  if (!dbPath) {
    fail("mama/mama-lineage conditions require MAMA_DB_PATH (a COPY of a MAMA DB).")
  }
  const resolved = path.resolve(dbPath)
  const liveDbs = [
    path.join(os.homedir(), ".claude", "mama-memory.db"),
    path.join(os.homedir(), ".mama", "mama-memory.db"),
  ].map((p) => path.resolve(p))
  if (liveDbs.includes(resolved)) {
    fail(`MAMA_DB_PATH points at a LIVE DB (${resolved}). Copy it first - initDB may migrate.`)
  }
  if (!fs.existsSync(resolved)) {
    fail(`MAMA_DB_PATH not found: ${resolved}`)
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
  const distDir = path.join(repoRoot, "packages/mama-core/dist")
  const { initDB } = require(path.join(distDir, "db-manager.js"))
  mamaApi = require(path.join(distDir, "mama-api.js"))
  await initDB()
  if (needsLineageDb) {
    const Database = require("better-sqlite3")
    lineageDb = new Database(resolved, { readonly: true, fileMustExist: true })
  }
}

// Fetch a topic's full chain from the DB copy, oldest -> newest, using the same
// JS timestamp normalization as extract (SQL ORDER BY created_at is unreliable
// across the seconds/ms/TEXT encodings the live DBs mix).
const chainCache = new Map()
function fetchChain(topic) {
  if (chainCache.has(topic)) {
    return chainCache.get(topic)
  }
  const raw = lineageDb
    .prepare(
      `SELECT id, topic, decision, reasoning, created_at
       FROM decisions
       WHERE topic = ? AND kind IN ${KIND_FILTER}`
    )
    .all(topic)
  const rows = []
  for (const r of raw) {
    const ts = normalizeCreatedAt(r.created_at)
    if (ts === null) {
      continue
    }
    rows.push({ ...r, created_at: ts })
  }
  rows.sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)))
  chainCache.set(topic, rows)
  return rows
}

const PREAMBLE =
  "You answer a multiple-choice question about the CURRENT state of a decision. " +
  // NOTE: never put a concrete example letter here - an earlier version used
  // '(e.g. "B")' and every condition answered "B" for 80%+ of items.
  "Reply with exactly one option letter and nothing else. No explanation."

function corpusBlock() {
  return corpus.map((r) => `[${r.iso}] ${r.topic}: ${r.decision}`).join("\n")
}

// Cache the corpus rendering once - it is identical across items.
let cachedCorpusBlock = null

async function buildPrompt(condition, item) {
  const qa = `${item.question}\n\n${renderOptions(item)}\n\nAnswer:`
  if (condition === "vanilla") {
    return `${PREAMBLE}\n\n${qa}`
  }
  if (condition === "raw") {
    if (cachedCorpusBlock === null) {
      cachedCorpusBlock = corpusBlock()
    }
    return (
      `${PREAMBLE}\n\nBelow is the full decision history of this workspace, oldest first. ` +
      `Later entries on the same topic supersede earlier ones.\n\n<history>\n${cachedCorpusBlock}\n</history>\n\n${qa}`
    )
  }
  if (condition === "mama") {
    const query = item.topic.replace(/_/g, " ")
    const res = await mamaApi.suggest(query, { limit: 5 })
    if (!res || !Array.isArray(res.results)) {
      throw new Error(
        // Guard: JSON.stringify(undefined) === undefined, so slice() would throw
        // a TypeError and mask the real "unexpected shape" error.
        `suggest() returned unexpected shape for "${query}": ${String(JSON.stringify(res)).slice(0, 200)}`
      )
    }
    const hits = res.results.map((r) => ({
      topic: r.topic,
      decision: r.decision,
      reasoning: r.reasoning,
      confidence: r.confidence,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      // Topic-currency marking from the repaired pipeline: true = a newer
      // decision exists for this topic (this row is superseded history).
      superseded_by_newer: r.superseded_by_newer ?? null,
    }))
    return (
      `${PREAMBLE}\n\nBelow is what the memory system returned for this question:\n\n` +
      `<memory>\n${JSON.stringify(hits, null, 1)}\n</memory>\n\n${qa}`
    )
  }
  if (condition === "mama-lineage") {
    // R2 prototype: take mama.suggest()'s topics, then re-fetch each returned
    // topic's FULL chain from the DB copy and render it as a lineage block. The
    // rendering (not the flat hit list) is what the model sees. Retrieval
    // imperfection carries through: if suggest misses the asked topic, its
    // lineage never reaches the model.
    const query = item.topic.replace(/_/g, " ")
    const res = await mamaApi.suggest(query, { limit: 5 })
    if (!res || !Array.isArray(res.results)) {
      throw new Error(
        // Guard: JSON.stringify(undefined) === undefined, so slice() would throw
        // a TypeError and mask the real "unexpected shape" error.
        `suggest() returned unexpected shape for "${query}": ${String(JSON.stringify(res)).slice(0, 200)}`
      )
    }
    const topics = []
    const seenTopics = new Set()
    for (const r of res.results) {
      if (!r.topic || seenTopics.has(r.topic)) {
        continue
      }
      seenTopics.add(r.topic)
      topics.push(r.topic)
    }
    const blocks = topics
      .map((t) => renderLineageBlock(t, fetchChain(t)))
      .filter((b) => b && !b.endsWith("(no history)"))
    const lineage = blocks.length ? blocks.join("\n\n") : "(no matching topics found)"
    return (
      `${PREAMBLE}\n\nBelow is the decision lineage the memory system rendered for this question:\n\n` +
      `<lineage>\n${lineage}\n</lineage>\n\n${qa}`
    )
  }
  if (condition === "oracle") {
    // Ceiling condition: the context a CORRECT projection would return.
    if (item.qaType === "lineage") {
      // The asked chain rendered perfectly (guaranteed present, unlike the
      // retrieval-gated mama-lineage condition).
      const block = renderLineageBlock(item.topic, item.lineageChain || [])
      return (
        `${PREAMBLE}\n\nBelow is the decision lineage the memory system rendered for this question:\n\n` +
        `<lineage>\n${block}\n</lineage>\n\n${qa}`
      )
    }
    // Truth items: the topic's current decision, explicitly marked current.
    const hit = {
      topic: item.topic,
      decision: item.options.find((o) => o.label === item.answerLabel).text,
      status: "current",
      created_at: item.currentCreatedAt ? new Date(item.currentCreatedAt).toISOString() : null,
    }
    return (
      `${PREAMBLE}\n\nBelow is what the memory system returned for this question:\n\n` +
      `<memory>\n${JSON.stringify([hit], null, 1)}\n</memory>\n\n${qa}`
    )
  }
  throw new Error(`unreachable condition ${condition}`)
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    // --setting-sources project: exclude user-level settings so the user's
    // OWN MAMA plugin SessionStart hook does not inject live memory ("Recent
    // Decisions") into every bench call. Without this the experiment measuring
    // MAMA memory is contaminated BY MAMA memory (observed: verbatim-match
    // oracle items flipping to wrong answers).
    const args = ["-p", "--output-format", "text", "--setting-sources", "project"]
    if (model) {
      args.push("--model", model)
    }
    // Run from a neutral empty directory so the CLI does not inject this
    // repo's CLAUDE.md (or any project context) into the experiment prompt.
    const neutralCwd = path.join(os.tmpdir(), "delta-bench-neutral")
    fs.mkdirSync(neutralCwd, { recursive: true })
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], cwd: neutralCwd })
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`claude CLI timeout after ${timeoutS}s`))
    }, timeoutS * 1000)
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`claude CLI exit ${code}: ${err.slice(0, 300)}`))
      } else {
        resolve(out.trim())
      }
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

const results = [...priorResults]
for (const condition of conditions) {
  for (const item of qaSet) {
    const key = `${condition}:${item.id}`
    if (done.has(key)) {
      continue
    }
    const t0 = Date.now()
    let record
    try {
      const prompt = await buildPrompt(condition, item)
      const reply = await callClaude(prompt)
      const choice = parseChoice(
        reply,
        item.options.map((o) => o.label)
      )
      record = {
        itemId: item.id,
        topic: item.topic,
        qaType: item.qaType,
        condition,
        choice,
        answerLabel: item.answerLabel,
        correct: choice === item.answerLabel,
        replyHead: reply.slice(0, 80),
        promptChars: prompt.length,
        approxPromptTokens: approxTokens(prompt),
        latencyMs: Date.now() - t0,
      }
    } catch (e) {
      record = {
        itemId: item.id,
        topic: item.topic,
        qaType: item.qaType,
        condition,
        choice: null,
        answerLabel: item.answerLabel,
        correct: false,
        error: String(e).slice(0, 300),
        promptChars: 0,
        latencyMs: Date.now() - t0,
      }
    }
    fs.appendFileSync(resultsPath, JSON.stringify(record) + "\n")
    results.push(record)
    done.add(key)
    const mark = record.error ? "ERR" : record.correct ? "ok " : "MISS"
    console.log(
      `[${condition}] ${mark} ${item.topic} choice=${record.choice ?? "-"} ans=${item.answerLabel} ${record.latencyMs}ms`
    )
  }
}

if (lineageDb) {
  lineageDb.close()
}

const scored = results.filter((r) => conditions.includes(r.condition))
const summary = scoreResults(scored)
// Per-type breakdown: the whole point of the lineage extension is comparing
// mama vs mama-lineage separately for truth and lineage questions.
const qaTypes = [...new Set(scored.map((r) => r.qaType).filter(Boolean))].sort()
const summaryByType = {}
for (const t of qaTypes) {
  summaryByType[t] = scoreResults(scored.filter((r) => r.qaType === t))
}
fs.writeFileSync(
  path.join(outDir, "report.json"),
  JSON.stringify({ summary, summaryByType, results }, null, 2)
)

function printSummary(rows) {
  for (const s of rows) {
    console.log(
      `${s.condition.padEnd(12)} n=${s.n} accuracy=${s.accuracy} stale=${s.staleRate} invalid=${s.invalidRate} ~tokens/item=${s.approxTokensPerItem}`
    )
  }
}
console.log("\n=== delta-bench summary (all items) ===")
printSummary(summary)
for (const t of qaTypes) {
  console.log(`\n=== delta-bench summary (${t}) ===`)
  printSummary(summaryByType[t])
}
console.log(`\nreport: ${path.join(outDir, "report.json")}`)
