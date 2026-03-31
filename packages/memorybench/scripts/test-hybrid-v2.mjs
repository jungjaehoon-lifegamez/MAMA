#!/usr/bin/env node
/**
 * Hybrid extraction v2 — persistent Claude session + 10 questions (all types)
 * Adds 5 new questions to existing hyb_ DB, then searches + answers all 10
 */

import { readFileSync } from "fs"
import { spawn, execSync } from "child_process"
import { randomUUID } from "crypto"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const BASE_URL = "http://localhost:3847"
const DATASET_PATH = "data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json"

// Existing 5 (already in DB with hyb_ prefix)
const EXISTING_IDS = [
  "gpt4_2f8be40d", // multi-session (weddings)
  "7024f17c", // multi-session (jogging+yoga)
  "3fdac837", // multi-session (Japan+Chicago)
  "2ebe6c90", // temporal-reasoning (Nightingale)
  "d24813b1", // single-session-preference (baking)
]

// New 5 to add (covers missing types)
const NEW_IDS = [
  "15745da0", // single-session-user (vintage cameras)
  "c7dc5443", // knowledge-update (volleyball record)
  "2ce6a0f2", // multi-session (art events)
  "gpt4_483dd43c", // temporal-reasoning (Crown vs GoT)
  "gpt4_8279ba03", // temporal-reasoning (smoker)
]

const ALL_IDS = [...EXISTING_IDS, ...NEW_IDS]

// LIMIT env: use first N questions from dataset instead of hardcoded IDs
const QUESTION_LIMIT = parseInt(process.env.LIMIT || "0", 10)

// ─── Persistent Claude Session ───────────────────────────────────────────────

class PersistentSession {
  constructor(model) {
    this.model = model
    this.process = null
    this.state = "dead"
    this.outputBuffer = ""
    this.accumulatedText = ""
    this.pendingResolve = null
    this.pendingReject = null
    this.timeoutHandle = null
    this.messageCount = 0
  }

  async start() {
    if (this.state !== "dead") {
      return
    }
    this.state = "starting"

    const workspaceDir = join(homedir(), ".mama", ".memorybench-workspace")
    if (!existsSync(workspaceDir)) {
      mkdirSync(workspaceDir, { recursive: true })
    }
    const gitDir = join(workspaceDir, ".git")
    if (!existsSync(gitDir)) {
      mkdirSync(gitDir, { recursive: true })
    }
    const headFile = join(gitDir, "HEAD")
    if (!existsSync(headFile)) {
      writeFileSync(headFile, "ref: refs/heads/main\n")
    }
    const emptyPluginDir = join(homedir(), ".mama", ".empty-plugins")
    if (!existsSync(emptyPluginDir)) {
      mkdirSync(emptyPluginDir, { recursive: true })
    }

    const args = [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--session-id",
      randomUUID(),
      "--setting-sources",
      "project,local",
      "--plugin-dir",
      emptyPluginDir,
      "--tools",
      "",
      "--model",
      this.model,
    ]

    console.log(`[Session] Starting persistent ${this.model} session...`)
    this.process = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workspaceDir,
      env: process.env,
    })

    this.process.stdout.on("data", (chunk) => this._handleStdout(chunk))
    this.process.stderr.on("data", () => {})
    this.process.on("close", (code) => {
      console.log(`[Session] Process closed (code: ${code})`)
      this.state = "dead"
      if (this.pendingReject) {
        this.pendingReject(new Error(`Process closed with code ${code}`))
        this.pendingResolve = null
        this.pendingReject = null
      }
    })

    await new Promise((r) => setTimeout(r, 500))
    if (this.process && !this.process.killed) {
      this.state = "idle"
      console.log("[Session] Ready")
    } else {
      throw new Error("Session failed to start")
    }
  }

  async prompt(text, timeoutMs = 30000) {
    if (this.state === "dead") {
      await this.start()
    }
    if (this.state === "busy") {
      throw new Error("Session is busy")
    }
    if (this.state !== "idle") {
      throw new Error(`Session not ready: ${this.state}`)
    }

    this.state = "busy"
    this.messageCount++
    this.accumulatedText = ""

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve
      this.pendingReject = reject

      this.timeoutHandle = setTimeout(() => {
        if (this.pendingReject) {
          this.pendingReject(new Error(`Timeout after ${timeoutMs}ms`))
          this.pendingResolve = null
          this.pendingReject = null
          // Kill the process on timeout to avoid leaked resources
          if (this.process && !this.process.killed) {
            this.process.kill("SIGTERM")
            this.process = null
          }
          this.state = "dead"
        }
      }, timeoutMs)

      const message =
        JSON.stringify({
          type: "user",
          message: { role: "user", content: text },
        }) + "\n"

      this.process.stdin.write(message, (err) => {
        if (err && this.pendingReject) {
          this.pendingReject(err)
          this.pendingResolve = null
          this.pendingReject = null
        }
      })
    })
  }

  _handleStdout(chunk) {
    this.outputBuffer += chunk.toString()
    const lines = this.outputBuffer.split("\n")
    this.outputBuffer = lines.pop() || ""

    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      try {
        this._processEvent(JSON.parse(line))
      } catch {
        /* ignore partial JSON */
      }
    }
    if (this.outputBuffer.trim()) {
      try {
        this._processEvent(JSON.parse(this.outputBuffer))
        this.outputBuffer = ""
      } catch {
        /* ignore partial JSON */
      }
    }
  }

  _processEvent(event) {
    try {
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            this.accumulatedText += block.text
          }
        }
      }
      if (event.type === "result") {
        if (this.timeoutHandle) {
          clearTimeout(this.timeoutHandle)
        }
        this.timeoutHandle = null
        const text = this.accumulatedText.trim()
        this.state = "idle"
        if (this.pendingResolve) {
          this.pendingResolve(text)
          this.pendingResolve = null
          this.pendingReject = null
        }
      }
    } catch (e) {
      console.error(`[Session] Error processing event: ${e.message}`)
      if (this.pendingReject) {
        this.pendingReject(e)
        this.pendingResolve = null
        this.pendingReject = null
      }
      this.state = "idle"
    }
  }

  close() {
    if (this.process) {
      this.process.kill("SIGTERM")
      this.process = null
    }
    this.state = "dead"
    console.log(`[Session] Closed after ${this.messageCount} messages`)
  }
}

// ─── Code extraction (same patterns) ─────────────────────────────────────────

const FACT_PATTERNS = [
  /\bI\s+(just\s+)?(started|began|finished|completed|graduated|attended)\b/i,
  /\bI\s+(just\s+)?(got|bought|purchased|acquired|received)\s+(a|an|my|the)\b/i,
  /\bI\s+(just\s+)?(got|bought|purchased|acquired)\b/i,
  /\bI\s+(am\s+currently|'m\s+currently)\b/i,
  /\bI\s+(am|'m)\s+(reading|watching|writing|playing|learning|training|working)\b/i,
  /\bI\s+recently\s+(attended|went|visited|saw|watched|volunteered|completed|finished|made|baked)\b/i,
  /\bI\s+went\s+(to|on|for)\b/i,
  /\bI\s+visited\b/i,
  /\bI\s+volunteered\b/i,
  /\bI\s+(work|live|play|run|do)\b/i,
  /\bI\s+spent\s+\d+\s+(day|days|week|weeks|hour|hours)\b/i,
  /\bI\s+was\s+(just\s+)?(in|at|talking)\b/i,
  /\bI'?ve\s+(made|baked|cooked|tried|been\s+\w+ing)\b/i, // expanded: been + any verb-ing
  /\bI\s+(upgraded|assembled|set\s+up|replaced|installed|organized)\b/i,
  /\bI\s+(usually|normally|typically)\b/i,
  /\bI\s+finally\s+\w+/i,
  /\bI\s+(love|like|prefer|enjoy)\s+\w+/i,
  /\bmy\s+(new|sister|brother|cousin|friend|mom|dad)\b.*\b[A-Z][a-z]{2,}\b/i,
  /\bour\s+\w*\s*(team|record|score|league)\b/i,
  /\bwe'?re\s+\d+-\d+\b/i,
  /\b\d+[-\s]+(minute|hour|day|week|month|year)\b.*\b(commute|trip|jog|walk|run|drive)\b/i,
]

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "to",
  "was",
  "were",
  "with",
  "you",
])

const DOMAIN_LABELS = [
  { patterns: [/\b(made|baked|cooked|brewed)\b/i], label: "Cooking/baking experience" },
  {
    patterns: [
      /\b(started|began|finished|completed)\b.*\b(book|novel)\b/i,
      /\b(started|began|finished|completed)\b.*["'][^"']{3,}["']/i,
    ],
    label: "Reading history",
  },
  {
    patterns: [
      /\b(started|watching|watched|finished|binge)\b.*\b(show|series|movie|season|episode)\b/i,
    ],
    label: "Watching history",
  },
  {
    patterns: [
      /\b(attended|visited)\b.*\b(concert|lecture|museum|gallery|theater|festival|exhibition)\b/i,
      /\bvolunteered\b/i,
    ],
    label: "Event attendance",
  },
  {
    patterns: [/\b(bought|purchased|acquired)\b/i, /\bgot\s+(a|an|my|the)\s+\w+/i],
    label: "Purchase",
  },
  { patterns: [/\bwe'?re\s+\d+-\d+\b/i, /\b(record|score)\b.*\d+-\d+/i], label: "Sports record" },
  { patterns: [/\b(went to|visited|was in|traveled to)\b.*\b[A-Z][a-z]{2,}\b/i], label: "Travel" },
  { patterns: [/\b(graduated|degree|diploma)\b/i], label: "Education" },
]

function extractFactSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => FACT_PATTERNS.some((p) => p.test(s)) && s.length > 15)
}

function extractEntityKey(fact) {
  const quoted = fact.match(/"([^"]+)"/)?.[1]
  if (quoted) {
    const verb = fact
      .match(
        /\b(started|began|finished|completed|got|bought|purchased|attended|went|visited)\b/i
      )?.[1]
      ?.toLowerCase()
    return `${verb || "fact"}_${quoted.toLowerCase().replace(/\s+/g, "_")}`.slice(0, 70)
  }
  const gotNoun = fact.match(/\bgot\s+(?:a\s+|an\s+)?(\w+)\b/i)?.[1]
  if (gotNoun && gotNoun.length > 3) {
    return `got_${gotNoun.toLowerCase()}`
  }
  const proper = fact
    .match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*/g)
    ?.filter((w) => !STOPWORDS.has(w.toLowerCase()))
  if (proper?.length) {
    const verb = fact
      .match(/\b(started|finished|attended|bought|visited|went|graduated|completed)\b/i)?.[1]
      ?.toLowerCase()
    return `${verb || "fact"}_${proper[0].toLowerCase().replace(/\s+/g, "_")}`.slice(0, 70)
  }
  const words = fact
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4 && !STOPWORDS.has(w))
    .slice(0, 3)
  return words.join("_") || "unknown"
}

function addDomainLabel(fact) {
  for (const { patterns, label } of DOMAIN_LABELS) {
    if (patterns.some((p) => p.test(fact))) {
      return `${label}: ${fact}`
    }
  }
  return fact
}

function formatDate(dateStr) {
  const m = dateStr.match(/(\d{4})\/(\d{2})\/(\d{2})/)
  if (!m) {
    return dateStr
  }
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}`)
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
}

function resolveTemporalQuery(query, questionDate) {
  if (!questionDate) {
    return query
  }
  const normalized = questionDate.replace(/\s+\([^)]+\)\s+/, " ")
  const base = new Date(normalized)
  if (isNaN(base.getTime())) {
    return query
  }
  const relMatch = query.match(/(\d+)\s+(day|days|week|weeks|month|months)\s+ago/i)
  if (relMatch) {
    const amount = parseInt(relMatch[1])
    const unit = relMatch[2].toLowerCase()
    const target = new Date(base)
    if (unit.startsWith("month")) {
      target.setMonth(target.getMonth() - amount)
    } else if (unit.startsWith("week")) {
      target.setDate(target.getDate() - amount * 7)
    } else {
      target.setDate(target.getDate() - amount)
    }
    return query.replace(
      relMatch[0],
      `on ${target.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`
    )
  }
  return query
}

// ─── MAMA API ────────────────────────────────────────────────────────────────

async function saveMemory({ topic, decision, reasoning, supersedes }) {
  const body = { topic, decision, reasoning }
  if (supersedes?.length) {
    body.supersedes = supersedes
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/api/mama/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        throw new Error(`Save HTTP error: ${res.status} ${res.statusText}`)
      }
      const data = await res.json()
      if (!data.success) {
        throw new Error(`Save failed: ${JSON.stringify(data)}`)
      }
      return data.id
    } catch (e) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      throw e
    }
  }
}

async function search(query, topicPrefix, questionDate) {
  const resolved = resolveTemporalQuery(query, questionDate)
  const url = `${BASE_URL}/api/mama/search?q=${encodeURIComponent(resolved)}&limit=15&topicPrefix=${encodeURIComponent(topicPrefix)}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Search failed: HTTP ${res.status} ${res.statusText}`)
  }
  const data = await res.json()
  return data.results || []
}

// ─── Extraction + Ingest ─────────────────────────────────────────────────────

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "3", 10) // sessions per Sonnet call

async function extractAndIngest(question, runTag, session) {
  const topicPrefix = `hyb_${runTag}_`
  const entityRegistry = new Map()
  let codeSaved = 0,
    sonnetSaved = 0,
    sonnetCalls = 0
  const answerSessionsSaved = new Set()

  // Pass 1: Code extraction for all sessions, collect sessions needing Sonnet
  const sessionData = []
  const needsSonnet = []

  for (let i = 0; i < question.haystack_sessions.length; i++) {
    const sessionId = question.haystack_session_ids[i]
    const msgs = question.haystack_sessions[i]
    const dateStr = question.haystack_dates[i] || ""
    const formattedDate = formatDate(dateStr)
    const userMessages = msgs.filter((m) => m.role === "user")
    const reasoning = `Session ${sessionId}. Date: ${formattedDate}.`

    const codeFacts = []
    for (const msg of userMessages) {
      for (const fact of extractFactSentences(msg.content)) {
        const normalized = fact.replace(/\bI\b/g, "User").trim()
        const dated = `${formattedDate}: ${addDomainLabel(normalized)}`
        codeFacts.push({ fact, dated })
      }
    }

    const entry = { i, sessionId, formattedDate, dateStr, reasoning, codeFacts, userMessages }
    sessionData.push(entry)
    // V3: always call Sonnet to catch names/numbers code regex misses
    if (session) {
      needsSonnet.push(sessionData.length - 1)
    }
  }

  // Pass 2: Batch Sonnet extraction (BATCH_SIZE sessions per call)
  const sonnetResults = new Map()

  for (let b = 0; b < needsSonnet.length; b += BATCH_SIZE) {
    const batch = needsSonnet.slice(b, b + BATCH_SIZE)
    sonnetCalls++

    const sections = batch
      .map((idx, si) => {
        const s = sessionData[idx]
        const text = s.userMessages
          .map((m) => `User: ${m.content}`)
          .join("\n")
          .slice(0, 2000)
        return `--- Session ${si + 1} (date: ${s.formattedDate}) ---\n${text}`
      })
      .join("\n\n")

    const prompt = `Extract personal facts from each session below. For EACH session, return facts as a JSON array of strings. Replace "I" with "User". Include the session date as prefix. Return a JSON array of arrays (one inner array per session). Return ONLY the JSON.

${sections}`

    try {
      const result = await session.prompt(prompt, 60000)
      const match = result.match(/\[[\s\S]*\]/)
      if (match) {
        let parsed = JSON.parse(match[0])
        if (parsed.length > 0 && !Array.isArray(parsed[0])) {
          const perSession = Math.ceil(parsed.length / batch.length)
          const chunks = []
          for (let c = 0; c < batch.length; c++) {
            chunks.push(parsed.slice(c * perSession, (c + 1) * perSession))
          }
          parsed = chunks
        }
        batch.forEach((idx, si) => {
          const facts = (parsed[si] || []).map((f) => ({
            fact: String(f),
            dated: String(f),
            fromSonnet: true,
          }))
          sonnetResults.set(idx, facts)
        })
      }
    } catch (e) {
      console.error(`  Sonnet batch extraction failed: ${e.message?.slice(0, 120) || e}`)
    }
  }

  // Pass 3: Save all facts to MAMA
  for (let di = 0; di < sessionData.length; di++) {
    const s = sessionData[di]
    const sonnetFacts = sonnetResults.get(di) || []
    const allFacts = [...s.codeFacts, ...sonnetFacts]
    if (allFacts.length === 0) {
      continue
    }

    // V3: save up to 8 facts (was 4) to preserve more detail
    for (let fi = 0; fi < Math.min(allFacts.length, 8); fi++) {
      const { fact, dated, fromSonnet } = allFacts[fi]
      const entityKey = fromSonnet
        ? `sonnet_${s.i}_f${fi}_${dated
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 4)
            .slice(0, 2)
            .join("_")}`.slice(0, 60)
        : extractEntityKey(fact)
      const topic = `${topicPrefix}${s.sessionId}_${entityKey}`.slice(0, 90)
      const existing = entityRegistry.get(entityKey)
      const supersedes = existing ? [existing.id] : undefined

      const id = await saveMemory({ topic, decision: dated, reasoning: s.reasoning, supersedes })
      entityRegistry.set(entityKey, { id, date: s.dateStr })
      if (fromSonnet) {
        sonnetSaved++
      } else {
        codeSaved++
      }
      if (question.answer_session_ids.includes(s.sessionId)) {
        answerSessionsSaved.add(s.sessionId)
      }
    }
  }

  return { topicPrefix, codeSaved, sonnetSaved, sonnetCalls, answerSessionsSaved }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const allData = JSON.parse(readFileSync(DATASET_PATH, "utf8"))

  // Start persistent Sonnet session for extraction
  const extractSession = new PersistentSession("sonnet")
  await extractSession.start()

  // Answer model — use independent calls to avoid context pollution
  const ANSWER_MODEL = process.env.ANSWER_MODEL || "opus"

  const results = []

  // Determine question IDs to process
  const targetIds =
    QUESTION_LIMIT > 0 ? allData.slice(0, QUESTION_LIMIT).map((q) => q.question_id) : ALL_IDS

  // Phase 1: Re-extract questions that need it
  const REINGEST_IDS = process.env.REINGEST
    ? process.env.REINGEST.split(",")
    : QUESTION_LIMIT > 0
      ? targetIds // ingest all when using LIMIT
      : NEW_IDS

  console.log(`\n${"═".repeat(60)}`)
  console.log(`PHASE 1: INGEST (${REINGEST_IDS.length} questions)`)
  console.log(`${"═".repeat(60)}`)

  try {
    for (const qid of REINGEST_IDS) {
      const q = allData.find((x) => x.question_id === qid)
      if (!q) {
        console.log(`${qid}: NOT FOUND`)
        continue
      }

      const runTag = `hyb_${qid.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`
      process.stdout.write(`\n[${qid}] ${q.question.slice(0, 60)}...\n`)

      const { codeSaved, sonnetSaved, sonnetCalls, answerSessionsSaved } = await extractAndIngest(
        q,
        runTag,
        extractSession
      )

      const coverage = answerSessionsSaved.size
      const total = q.answer_session_ids.length
      process.stdout.write(
        `  code:${codeSaved} sonnet:${sonnetSaved} (${sonnetCalls} calls) | answer coverage: ${coverage}/${total}\n`
      )
    }
  } finally {
    extractSession.close()
  }

  // Phase 2: Search + Answer + Evaluate ALL 10 questions
  console.log(`\n${"═".repeat(60)}`)
  console.log(`PHASE 2: SEARCH + ANSWER + EVALUATE (${ALL_IDS.length} questions)`)
  console.log(`${"═".repeat(60)}`)

  function callModel(prompt, model = ANSWER_MODEL) {
    try {
      const escaped = prompt.replace(/'/g, "'\\''")
      const result = execSync(
        `claude -p '${escaped}' --model ${model} --output-format text 2>/dev/null`,
        { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
      )
      return result.toString().trim()
    } catch (e) {
      throw new Error(`Claude CLI failed (model=${model}): ${e.message?.slice(0, 120)}`)
    }
  }

  for (const qid of targetIds) {
    const q = allData.find((x) => x.question_id === qid)
    if (!q) {
      continue
    }

    const runTag = `hyb_${qid.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`
    const topicPrefix = `hyb_${runTag}_`

    console.log(`\n${"─".repeat(60)}`)
    console.log(`[${qid}] ${q.question}`)
    console.log(`Expected: ${String(q.answer).slice(0, 100)}`)

    // Search
    const searchResults = await search(q.question, topicPrefix, q.question_date)
    const context = searchResults
      .slice(0, 10)
      .map((r) => r.decision || r.content || "")
      .join("\n\n")
    console.log(`Search: ${searchResults.length} results`)

    // Answer via independent call (no context pollution)
    const questionDate = q.question_date ? formatDate(q.question_date) : ""
    const dateContext = questionDate
      ? `\nIMPORTANT: The user asked this question on ${questionDate}. Interpret all relative time references ("this year", "last week", "how long", "ago") relative to this date, NOT today's date.\n`
      : ""

    const answerPrompt = `You are a personal assistant with access to the user's memory. Answer the user's question using the context below.
${dateContext}
Rules:
- If the context contains the answer or enough clues to infer it, answer directly.
- Use reasoning: "Valentine's Day" = February 14th. "got back from a 2-day workshop" = spent 2 days.
- Extract specific details: names, numbers, places, dates, brands from the context.
- Only say "I don't know" if the context truly has NO relevant information at all.

Context from memory:
${context}

Question: ${q.question}

Answer concisely and directly.`

    const hypothesis = callModel(answerPrompt)
    console.log(`Answer: ${hypothesis.slice(0, 120)}`)

    // Evaluate via independent call
    const evalPrompt = `You are an evaluator. Determine if the hypothesis correctly answers the question based on the ground truth.

Question: ${q.question}
Ground Truth: ${String(q.answer)}
Hypothesis: ${hypothesis}

Respond with ONLY "correct" or "incorrect" on the first line, then a brief explanation.`

    const evalResult = callModel(evalPrompt)
    const isCorrect = evalResult.toLowerCase().startsWith("correct")
    console.log(`Eval: ${isCorrect ? "✓ CORRECT" : "✗ INCORRECT"}`)
    console.log(`  ${evalResult.slice(0, 120)}`)

    results.push({ qid, type: q.question_type, isCorrect, hypothesis: hypothesis.slice(0, 80) })
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`)
  console.log(`HYBRID v2 RESULTS (${results.length} questions)`)
  console.log(`${"=".repeat(60)}`)
  const correct = results.filter((r) => r.isCorrect).length
  const accuracyPct = results.length > 0 ? ((correct / results.length) * 100).toFixed(0) : "0"
  console.log(`Accuracy: ${correct}/${results.length} (${accuracyPct}%)`)
  console.log()

  const byType = {}
  for (const r of results) {
    if (!byType[r.type]) {
      byType[r.type] = { total: 0, correct: 0 }
    }
    byType[r.type].total++
    if (r.isCorrect) {
      byType[r.type].correct++
    }
  }
  console.log("By type:")
  for (const [type, stats] of Object.entries(byType)) {
    console.log(`  ${type.padEnd(28)} ${stats.correct}/${stats.total}`)
  }
  console.log()
  results.forEach((r) => {
    console.log(
      `${r.isCorrect ? "✓" : "✗"} ${r.qid.padEnd(18)} ${r.type.padEnd(28)} ${r.hypothesis}`
    )
  })
}

run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
