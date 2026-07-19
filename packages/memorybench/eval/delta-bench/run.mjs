// run.mjs - run the 3-condition delta experiment over a QA set.
//
// Conditions:
//   vanilla - question only (floor reference; near-chance by construction)
//   raw     - full chronological decision dump in context (what "just use long
//             context" actually looks like), then the question
//   mama    - whatever mama.suggest() returns for the topic query (the real
//             MCP search runtime path, including its retrieval imperfections)
//
// Model calls go through the Claude CLI (`claude -p`, prompt on stdin) - no
// API keys. Results append to <out>/results.jsonl (safe to re-run; answered
// (condition,item) pairs are skipped).
//
// Usage:
//   node run.mjs --qa <dir> --out <dir>/results [--conditions vanilla,raw,mama]
//                [--limit 40] [--model <model>] [--timeout-s 600]
//   The mama condition additionally requires MAMA_DB_PATH pointing to a COPY
//   of a MAMA DB - live DB paths are refused.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { approxTokens, parseChoice, renderOptions, scoreResults } from "./lib.mjs"

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
const limit = Number(arg("limit", "40"))
const model = arg("model", null)
const timeoutS = Number(arg("timeout-s", "600"))
if (!Number.isFinite(limit) || !Number.isFinite(timeoutS)) {
  fail("--limit/--timeout-s must be numbers.")
}

const VALID_CONDITIONS = new Set(["vanilla", "raw", "mama", "oracle"])
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

// --- mama condition setup (real MCP search runtime path) ---
let mamaApi = null
if (conditions.includes("mama")) {
  const dbPath = process.env.MAMA_DB_PATH
  if (!dbPath) {
    fail("mama condition requires MAMA_DB_PATH (a COPY of a MAMA DB).")
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
        `suggest() returned unexpected shape for "${query}": ${JSON.stringify(res).slice(0, 200)}`
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
  if (condition === "oracle") {
    // Ceiling condition: the context a CORRECT truth projection would return -
    // the topic's current decision, explicitly marked current. Near-100% by
    // construction; quantifies the prize for fixing retrieval + projection.
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

const summary = scoreResults(results.filter((r) => conditions.includes(r.condition)))
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ summary, results }, null, 2))
console.log("\n=== delta-bench summary ===")
for (const s of summary) {
  console.log(
    `${s.condition.padEnd(8)} n=${s.n} accuracy=${s.accuracy} stale=${s.staleRate} invalid=${s.invalidRate} ~tokens/item=${s.approxTokensPerItem}`
  )
}
console.log(`report: ${path.join(outDir, "report.json")}`)
