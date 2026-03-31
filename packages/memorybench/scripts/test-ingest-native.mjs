#!/usr/bin/env node
/**
 * Test mama-core ingestConversation natively on 3 failed questions
 * No custom extraction — pure mama-core pipeline
 */

import { readFileSync } from "fs"

const BASE_URL = "http://localhost:3847"
const DATASET_PATH = "data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json"

// 3 failures: name missing, brand missing, counting
const TARGET_IDS = [
  "0862e8bf", // cat Luna — name not extracted
  "86b68151", // IKEA bookshelf — brand not extracted
  "gpt4_2f8be40d", // 3 weddings — counting fail
]

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

async function ingestViaAPI(messages, _containerTag, _sessionId) {
  const res = await fetch(`${BASE_URL}/api/mama/ingest-conversation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      scopes: [],
      source: { package: "standalone", source_type: "memorybench" },
      extract: { enabled: true },
    }),
  })
  const data = await res.json()
  return data
}

async function search(query, limit = 15) {
  const url = `${BASE_URL}/api/mama/search?q=${encodeURIComponent(query)}&limit=${limit}`
  const res = await fetch(url)
  return (await res.json()).results || []
}

async function run() {
  const allData = JSON.parse(readFileSync(DATASET_PATH, "utf8"))

  for (const qid of TARGET_IDS) {
    const q = allData.find((x) => x.question_id === qid)
    if (!q) {
      continue
    }

    console.log(`\n${"═".repeat(60)}`)
    console.log(`[${qid}] ${q.question}`)
    console.log(`Expected: ${String(q.answer).slice(0, 80)}`)
    console.log(`Answer sessions: ${q.answer_session_ids.length}`)

    // Ingest only answer sessions (focused test)
    for (const sid of q.answer_session_ids) {
      const idx = q.haystack_session_ids.indexOf(sid)
      const session = q.haystack_sessions[idx]
      const dateStr = q.haystack_dates[idx] || ""
      const formattedDate = formatDate(dateStr)

      const messages = session.map((m) => ({
        role: m.role === "human" ? "user" : m.role === "ai" ? "assistant" : m.role,
        content: m.content,
      }))

      console.log(`\n  Ingesting session ${sid} (${messages.length} msgs, ${formattedDate})...`)
      const result = await ingestViaAPI(messages, qid, sid)

      if (result.success) {
        const extracted = result.extractedMemories || []
        console.log(`  ✓ raw:${result.rawId ? 1 : 0} extracted:${extracted.length}`)
        extracted.forEach((e, i) =>
          console.log(`    ${i + 1}. [${e.kind}] ${e.topic}: ${(e.summary || "").slice(0, 80)}`)
        )
      } else {
        console.log(`  ✗ Failed:`, JSON.stringify(result).slice(0, 100))
      }
    }

    // Search
    console.log(`\n  Searching: "${q.question.slice(0, 50)}"`)
    const results = await search(q.question, 20)
    console.log(`  Results: ${results.length}`)
    results.slice(0, 5).forEach((r, i) => {
      console.log(
        `    ${i + 1}. [${(r.similarity || 0).toFixed(3)}] ${(r.decision || "").slice(0, 90)}`
      )
    })

    // Quick answer check
    const context = results
      .slice(0, 10)
      .map((r) => r.decision || "")
      .join("\n\n")
    const answerStr = String(q.answer).toLowerCase()
    const contextLower = context.toLowerCase()
    const hasAnswer = answerStr
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .some((w) => contextLower.includes(w))
    console.log(`\n  Answer keywords in context: ${hasAnswer ? "✓ YES" : "✗ NO"}`)
  }
}

run().catch(console.error)
