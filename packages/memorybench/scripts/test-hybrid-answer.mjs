#!/usr/bin/env node
/**
 * Hybrid answer+evaluate — uses already-ingested hyb_ data
 * Searches, generates answer via Claude CLI, evaluates correctness
 */

import { readFileSync } from "fs"
import { execSync } from "child_process"

const BASE_URL = "http://localhost:3847"
const DATASET_PATH = "data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json"

const TARGET_IDS = [
  "gpt4_2f8be40d", // weddings (multi-session)
  "7024f17c", // jogging+yoga (multi-session)
  "3fdac837", // Japan+Chicago (multi-session)
  "2ebe6c90", // Nightingale (temporal-reasoning)
  "d24813b1", // baking (single-session-preference)
]

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
    const dateStr = target.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
    return query.replace(relMatch[0], `on ${dateStr}`)
  }
  return query
}

async function search(query, topicPrefix, questionDate) {
  const resolved = resolveTemporalQuery(query, questionDate)
  const url = `${BASE_URL}/api/mama/search?q=${encodeURIComponent(resolved)}&limit=15&topicPrefix=${encodeURIComponent(topicPrefix)}`
  const res = await fetch(url)
  const data = await res.json()
  return data.results || []
}

function callClaude(prompt) {
  try {
    const escaped = prompt.replace(/'/g, "'\\''")
    const result = execSync(
      `claude -p '${escaped}' --model opus --output-format text 2>/dev/null`,
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
    )
    return result.toString().trim()
  } catch (e) {
    console.error("  Claude call failed:", e.message?.slice(0, 80))
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

    console.log(`\n${"═".repeat(60)}`)
    console.log(`[${qid}] ${q.question}`)
    console.log(`Expected: ${String(q.answer).slice(0, 100)}`)

    // Search
    const searchResults = await search(q.question, topicPrefix, q.question_date)
    const context = searchResults
      .slice(0, 10)
      .map((r) => r.decision || r.content || "")
      .join("\n\n")

    console.log(`Search: ${searchResults.length} results`)

    // Answer
    const answerPrompt = `You are a personal assistant with access to the user's memory. Based ONLY on the context below, answer the user's question. If the context doesn't contain enough information, say "I don't know."

Context from memory:
${context}

Question: ${q.question}

Answer concisely and directly.`

    const hypothesis = callClaude(answerPrompt)
    console.log(`Answer: ${hypothesis.slice(0, 120)}`)

    // Evaluate
    const evalPrompt = `You are an evaluator. Determine if the hypothesis correctly answers the question based on the ground truth.

Question: ${q.question}
Ground Truth: ${String(q.answer)}
Hypothesis: ${hypothesis}

Respond with ONLY "correct" or "incorrect" on the first line, then a brief explanation.`

    const evalResult = callClaude(evalPrompt)
    const isCorrect = evalResult.toLowerCase().startsWith("correct")
    console.log(`Eval: ${isCorrect ? "✓ CORRECT" : "✗ INCORRECT"}`)
    console.log(`  ${evalResult.slice(0, 120)}`)

    results.push({ qid, type: q.question_type, isCorrect, hypothesis: hypothesis.slice(0, 80) })
  }

  console.log(`\n${"=".repeat(60)}`)
  console.log("HYBRID ANSWER RESULTS")
  console.log(`${"=".repeat(60)}`)
  const correct = results.filter((r) => r.isCorrect).length
  console.log(
    `Accuracy: ${correct}/${results.length} (${((correct / results.length) * 100).toFixed(0)}%)`
  )
  console.log()
  results.forEach((r) => {
    console.log(
      `${r.isCorrect ? "✓" : "✗"} ${r.qid.padEnd(18)} ${r.type.padEnd(24)} ${r.hypothesis}`
    )
  })
}

run().catch(console.error)
