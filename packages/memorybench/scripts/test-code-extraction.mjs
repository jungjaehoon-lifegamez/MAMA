#!/usr/bin/env node
/**
 * Code-based extraction test — 10 questions
 * Tests all questions from current benchmark set
 * Measures: extraction coverage + retrieval hit rate
 */

import { readFileSync } from "fs"

const BASE_URL = "http://localhost:3847"
const DATASET_PATH =
  "packages/memorybench/data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json"

// Current benchmark question IDs (from v68)
const TARGET_IDS = [
  "d24813b1",
  "15745da0",
  "gpt4_2f8be40d",
  "gpt4_483dd43c",
  "c7dc5443",
  "2ce6a0f2",
  "gpt4_8279ba03",
  "7024f17c",
  "3fdac837",
  "2ebe6c90",
]

// ─── Fact extraction ────────────────────────────────────────────────────────

const FACT_PATTERNS = [
  /\bI\s+(just\s+)?(started|began|finished|completed|graduated|attended)\b/i,
  /\bI\s+(just\s+)?(got|bought|purchased|acquired|received)\s+(a|my|the|an)\b/i,
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

function extractFactSentences(text) {
  const sentences = text.split(/(?<=[.!?])\s+/)
  return sentences.filter((s) => FACT_PATTERNS.some((p) => p.test(s)) && s.length > 15)
}

function extractEntityKey(fact) {
  // 1. 인용구
  const quoted = fact.match(/"([^"]+)"/)?.[1]
  if (quoted) {
    const verb = fact
      .match(
        /\b(started|began|finished|completed|got|bought|purchased|attended|went|visited)\b/i
      )?.[1]
      ?.toLowerCase()
    return `${verb || "fact"}_${quoted.toLowerCase().replace(/\s+/g, "_")}`.slice(0, 70)
  }
  // 2. "got a NOUN" 패턴
  const gotNoun = fact.match(/\bgot\s+(?:a\s+|an\s+)?(\w+)\b/i)?.[1]
  if (gotNoun && gotNoun.length > 3) {
    return `got_${gotNoun.toLowerCase()}`
  }
  // 3. 대문자 고유명사
  const proper = fact
    .match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*/g)
    ?.filter((w) => !STOPWORDS.has(w.toLowerCase()))
  if (proper?.length) {
    const verb = fact
      .match(/\b(started|finished|attended|bought|visited|went|graduated|completed)\b/i)?.[1]
      ?.toLowerCase()
    return `${verb || "fact"}_${proper[0].toLowerCase().replace(/\s+/g, "_")}`.slice(0, 70)
  }
  // 4. fallback
  const words = fact
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4 && !STOPWORDS.has(w))
    .slice(0, 3)
  return words.join("_") || "unknown"
}

function formatDate(dateStr) {
  // "2023/01/10 (Tue) 10:34" → "January 10, 2023"
  const m = dateStr.match(/(\d{4})\/(\d{2})\/(\d{2})/)
  if (!m) {
    return dateStr
  }
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}`)
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  })
}

function parseQuestionDate(dateStr) {
  // "2023/03/25 (Sat) 18:26" → Date
  const normalized = dateStr.replace(/\s+\([^)]+\)\s+/, " ")
  return new Date(normalized)
}

function resolveTemporalQuery(query, questionDate) {
  // "10 days ago" → actual date string for searching
  if (!questionDate) {
    return query
  }
  const base = parseQuestionDate(questionDate)
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
      timeZone: "UTC",
    })
    return query.replace(relMatch[0], `on ${dateStr}`)
  }
  return query
}

// ─── Domain label ────────────────────────────────────────────────────────────

const DOMAIN_LABELS = [
  // 요리/베이킹: 만든 것 (got back from 같은 패턴과 혼동 없도록 구체적으로)
  { patterns: [/\b(made|baked|cooked|brewed)\b/i], label: "Cooking/baking experience" },
  // 독서: 책/소설 제목 또는 reading 키워드
  {
    patterns: [
      /\b(started|began|finished|completed)\b.*\b(book|novel)\b/i,
      /\b(started|began|finished|completed)\b.*["'][^"']{3,}["']/i,
    ],
    label: "Reading history",
  },
  // TV/영상: show/series/season 키워드
  {
    patterns: [
      /\b(started|watching|watched|finished|binge)\b.*\b(show|series|movie|season|episode)\b/i,
    ],
    label: "Watching history",
  },
  // 이벤트 참석: 구체적 장소/종류 포함
  {
    patterns: [
      /\b(attended|visited)\b.*\b(concert|lecture|museum|gallery|theater|festival|exhibition)\b/i,
      /\bvolunteered\b/i,
    ],
    label: "Event attendance",
  },
  // 구매: "bought"/"purchased" 또는 "got a/an/my/the + noun" (got back 제외)
  {
    patterns: [/\b(bought|purchased|acquired)\b/i, /\bgot\s+(a|an|my|the)\s+\w+/i],
    label: "Purchase",
  },
  // 스포츠 기록: 점수 패턴
  { patterns: [/\bwe'?re\s+\d+-\d+\b/i, /\b(record|score)\b.*\d+-\d+/i], label: "Sports record" },
  // 여행: 국가/도시 이름 포함
  { patterns: [/\b(went to|visited|was in|traveled to)\b.*\b[A-Z][a-z]{2,}\b/i], label: "Travel" },
  // 교육
  { patterns: [/\b(graduated|degree|diploma)\b/i], label: "Education" },
]

function addDomainLabel(fact) {
  for (const { patterns, label } of DOMAIN_LABELS) {
    if (patterns.some((p) => p.test(fact))) {
      return `${label}: ${fact}`
    }
  }
  return fact
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
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
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

// ─── Extraction ───────────────────────────────────────────────────────────────

async function extractAndIngest(question, runTag) {
  const sessionIds = question.haystack_session_ids
  const sessions = question.haystack_sessions
  const dates = question.haystack_dates
  const topicPrefix = `cex_${runTag}_`

  const entityRegistry = new Map()
  let savedCount = 0
  let factCount = 0
  const answerSessionsSaved = new Set()

  for (let i = 0; i < sessions.length; i++) {
    const sessionId = sessionIds[i]
    const msgs = sessions[i]
    const dateStr = dates[i] || ""
    const formattedDate = formatDate(dateStr)
    const userMessages = msgs.filter((m) => m.role === "user")

    const sessionFacts = []
    for (const msg of userMessages) {
      for (const fact of extractFactSentences(msg.content)) {
        const normalized = fact.replace(/\bI\b/g, "User").trim()
        const dated = `${formattedDate}: ${addDomainLabel(normalized)}`
        sessionFacts.push({ fact, dated })
        factCount++
      }
    }

    if (sessionFacts.length === 0) {
      continue
    }

    for (const { fact, dated } of sessionFacts.slice(0, 4)) {
      const entityKey = extractEntityKey(fact)
      const topic = `${topicPrefix}${sessionId}_${entityKey}`.slice(0, 90)
      const existing = entityRegistry.get(entityKey)
      const supersedes = existing ? [existing.id] : undefined

      const id = await saveMemory({
        topic,
        decision: dated,
        reasoning: `Session ${sessionId}. Date: ${formattedDate}.`,
        supersedes,
      })

      entityRegistry.set(entityKey, { id, date: dateStr })
      savedCount++
      if (question.answer_session_ids.includes(sessionId)) {
        answerSessionsSaved.add(sessionId)
      }
    }
  }

  return { topicPrefix, savedCount, factCount, answerSessionsSaved }
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

    process.stdout.write(`\n${"─".repeat(60)}\n`)
    process.stdout.write(`[${qid}] ${q.question}\n`)
    process.stdout.write(`Answer: ${q.answer} | Type: ${q.question_type}\n`)

    const runTag = qid.replace(/[^a-z0-9]/gi, "").slice(0, 10)
    const { topicPrefix, savedCount, factCount, answerSessionsSaved } = await extractAndIngest(
      q,
      runTag
    )

    const totalAnswerSessions = q.answer_session_ids.length
    const extractionCoverage = answerSessionsSaved.size
    process.stdout.write(
      `Extraction: ${factCount} facts → ${savedCount} saved | Answer sessions covered: ${extractionCoverage}/${totalAnswerSessions}\n`
    )

    // 검색
    const searchResults = await search(q.question, topicPrefix, q.question_date)
    const hitIds = searchResults
      .slice(0, 10)
      .map((r) => r.topic)
      .filter((t) => q.answer_session_ids.some((sid) => t.includes(sid)))

    const hitAtK = hitIds.length > 0 ? 1 : 0
    const relevantInTop10 = hitIds.length
    process.stdout.write(
      `Search: ${searchResults.length} results | hits in top10: ${relevantInTop10}/${totalAnswerSessions} | HIT@10: ${hitAtK ? "✓" : "✗"}\n`
    )

    // top 5 출력
    searchResults.slice(0, 5).forEach((r, i) => {
      const isAnswer = q.answer_session_ids.some((sid) => r.topic.includes(sid))
      process.stdout.write(
        `  ${i + 1}. ${isAnswer ? "✓" : " "} [${r.similarity?.toFixed(2)}] ${(r.decision || "").slice(0, 90)}\n`
      )
    })

    results.push({
      qid,
      type: q.question_type,
      extractionCoverage: `${extractionCoverage}/${totalAnswerSessions}`,
      hitAtK,
      relevantInTop10,
      totalAnswerSessions,
    })
  }

  // 요약
  console.log(`\n${"=".repeat(60)}`)
  console.log("SUMMARY")
  console.log(`${"=".repeat(60)}`)
  const hit = results.filter((r) => r.hitAtK).length
  const hitPct = results.length > 0 ? ((hit / results.length) * 100).toFixed(0) : "0"
  console.log(`HIT@10: ${hit}/${results.length} (${hitPct}%)`)
  console.log()
  results.forEach((r) => {
    console.log(
      `${r.hitAtK ? "✓" : "✗"} ${r.qid.padEnd(16)} ${r.type.padEnd(22)} extraction:${r.extractionCoverage} hits:${r.relevantInTop10}/${r.totalAnswerSessions}`
    )
  })
}

run().catch(console.error)
