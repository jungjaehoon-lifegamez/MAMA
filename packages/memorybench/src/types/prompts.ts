export type JudgePromptResult = Record<string, string> & { default: string }
export type JudgePromptFunction = (
  question: string,
  groundTruth: string,
  hypothesis: string
) => JudgePromptResult

const MAX_CONTEXT_RESULTS = 6
const MAX_CONTEXT_EXCERPT_CHARS = 1200
const EXCERPT_WINDOW_CHARS = 400
const MAX_CLUES_PER_TYPE = 10
const MAX_CLUE_CHARS = 220
// Synced from mama-core/src/memory/api.ts LEXICAL_STOPWORDS
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
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
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
])
const NUMBER_WORDS =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|year|years|month|months|week|weeks|day|days)\b/i
const NUMERIC_PATTERN = new RegExp(`\\d|${NUMBER_WORDS.source}`, "i")
const TEMPORAL_PATTERN =
  /\b(initially|initial|now|current|currently|again|since|after|before|when|while|today|yesterday|tomorrow|started|start|first|latest|earlier|later|year|month|week|day)\b/i
const PREFERENCE_PATTERN =
  /\b(prefer|preference|favorite|favourite|love|like|enjoy|want|recommend|serve|best|usually|tend|homegrown|compatible|durable|showcase)\b/i

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value
  }
  return `${value.slice(0, limit)}...`
}

function getQueryTokens(query?: string): string[] {
  if (!query) {
    return []
  }

  return query
    .toLowerCase()
    .split(/[\s,.!?;:()[\]{}"']+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token))
}

function extractRelevantExcerpt(content: string, query?: string): string {
  const normalized = content.replace(/\s+/g, " ").trim()
  const tokens = getQueryTokens(query)
  if (tokens.length === 0) {
    return truncateText(normalized, MAX_CONTEXT_EXCERPT_CHARS)
  }

  // Multi-window: find ALL token matches, deduplicate overlapping windows, combine
  const lower = normalized.toLowerCase()
  const windows: Array<{ start: number; end: number; score: number }> = []

  for (const token of tokens) {
    let searchFrom = 0
    while (searchFrom < lower.length) {
      const index = lower.indexOf(token, searchFrom)
      if (index === -1) break
      const start = Math.max(0, index - EXCERPT_WINDOW_CHARS / 2)
      const end = Math.min(normalized.length, index + EXCERPT_WINDOW_CHARS / 2)
      windows.push({ start, end, score: token.length })
      searchFrom = index + token.length
    }
  }

  if (windows.length === 0) {
    return truncateText(normalized, MAX_CONTEXT_EXCERPT_CHARS)
  }

  // Sort by score (longest token first), then merge overlapping windows
  windows.sort((a, b) => b.score - a.score || a.start - b.start)

  const merged: Array<{ start: number; end: number }> = []
  let totalChars = 0

  for (const w of windows) {
    if (totalChars >= MAX_CONTEXT_EXCERPT_CHARS) break

    // Check overlap with existing merged windows
    const overlapping = merged.findIndex((m) => w.start <= m.end && w.end >= m.start)
    if (overlapping >= 0) {
      // Extend existing window
      const m = merged[overlapping]
      const oldSize = m.end - m.start
      m.start = Math.min(m.start, w.start)
      m.end = Math.max(m.end, w.end)
      totalChars += m.end - m.start - oldSize
    } else {
      merged.push({ start: w.start, end: w.end })
      totalChars += w.end - w.start
    }
  }

  // Sort merged windows by position and combine with "..." separator
  merged.sort((a, b) => a.start - b.start)
  const excerpts = merged.map((m) => normalized.slice(m.start, m.end).trim())
  return truncateText(excerpts.join(" ... "), MAX_CONTEXT_EXCERPT_CHARS)
}

function splitIntoSegments(content: string): string[] {
  return content
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

function getRelevantSegments(content: string, query?: string): string[] {
  const segments = splitIntoSegments(content)
  const tokens = getQueryTokens(query)
  if (segments.length === 0) {
    return []
  }

  return segments
    .map((segment) => {
      const normalized = segment.toLowerCase()
      const tokenScore = tokens.reduce(
        (score, token) => score + (normalized.includes(token) ? token.length : 0),
        0
      )
      return { segment, score: tokenScore }
    })
    .sort((left, right) => right.score - left.score)
    .map((item) => item.segment)
}

function collectClues(content: string, query: string | undefined, pattern: RegExp): string[] {
  const preferred = getRelevantSegments(content, query).filter((segment) => pattern.test(segment))
  const fallback = splitIntoSegments(content).filter((segment) => pattern.test(segment))
  const merged = [...preferred, ...fallback]
  const deduped: string[] = []

  for (const segment of merged) {
    if (!deduped.includes(segment)) {
      deduped.push(segment)
    }
    if (deduped.length >= MAX_CLUES_PER_TYPE) {
      break
    }
  }

  return deduped.map((segment) => truncateText(segment, MAX_CLUE_CHARS))
}

function compactContextEntry(entry: unknown, index: number, query?: string): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return entry
  }

  const record = entry as Record<string, unknown>
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.decision === "string"
        ? `${record.decision}${typeof record.reasoning === "string" ? `\n\n${record.reasoning}` : ""}`
        : JSON.stringify(record)

  return {
    rank: index + 1,
    id: record.id ?? null,
    topic: record.topic ?? null,
    score:
      typeof record.score === "number"
        ? Number(record.score.toFixed(4))
        : typeof record.similarity === "number"
          ? Number(record.similarity.toFixed(4))
          : null,
    created_at: record.created_at ?? null,
    relevance_snippet: extractRelevantExcerpt(content, query),
    numeric_clues: collectClues(content, query, NUMERIC_PATTERN),
    time_clues: collectClues(content, query, TEMPORAL_PATTERN),
    preference_clues: collectClues(content, query, PREFERENCE_PATTERN),
  }
}

export interface ProviderPrompts {
  answerPrompt?: string | ((question: string, context: unknown[], questionDate?: string) => string)
  judgePrompt?: JudgePromptFunction
}

export function buildContextString(context: unknown[], query?: string): string {
  const compacted = context
    .slice(0, MAX_CONTEXT_RESULTS)
    .map((entry, index) => compactContextEntry(entry, index, query))
  return JSON.stringify(compacted, null, 2)
}
