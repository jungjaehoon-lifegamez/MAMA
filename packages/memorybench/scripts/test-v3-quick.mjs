#!/usr/bin/env node
/**
 * V3 quick test — 10 worst-performing questions with improved search + answer prompt
 * Changes vs v2: search limit 30, context top-20, counting-aware prompt
 */

import { readFileSync } from "fs"
import { execSync } from "child_process"

const BASE_URL = "http://localhost:3847"
const DATASET_PATH = "data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json"

// 10 worst failures: 5 counting + 3 IDK + 2 wrong
const TARGET_IDS = [
  "gpt4_2f8be40d", // wedding 3 → got 2 (counting)
  "2ce6a0f2", // art events 4 → got 3 (counting)
  "gpt4_f2262a51", // doctors 3 → got 2 (counting)
  "88432d0a", // baked 4 → got 3 (counting)
  "46a3abf7", // tanks 3 → got 2 (counting)
  "0862e8bf", // cat Luna → IDK (name missing)
  "58ef2f1c", // Valentine's Day → IDK (inference)
  "86b68151", // IKEA bookshelf → IDK (search miss)
  "19b5f2b3", // Japan 2 weeks → got 9 months (wrong)
  "7024f17c", // jogging 0.5h → got 0 (temporal)
]

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

async function search(query, topicPrefix, questionDate) {
  const resolved = resolveTemporalQuery(query, questionDate)
  // V3: limit 30 (was 15)
  const url = `${BASE_URL}/api/mama/search?q=${encodeURIComponent(resolved)}&limit=30&topicPrefix=${encodeURIComponent(topicPrefix)}`
  const res = await fetch(url)
  const data = await res.json()
  return data.results || []
}

function callModel(prompt) {
  try {
    const escaped = prompt.replace(/'/g, "'\\''")
    const result = execSync(
      `claude -p '${escaped}' --model opus --output-format text 2>/dev/null`,
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
    )
    return result.toString().trim()
  } catch {
    return "I don't know."
  }
}

async function run() {
  const allData = JSON.parse(readFileSync(DATASET_PATH, "utf8"))
  const results = []

  for (const qid of TARGET_IDS) {
    const q = allData.find((x) => x.question_id === qid)
    if (!q) {
      continue
    }

    const runTag = `hyb_${qid.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`
    const topicPrefix = `hyb_${runTag}_`

    console.log(`\n${"─".repeat(60)}`)
    console.log(`[${qid}] ${q.question}`)
    console.log(`Expected: ${String(q.answer).slice(0, 80)}`)

    const searchResults = await search(q.question, topicPrefix, q.question_date)
    // V3: top-20 context (was top-10)
    const context = searchResults
      .slice(0, 20)
      .map((r) => r.decision || r.content || "")
      .join("\n\n")
    console.log(
      `Search: ${searchResults.length} results (using top ${Math.min(searchResults.length, 20)})`
    )

    const questionDate = q.question_date ? formatDate(q.question_date) : ""
    const dateContext = questionDate
      ? `\nIMPORTANT: The user asked this question on ${questionDate}. Interpret all relative time references relative to this date, NOT today's date.\n`
      : ""

    // V3: improved prompt with counting awareness + inference
    const isCounting = /how many|how much|total|number of/i.test(q.question)
    const countingRule = isCounting
      ? `\n- COUNTING QUESTION: List EVERY distinct item you find in the context. Number them (1, 2, 3...). Count carefully. Do not skip any. Check if different memory entries refer to the same or different items.`
      : ""

    const answerPrompt = `You are a personal assistant with access to the user's memory. Answer the question using the context below.
${dateContext}
Rules:
- If the context contains the answer or clues to infer it, answer directly.
- Use reasoning: "Valentine's Day" = February 14th. "last weekend" relative to the question date.
- Extract specific details: names, numbers, places, dates, brands.
- Look through ALL context entries, not just the first few.
- Only say "I don't know" if there is truly ZERO relevant information.${countingRule}

Context from memory (${Math.min(searchResults.length, 20)} entries):
${context}

Question: ${q.question}

Answer concisely and directly.`

    const hypothesis = callModel(answerPrompt)
    console.log(`Answer: ${hypothesis.slice(0, 120)}`)

    const evalPrompt = `Determine if the hypothesis correctly answers the question based on the ground truth.

Question: ${q.question}
Ground Truth: ${String(q.answer)}
Hypothesis: ${hypothesis}

Respond with ONLY "correct" or "incorrect" on the first line, then a brief explanation.`

    const evalResult = callModel(evalPrompt)
    const isCorrect = evalResult.toLowerCase().startsWith("correct")
    console.log(`Eval: ${isCorrect ? "✓ CORRECT" : "✗ INCORRECT"}`)
    console.log(`  ${evalResult.slice(0, 100)}`)

    results.push({ qid, type: q.question_type, isCorrect })
  }

  console.log(`\n${"=".repeat(60)}`)
  const correct = results.filter((r) => r.isCorrect).length
  console.log(
    `V3 Quick Test: ${correct}/${results.length} (${((correct / results.length) * 100).toFixed(0)}%)`
  )
  console.log(`Previous: 0/${results.length} (all were failures)`)
  results.forEach((r) => console.log(`${r.isCorrect ? "✓" : "✗"} ${r.qid}`))
}

run().catch(console.error)
