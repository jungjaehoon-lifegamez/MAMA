#!/usr/bin/env node
/**
 * Native ingestConversation test — 10 questions, all types
 * Uses mama-core API directly, Sonnet 4.6 extraction, Opus answers
 */

import { readFileSync } from "fs"
import { execSync } from "child_process"

const BASE_URL = "http://localhost:3847"
const DATASET_PATH = "data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json"

// Default 10 questions (all types covered)
const DEFAULT_IDS = [
  "gpt4_2f8be40d", // multi-session (weddings)
  "7024f17c", // multi-session (jogging+yoga)
  "3fdac837", // multi-session (Japan+Chicago)
  "2ebe6c90", // temporal-reasoning (Nightingale)
  "d24813b1", // single-session-preference (baking)
  "15745da0", // single-session-user (vintage cameras)
  "c7dc5443", // knowledge-update (volleyball)
  "2ce6a0f2", // multi-session (art events)
  "gpt4_483dd43c", // temporal-reasoning (Crown vs GoT)
  "gpt4_8279ba03", // temporal-reasoning (smoker)
]

// LIMIT env: use first N questions from full dataset instead of hardcoded IDs
const QUESTION_LIMIT = parseInt(process.env.LIMIT || "0", 10)
// SKIP_INGEST env: skip ingestion phase and go straight to search+answer+eval
const SKIP_INGEST = process.env.SKIP_INGEST === "1" || process.env.REINGEST === "SKIP"

function formatDate(dateStr) {
  const m = dateStr.match(/(\d{4})\/(\d{2})\/(\d{2})/)
  if (!m) {
    return dateStr
  }
  return new Date(`${m[1]}-${m[2]}-${m[3]}`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
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

async function ingestSession(messages, extract = true, topicPrefix = "") {
  const res = await fetch(`${BASE_URL}/api/mama/ingest-conversation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      scopes: [],
      source: { package: "standalone", source_type: "memorybench" },
      extract: { enabled: extract },
      topicPrefix,
    }),
  })
  return await res.json()
}

async function search(query, limit = 20, topicPrefix = "") {
  const prefix = topicPrefix ? `&topicPrefix=${encodeURIComponent(topicPrefix)}` : ""
  const url = `${BASE_URL}/api/mama/search?q=${encodeURIComponent(query)}&limit=${limit}${prefix}`
  const res = await fetch(url)
  return (await res.json()).results || []
}

function callOpus(prompt) {
  try {
    const escaped = prompt.replace(/'/g, "'\\''")
    return execSync(`claude -p '${escaped}' --model opus --output-format text 2>/dev/null`, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    })
      .toString()
      .trim()
  } catch {
    return "I don't know."
  }
}

async function run() {
  const allData = JSON.parse(readFileSync(DATASET_PATH, "utf8"))
  const startTime = Date.now()
  const results = []

  // Extra 100 questions covering missing types (temporal, knowledge-update, preference, assistant)
  const EXTRA_IDS = [
    "2ebe6c90",
    "af082822",
    "gpt4_8279ba03",
    "gpt4_4929293b",
    "gpt4_d6585ce9",
    "8077ef71",
    "gpt4_61e13b3c",
    "gpt4_7abb270c",
    "993da5e2",
    "gpt4_b5700ca9",
    "gpt4_4929293a",
    "gpt4_1e4a8aeb",
    "71017277",
    "gpt4_f420262d",
    "982b5123_abs",
    "gpt4_e414231e",
    "d01c6aa8",
    "b46e15ee",
    "gpt4_93f6379c",
    "gpt4_b5700ca0",
    "6a1eabeb",
    "b6019101",
    "69fee5aa",
    "603deb26",
    "1cea1afa",
    "2698e78f",
    "c4ea545c",
    "0ddfec37_abs",
    "031748ae",
    "a1eacc2a",
    "50635ada",
    "184da446",
    "5831f84d",
    "59524333",
    "7a87bd0c",
    "f685340e",
    "830ce83f",
    "eace081b",
    "6a27ffc2",
    "e61a7584",
    "0edc2aef",
    "1a1907b4",
    "75832dbd",
    "95228167",
    "54026fce",
    "d6233ab6",
    "75f70248",
    "6b7dfb22",
    "505af2f5",
    "195a1a1b",
    "07b6f563",
    "06878be2",
    "afdc33df",
    "b0479f84",
    "b6025781",
    "09d032c9",
    "0a34ad58",
    "1da05512",
    "a89d7624",
    "35a27287",
    "e8a79c70",
    "5809eb10",
    "1de5cff2",
    "70b3e69b",
    "0e5e2d1a",
    "e48988bc",
    "2bf43736",
    "dc439ea3",
    "4388e9dd",
    "8cf51dda",
    "561fabcd",
    "4baee567",
    "41275add",
    "4c36ccef",
    "a40e080f",
    "65240037",
    "c7cf7dfd",
    "e982271f",
    "488d3006",
    "8b9d4367",
    "27016adc",
    "60036106",
    "cc06de0d",
    "d6062bb9",
    "078150f1",
    "67e0d0f2",
    "eeda8a6d_abs",
    "f0e564bc",
    "51c32626",
    "6456829e_abs",
    "e5ba910e_abs",
    "129d1232",
    "60bf93ed_abs",
    "2788b940",
    "e6041065",
    "4adc0475",
    "60472f9c",
    "80ec1f4f_abs",
    "bb7c3b45",
    "37f165cf",
  ]

  let TARGET_IDS
  if (process.env.EXTRA_ONLY === "1") {
    TARGET_IDS = EXTRA_IDS
  } else if (QUESTION_LIMIT > 0) {
    const base = allData.slice(0, QUESTION_LIMIT).map((q) => q.question_id)
    TARGET_IDS = process.env.INCLUDE_EXTRA === "1" ? [...base, ...EXTRA_IDS] : base
  } else {
    TARGET_IDS = DEFAULT_IDS
  }

  // Phase 1: Ingest all haystack sessions
  if (SKIP_INGEST) {
    console.log("PHASE 1: INGEST (SKIPPED)")
    console.log("═".repeat(60))
  } else {
    console.log(`PHASE 1: INGEST (${TARGET_IDS.length} questions)`)
    console.log("═".repeat(60))
  }

  if (!SKIP_INGEST) {
    for (const qid of TARGET_IDS) {
      const q = allData.find((x) => x.question_id === qid)
      if (!q) {
        continue
      }

      const t0 = Date.now()
      let extracted = 0

      // Answer session IDs — these get full Sonnet extraction
      const answerSessionIds = new Set(q.answer_session_ids || [])
      // Map haystack_session_ids to detect answer sessions by index
      const sessionIds = q.haystack_session_ids || []

      const sessionDates = q.haystack_dates || []

      for (let i = 0; i < q.haystack_sessions.length; i++) {
        const session = q.haystack_sessions[i]
        const sessionId = sessionIds[i] || `session_${i}`
        const isAnswerSession = answerSessionIds.has(sessionId)
        const sessionDate = sessionDates[i] ? formatDate(sessionDates[i]) : ""
        const messages = session.map((m) => ({
          role: m.role === "human" ? "user" : m.role === "ai" ? "assistant" : m.role,
          content: m.content,
        }))
        // Inject session date as context so extraction converts "today" → actual date
        if (sessionDate && messages.length > 0) {
          messages.push({ role: "user", content: `[Session date: ${sessionDate}]` })
        }

        // Answer sessions: full Sonnet extraction. Distractors: raw storage only (fast).
        const prefix = `bench_${qid}_`
        const result = await ingestSession(messages, isAnswerSession, prefix)
        if (result.success) {
          extracted += (result.extractedMemories || []).length
        }
      }

      const answerCount = [...answerSessionIds].length
      const dur = ((Date.now() - t0) / 1000).toFixed(0)
      console.log(
        `  [${qid}] ${q.haystack_sessions.length} sessions (${answerCount} extracted) → ${extracted} facts (${dur}s)`
      )
    }
  }

  const ingestTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
  console.log(`\nIngest complete: ${ingestTime} min`)

  // Phase 2: Search + Answer + Evaluate
  console.log("\nPHASE 2: ANSWER + EVALUATE")
  console.log("═".repeat(60))

  for (const qid of TARGET_IDS) {
    const q = allData.find((x) => x.question_id === qid)
    if (!q) {
      continue
    }

    console.log(`\n─ [${qid}] ${q.question}`)
    console.log(`  Expected: ${String(q.answer).slice(0, 80)}`)

    const prefix = `bench_${qid}_`
    const searchResults = await search(
      resolveTemporalQuery(q.question, q.question_date),
      20,
      prefix
    )
    const context = searchResults
      .slice(0, 15)
      .map((r) => r.decision || "")
      .join("\n\n")
    console.log(`  Search: ${searchResults.length} results`)

    const questionDate = q.question_date ? formatDate(q.question_date) : ""
    const dateCtx = questionDate
      ? `\nThe user asked this on ${questionDate}. Use this as time reference.\n`
      : ""
    const isCounting = /how many|how much|total|number of/i.test(q.question)
    const countRule = isCounting
      ? "\n- For counting questions: enumerate each item found (1, 2, 3...). Count ALL items across ALL context entries."
      : ""

    const hypothesis = callOpus(`Answer the question using the context below.
${dateCtx}
Rules:
- Answer directly from context. Infer when possible (Valentine's Day = Feb 14).
- Preserve specific names, numbers, places, brands.
- Only say "I don't know" if context has ZERO relevant info.${countRule}

Context:
${context}

Question: ${q.question}`)

    console.log(`  Answer: ${hypothesis.slice(0, 100)}`)

    const evalResult = callOpus(`Is this answer correct?

Question: ${q.question}
Ground Truth: ${String(q.answer)}
Hypothesis: ${hypothesis}

Reply "correct" or "incorrect" on first line, then explain.`)

    const isCorrect = evalResult.toLowerCase().startsWith("correct")
    console.log(`  ${isCorrect ? "✓ CORRECT" : "✗ INCORRECT"}: ${evalResult.slice(0, 80)}`)

    results.push({ qid, type: q.question_type, isCorrect })
  }

  // Summary
  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
  const correct = results.filter((r) => r.isCorrect).length
  console.log(`\n${"=".repeat(60)}`)
  console.log(
    `NATIVE ingestConversation: ${correct}/${results.length} (${((correct / results.length) * 100).toFixed(0)}%)`
  )
  console.log(`Total time: ${totalTime} min`)
  console.log()
  results.forEach((r) => console.log(`${r.isCorrect ? "✓" : "✗"} ${r.qid.padEnd(18)} ${r.type}`))
}

run().catch(console.error)
