// lib.mjs - pure helpers for the delta bench (temporal-truth QA from decision chains).
// No DB access, no model calls. Deterministic given a seed.

// Test-pollution and low-signal topics are excluded from chain building.
// alpha/beta/auth_strategy/database_choice are known fixture topics that leaked
// into the live DB before test HOME isolation landed (2026-07-17).
const EXCLUDED_TOPIC_PATTERNS = [
  /^(alpha|beta|auth_strategy|database_choice|dummy)$/i,
  // Token-anchored so legitimate topics that merely contain the substring
  // "test" (e.g. "latest_pricing", "fastest_path") are not dropped.
  /(^|_)test(ing|s)?(_|$)/i,
  /^memory_scopes/i,
  /^session_greeting$/i,
]

const MIN_DECISION_CHARS = 40
// Lineage (L-type) items answer with a real `reasoning` string; require it to be
// substantial so the QA is not decided by a one-word rationale.
const MIN_REASONING_CHARS = 40
// Head length for a reasoning shown inside a rendered lineage block. Long enough
// to identify the rationale, short enough that the block stays compact.
const REASONING_HEAD_CHARS = 120
const MAX_DISTRACTORS = 3
const OPTION_LABELS = ["A", "B", "C", "D"]

export function isExcludedTopic(topic) {
  return EXCLUDED_TOPIC_PATTERNS.some((re) => re.test(topic))
}

/**
 * Normalize a decisions.created_at value to epoch milliseconds.
 * The live DBs mix three encodings: epoch seconds, epoch milliseconds, and at
 * least one TEXT datetime ("2026-02-15 04:29:33"). Returns null when the value
 * cannot be interpreted - callers drop (and count) such rows.
 */
export function normalizeCreatedAt(v) {
  if (v === null || v === undefined) {
    return null
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return v > 1e12 ? v : v * 1000
  }
  if (typeof v === "string") {
    const trimmed = v.trim()
    if (/^\d+$/.test(trimmed)) {
      return normalizeCreatedAt(Number(trimmed))
    }
    // Stamp UTC only when the text carries no timezone marker: appending "Z" to
    // a value that already ends in "Z" or an offset would produce NaN.
    const formatted = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T")
    const hasTz = formatted.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(formatted)
    const parsed = Date.parse(hasTz ? formatted : formatted + "Z")
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// Deterministic PRNG so QA sets are reproducible run-to-run.
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seededShuffle(arr, rand) {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Group decision rows into temporal chains by topic, ordered oldest -> newest.
 * MAMA semantics: re-using a topic supersedes the previous decision, so the
 * newest row of a topic IS the current truth. Explicit supersedes links exist
 * too but are a subset of topic reuse; topic grouping covers both.
 *
 * rows: [{ id, topic, decision, reasoning, created_at, status, kind }]
 * Returns chains: [{ topic, rows: [...oldest..newest] }] with:
 *  - length >= 2
 *  - excluded topics dropped
 *  - rows shorter than MIN_DECISION_CHARS dropped before grouping
 *  - chains whose current text duplicates a prior version dropped (no delta)
 */
export function buildChains(rows) {
  const byTopic = new Map()
  for (const r of rows) {
    if (!r.topic || !r.decision) {
      continue
    }
    if (isExcludedTopic(r.topic)) {
      continue
    }
    if (r.decision.trim().length < MIN_DECISION_CHARS) {
      continue
    }
    if (!byTopic.has(r.topic)) {
      byTopic.set(r.topic, [])
    }
    byTopic.get(r.topic).push(r)
  }
  const chains = []
  for (const [topic, group] of byTopic) {
    if (group.length < 2) {
      continue
    }
    group.sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)))
    const current = group[group.length - 1]
    const priors = group.slice(0, -1)
    const currentText = normalizeText(current.decision)
    const distinctPriors = priors.filter((p) => normalizeText(p.decision) !== currentText)
    if (distinctPriors.length === 0) {
      continue
    }
    chains.push({ topic, rows: group })
  }
  chains.sort((a, b) => a.topic.localeCompare(b.topic))
  return chains
}

function normalizeText(s) {
  return s.replace(/\s+/g, " ").trim().toLowerCase()
}

/**
 * Build one multiple-choice QA item from a chain.
 * Answer = the chain's newest decision. Distractors = the most recent distinct
 * prior versions (they really existed, which is what makes them dangerous).
 * Option order is a seeded shuffle so the answer position carries no signal.
 */
export function buildQaItem(chain, seed) {
  const rows = chain.rows
  const current = rows[rows.length - 1]
  const currentNorm = normalizeText(current.decision)
  const seen = new Set([currentNorm])
  const distractors = []
  for (let i = rows.length - 2; i >= 0 && distractors.length < MAX_DISTRACTORS; i--) {
    const norm = normalizeText(rows[i].decision)
    if (seen.has(norm)) {
      continue
    }
    seen.add(norm)
    distractors.push(rows[i])
  }
  if (distractors.length === 0) {
    return null
  }

  const rand = mulberry32(seed)
  const optionRows = seededShuffle([current, ...distractors], rand)
  const options = optionRows.map((row, idx) => ({
    label: OPTION_LABELS[idx],
    text: row.decision.trim(),
    decisionId: row.id,
    isCurrent: row.id === current.id,
  }))
  const answer = options.find((o) => o.isCurrent)
  return {
    id: `delta_${chain.topic}`,
    qaType: "truth",
    topic: chain.topic,
    chainLength: rows.length,
    currentDecisionId: current.id,
    currentCreatedAt: current.created_at,
    question:
      `Topic: "${chain.topic}"\n` +
      "Which option states the CURRENT (most recent, still-valid) decision on this topic? " +
      "Earlier versions of the decision may appear as options - do not pick a superseded version. " +
      "Answer with the option letter only.",
    options,
    answerLabel: answer.label,
  }
}

/**
 * The revision rationale of a chain = the newest version's `reasoning`.
 * MAMA semantics: the newest row is the current truth, so its reasoning is why
 * the topic ended up at its current decision (the "why it was revised" answer).
 * Returns the trimmed reasoning, or null when the chain does not qualify:
 *  - fewer than 2 versions
 *  - current reasoning missing or shorter than MIN_REASONING_CHARS
 *  - current reasoning not distinct (normalized) from every prior version's
 *    reasoning (no real reasoning delta - would be a trivial or duplicate item)
 */
export function chainRevisionReasoning(chain) {
  const rows = chain && chain.rows
  if (!rows || rows.length < 2) {
    return null
  }
  const current = rows[rows.length - 1]
  const reasoning = (current.reasoning || "").trim()
  if (reasoning.length < MIN_REASONING_CHARS) {
    return null
  }
  const currentNorm = normalizeText(reasoning)
  for (let i = 0; i < rows.length - 1; i++) {
    if (normalizeText(rows[i].reasoning || "") === currentNorm) {
      return null
    }
  }
  return reasoning
}

/**
 * Build one lineage (L-type) multiple-choice item from a chain.
 * Answer = this chain's revision rationale (the newest version's reasoning).
 * Distractors = OTHER topics' revision rationales - real reasoning text drawn
 * from distractorPool ([{ topic, reasoning }]), never generated. The chain's own
 * topic is excluded and duplicate normalized texts are deduped. Option order is
 * a seeded shuffle so the answer position carries no signal. Deterministic given
 * seed. Returns null when the chain fails the reasoning filters or the pool has
 * no distinct distractor.
 */
export function buildLineageItem(chain, distractorPool, seed) {
  const answerReasoning = chainRevisionReasoning(chain)
  if (!answerReasoning) {
    return null
  }
  const rows = chain.rows
  const current = rows[rows.length - 1]
  const answerNorm = normalizeText(answerReasoning)
  const rand = mulberry32(seed)
  const seen = new Set([answerNorm])
  const pool = (distractorPool || []).filter((d) => d.topic !== chain.topic)
  const shuffledPool = seededShuffle(pool, rand)
  const distractors = []
  for (const cand of shuffledPool) {
    const text = (cand.reasoning || "").trim()
    const norm = normalizeText(text)
    if (norm.length === 0 || seen.has(norm)) {
      continue
    }
    seen.add(norm)
    distractors.push(text)
    if (distractors.length >= MAX_DISTRACTORS) {
      break
    }
  }
  if (distractors.length === 0) {
    return null
  }
  const optionRows = seededShuffle(
    [
      { text: answerReasoning, isAnswer: true },
      ...distractors.map((text) => ({ text, isAnswer: false })),
    ],
    rand
  )
  const options = optionRows.map((row, idx) => ({
    label: OPTION_LABELS[idx],
    text: row.text.trim(),
    isAnswer: row.isAnswer,
  }))
  const answer = options.find((o) => o.isAnswer)
  return {
    id: `lineage_${chain.topic}`,
    qaType: "lineage",
    topic: chain.topic,
    chainLength: rows.length,
    currentDecisionId: current.id,
    currentCreatedAt: current.created_at,
    // Full topic chain (oldest -> newest) so the oracle can render it perfectly
    // offline; the mama-lineage condition re-fetches the same chain from the DB.
    lineageChain: rows.map((r) => ({ decision: r.decision, reasoning: r.reasoning })),
    question:
      `Topic: "${chain.topic}"\n` +
      "Which statement describes why this topic's decision was revised? " +
      "Answer with the option letter only.",
    options,
    answerLabel: answer.label,
  }
}

/** Collapse whitespace and truncate a reasoning to a short head for a lineage block. */
export function reasoningHead(text, max = REASONING_HEAD_CHARS) {
  const clean = (text || "").replace(/\s+/g, " ").trim()
  if (clean.length === 0) {
    return "no reasoning recorded"
  }
  return clean.length <= max ? clean : clean.slice(0, max).trimEnd() + "..."
}

/**
 * Render a topic's full chain as an R2 lineage block (the reasoning-precompute
 * prototype under test):
 *   <topic>: v1 (<reasoning head>) -> v2 (<reasoning head>) -> CURRENT: <decision>
 * Prior versions surface their reasoning heads; the current version surfaces its
 * decision. rows must be oldest -> newest (each { decision, reasoning }).
 */
export function renderLineageBlock(topic, rows) {
  if (!rows || rows.length === 0) {
    return `${topic}: (no history)`
  }
  const priors = rows.slice(0, -1)
  const current = rows[rows.length - 1]
  const parts = priors.map((r, i) => `v${i + 1} (${reasoningHead(r.reasoning)})`)
  parts.push(`CURRENT: ${(current.decision || "").replace(/\s+/g, " ").trim()}`)
  return `${topic}: ${parts.join(" -> ")}`
}

/** Render the options block appended to every condition prompt. */
export function renderOptions(item) {
  return item.options.map((o) => `${o.label}) ${o.text}`).join("\n\n")
}

/**
 * Parse a model reply into an option label. Accepts "A", "A)", "**A**",
 * "Answer: A" etc. Only labels present on the item are valid.
 */
export function parseChoice(text, validLabels) {
  if (!text) {
    return null
  }
  const labels = validLabels.join("")
  const patterns = [
    new RegExp(`^\\s*\\**([${labels}])\\**\\s*[).:]?\\s*$`, "m"),
    new RegExp(`answer\\s*(?:is)?\\s*[:-]?\\s*\\**([${labels}])\\b`, "i"),
    new RegExp(`\\b([${labels}])\\b`),
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) {
      return m[1].toUpperCase()
    }
  }
  return null
}

/** Rough token estimate (chars/4) - labeled approximate everywhere it is shown. */
export function approxTokens(str) {
  return Math.ceil((str || "").length / 4)
}

/**
 * Aggregate per-condition results.
 * results: [{ itemId, condition, choice, answerLabel, valid, promptChars }]
 */
export function scoreResults(results) {
  const byCondition = new Map()
  for (const r of results) {
    if (!byCondition.has(r.condition)) {
      byCondition.set(r.condition, {
        condition: r.condition,
        n: 0,
        correct: 0,
        stale: 0,
        invalid: 0,
        promptChars: 0,
      })
    }
    const s = byCondition.get(r.condition)
    s.n += 1
    s.promptChars += r.promptChars || 0
    if (!r.choice) {
      s.invalid += 1
    } else if (r.choice === r.answerLabel) {
      s.correct += 1
    } else {
      s.stale += 1
    }
  }
  return [...byCondition.values()].map((s) => ({
    ...s,
    accuracy: s.n ? +(s.correct / s.n).toFixed(4) : null,
    staleRate: s.n ? +(s.stale / s.n).toFixed(4) : null,
    invalidRate: s.n ? +(s.invalid / s.n).toFixed(4) : null,
    approxTokensPerItem: s.n ? Math.round(s.promptChars / 4 / s.n) : null,
  }))
}
