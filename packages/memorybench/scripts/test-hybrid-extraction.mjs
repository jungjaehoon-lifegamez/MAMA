#!/usr/bin/env node
/**
 * Hybrid extraction test — code-first, Sonnet fallback for zero-fact sessions
 * Tests 5 questions to measure improvement over pure code extraction
 */

import { readFileSync } from "fs"
import { execSync } from "child_process"

const BASE_URL = "http://localhost:3847"
const DATASET_PATH = "data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json"

const TARGET_IDS = [
  "gpt4_2f8be40d", // weddings (multi-session, 3 answer sessions)
  "7024f17c", // jogging+yoga (multi-session, 3 answer sessions)
  "3fdac837", // Japan+Chicago (multi-session, 2 answer sessions)
  "2ebe6c90", // Nightingale temporal (worked with code)
  "d24813b1", // baking preference (worked with code)
]

// ─── Code extraction (same as before) ────────────────────────────────────────

const FACT_PATTERNS = [
  /\bI\s+(just\s+)?(started|began|finished|completed|graduated|attended)\b/i,
  /\bI\s+(just\s+)?(got|bought|purchased|acquired|received)\s+(a|an|my|the)\b/i,
  /\bI\s+(just\s+)?(got|bought|purchased|acquired)\b/i,
  /\bI\s+(am\s+currently|'m\s+currently)\b/i,
  /\bI\s+(am|'m)\s+(reading|watching|writing|playing|learning|training|working)\b/i,
  /\bI\s+recently\s+(attended|went|visited|saw|watched|volunteered|completed|finished|made|baked)\b/i,
  /\bI\s+went\s+(to|on)\b/i,
  /\bI\s+visited\b/i,
  /\bI\s+volunteered\b/i,
  /\bI\s+(work|live|play|run|do)\b/i,
  /\bI\s+spent\s+\d+\s+(day|days|week|weeks|hour|hours)\b/i,
  /\bI\s+was\s+in\s+[A-Z]/,
  /\bI'?ve\s+(made|baked|cooked|tried|been\s+doing|been\s+playing|been\s+training)\b/i,
  /\bour\s+\w*\s*(team|record|score|league)\b/i,
  /\bwe'?re\s+\d+-\d+\b/i,
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
  const sentences = text.split(/(?<=[.!?])\s+/)
  return sentences.filter((s) => FACT_PATTERNS.some((p) => p.test(s)) && s.length > 15)
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
    const dateStr = target.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
    return query.replace(relMatch[0], `on ${dateStr}`)
  }
  return query
}

// ─── Sonnet extraction (fallback) ────────────────────────────────────────────

function callSonnet(prompt) {
  try {
    const escaped = prompt.replace(/'/g, "'\\''")
    const result = execSync(
      `claude -p '${escaped}' --model sonnet --output-format text 2>/dev/null`,
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    )
    return result.toString().trim()
  } catch (e) {
    console.error("  Sonnet call failed:", e.message?.slice(0, 80))
    return ""
  }
}

function sonnetExtractFacts(userMessages, dateStr) {
  const formattedDate = formatDate(dateStr)
  const conversationText = userMessages
    .map((m) => `User: ${m.content}`)
    .join("\n")
    .slice(0, 3000)

  const prompt = `Extract personal facts from this conversation. Return ONLY a JSON array of strings, each being a concise fact about the user. Include dates, names, places, activities, preferences. Prefix each fact with the date "${formattedDate}".

Conversation:
${conversationText}

Rules:
- Replace "I" with "User"
- Each fact should be one sentence
- Include specific details (names, numbers, dates, places)
- Return [] if no personal facts found
- Return ONLY the JSON array, no other text`

  const result = callSonnet(prompt)
  try {
    // Try to parse JSON from the response
    const match = result.match(/\[[\s\S]*\]/)
    if (match) {
      return JSON.parse(match[0])
    }
  } catch (e) {
    // fallback: split by newlines
    return result
      .split("\n")
      .filter((l) => l.trim().length > 10)
      .slice(0, 5)
  }
  return []
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const allData = JSON.parse(readFileSync(DATASET_PATH, "utf8"))
  const results = []

  for (const qid of TARGET_IDS) {
    const q = allData.find((x) => x.question_id === qid)
    if (!q) {
      console.log(`${qid}: NOT FOUND`)
      continue
    }

    process.stdout.write(`\n${"═".repeat(60)}\n`)
    process.stdout.write(`[${qid}] ${q.question}\n`)
    process.stdout.write(`Answer: ${q.answer} | Type: ${q.question_type}\n`)

    const runTag = `hyb_${qid.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`
    const topicPrefix = `hyb_${runTag}_`
    const entityRegistry = new Map()
    let codeSaved = 0,
      sonnetSaved = 0,
      sonnetCalls = 0
    const answerSessionsSaved = new Set()

    for (let i = 0; i < q.haystack_sessions.length; i++) {
      const sessionId = q.haystack_session_ids[i]
      const msgs = q.haystack_sessions[i]
      const dateStr = q.haystack_dates[i] || ""
      const formattedDate = formatDate(dateStr)
      const userMessages = msgs.filter((m) => m.role === "user")
      const reasoning = `Session ${sessionId}. Date: ${formattedDate}.`

      // Phase 1: Code extraction
      const sessionFacts = []
      for (const msg of userMessages) {
        for (const fact of extractFactSentences(msg.content)) {
          const normalized = fact.replace(/\bI\b/g, "User").trim()
          const dated = `${formattedDate}: ${addDomainLabel(normalized)}`
          sessionFacts.push({ fact, dated })
        }
      }

      // Phase 2: Sonnet fallback if code found 0 facts
      let sonnetFacts = []
      if (sessionFacts.length === 0) {
        sonnetCalls++
        const extracted = sonnetExtractFacts(userMessages, dateStr)
        sonnetFacts = extracted.map((f) => ({
          fact: String(f),
          dated: String(f), // Sonnet already formats with date
          fromSonnet: true,
        }))
      }

      const allFacts = [...sessionFacts, ...sonnetFacts]
      if (allFacts.length === 0) {
        continue
      }

      for (const { fact, dated, fromSonnet } of allFacts.slice(0, 4)) {
        const entityKey = fromSonnet
          ? `sonnet_${i}_${fact
              .toLowerCase()
              .split(/\s+/)
              .filter((w) => w.length > 4)
              .slice(0, 2)
              .join("_")}`.slice(0, 60)
          : extractEntityKey(fact)
        const topic = `${topicPrefix}${sessionId}_${entityKey}`.slice(0, 90)
        const existing = entityRegistry.get(entityKey)
        const supersedes = existing ? [existing.id] : undefined

        const id = await saveMemory({
          topic,
          decision: dated,
          reasoning,
          supersedes,
        })

        entityRegistry.set(entityKey, { id, date: dateStr })
        if (fromSonnet) {
          sonnetSaved++
        } else {
          codeSaved++
        }
        if (q.answer_session_ids.includes(sessionId)) {
          answerSessionsSaved.add(sessionId)
        }
      }
    }

    const totalAnswerSessions = q.answer_session_ids.length
    const extractionCoverage = answerSessionsSaved.size
    process.stdout.write(
      `Extraction: code=${codeSaved}, sonnet=${sonnetSaved} (${sonnetCalls} calls) | Answer sessions: ${extractionCoverage}/${totalAnswerSessions}\n`
    )

    // Search
    const searchResults = await search(q.question, topicPrefix, q.question_date)
    const hitIds = searchResults
      .slice(0, 10)
      .filter((r) => q.answer_session_ids.some((sid) => r.topic.includes(sid)))

    const hitAtK = hitIds.length > 0 ? 1 : 0
    process.stdout.write(
      `Search: ${searchResults.length} results | hits in top10: ${hitIds.length}/${totalAnswerSessions} | HIT@10: ${hitAtK ? "✓" : "✗"}\n`
    )

    searchResults.slice(0, 5).forEach((r, i) => {
      const isAnswer = q.answer_session_ids.some((sid) => r.topic.includes(sid))
      process.stdout.write(
        `  ${i + 1}. ${isAnswer ? "✓" : " "} [${(r.confidence || r.similarity || 0).toFixed(3)}] ${(r.decision || "").slice(0, 90)}\n`
      )
    })

    results.push({
      qid,
      type: q.question_type,
      extractionCoverage: `${extractionCoverage}/${totalAnswerSessions}`,
      hitAtK,
      codeSaved,
      sonnetSaved,
      sonnetCalls,
    })
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`)
  console.log("HYBRID EXTRACTION SUMMARY")
  console.log(`${"=".repeat(60)}`)
  const hit = results.filter((r) => r.hitAtK).length
  const totalSonnetCalls = results.reduce((s, r) => s + r.sonnetCalls, 0)
  console.log(`HIT@10: ${hit}/${results.length} (${((hit / results.length) * 100).toFixed(0)}%)`)
  console.log(`Sonnet calls: ${totalSonnetCalls}`)
  console.log()
  results.forEach((r) => {
    console.log(
      `${r.hitAtK ? "✓" : "✗"} ${r.qid.padEnd(16)} ${r.type.padEnd(22)} coverage:${r.extractionCoverage} code:${r.codeSaved} sonnet:${r.sonnetSaved} (${r.sonnetCalls} calls)`
    )
  })
}

run().catch(console.error)
