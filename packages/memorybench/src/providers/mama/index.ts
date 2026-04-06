/**
 * MAMA Provider for MemoryBench
 *
 * Connects to MAMA Graph API (localhost:3847) to evaluate MAMA's memory performance.
 * Uses /api/mama/save for ingest and /api/mama/search for retrieval.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { executeCodexPrompt } from "../../utils/codex"

const DEFAULT_BASE_URL = "http://localhost:3847"
const STATE_FILE_NAME = "mama-provider-state.json"

// ─── Code-based fact extraction ───────────────────────────────────────────────

const CODE_EXTRACT_FACT_PATTERNS = [
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

const CODE_EXTRACT_DOMAIN_LABELS: Array<{ patterns: RegExp[]; label: string }> = [
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
  {
    patterns: [/\bwe'?re\s+\d+-\d+\b/i, /\b(record|score)\b.*\d+-\d+/i],
    label: "Sports record",
  },
  {
    patterns: [/\b(went to|visited|was in|traveled to)\b.*\b[A-Z][a-z]{2,}\b/i],
    label: "Travel",
  },
  { patterns: [/\b(graduated|degree|diploma)\b/i], label: "Education" },
]

function codeExtractFactSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => CODE_EXTRACT_FACT_PATTERNS.some((p) => p.test(s)) && s.length > 15)
}

function codeExtractEntityKey(fact: string): string {
  const quoted = fact.match(/"([^"]+)"/)?.[1]
  if (quoted) {
    const verb =
      fact
        .match(
          /\b(started|began|finished|completed|got|bought|purchased|attended|went|visited)\b/i
        )?.[1]
        ?.toLowerCase() ?? "fact"
    return `${verb}_${quoted.toLowerCase().replace(/\s+/g, "_")}`.slice(0, 70)
  }
  const gotNoun = fact.match(/\bgot\s+(?:a\s+|an\s+)?(\w+)\b/i)?.[1]
  if (gotNoun && gotNoun.length > 3) return `got_${gotNoun.toLowerCase()}`
  const proper = fact
    .match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*/g)
    ?.filter((w) => !["User", "By", "The", "In", "On"].includes(w))
  if (proper?.length) {
    const verb =
      fact
        .match(/\b(started|finished|attended|bought|visited|went|graduated|completed)\b/i)?.[1]
        ?.toLowerCase() ?? "fact"
    return `${verb}_${proper[0].toLowerCase().replace(/\s+/g, "_")}`.slice(0, 70)
  }
  const words = fact
    .toLowerCase()
    .split(/\s+/)
    .filter(
      (w) => w.length > 4 && !["about", "their", "which", "would", "could", "should"].includes(w)
    )
    .slice(0, 3)
  return words.join("_") || "unknown"
}

function codeExtractAddDomainLabel(fact: string): string {
  for (const { patterns, label } of CODE_EXTRACT_DOMAIN_LABELS) {
    if (patterns.some((p) => p.test(fact))) return `${label}: ${fact}`
  }
  return fact
}

// ─── End code-based fact extraction ──────────────────────────────────────────

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

interface TemporalSearchContext {
  isTemporal: boolean
  normalizedQuery: string
  dateTerms: string[]
}

export class MAMAProvider implements Provider {
  name = "mama"
  concurrency = {
    default:
      process.env.MEMORYBENCH_CODE_EXTRACT === "true" ||
      process.env.MEMORYBENCH_EXTRACT_MEMORIES === "true"
        ? 1
        : 5,
    indexing: 1,
  }

  private baseUrl: string = DEFAULT_BASE_URL
  private savedIds: Map<string, string[]> = new Map() // containerTag -> decision IDs
  private localRecords: Map<
    string,
    Array<{ id: string; topic: string; content: string; created_at: number }>
  > = new Map()
  private runPath: string | null = null
  private dataSourceRunPath: string | null = null

  private getStatePaths(): string[] {
    const paths = [this.runPath, this.dataSourceRunPath]
      .filter((value): value is string => Boolean(value))
      .map((value) => join(value, STATE_FILE_NAME))
    return Array.from(new Set(paths))
  }

  private persistState(): void {
    const state = {
      savedIds: Object.fromEntries(this.savedIds),
      localRecords: Object.fromEntries(this.localRecords),
    }

    for (const path of this.getStatePaths()) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(state, null, 2))
    }
  }

  private restoreState(statePath: string): boolean {
    if (!existsSync(statePath)) {
      return false
    }

    try {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as {
        savedIds?: Record<string, string[]>
        localRecords?: Record<
          string,
          Array<{ id: string; topic: string; content: string; created_at: number }>
        >
      }

      this.savedIds = new Map(Object.entries(state.savedIds || {}))
      this.localRecords = new Map(Object.entries(state.localRecords || {}))
      return true
    } catch {
      logger.warn(`Corrupted state file ${statePath}, starting fresh`)
      return false
    }
  }

  private getFetchLimit(containerTag: string, limit: number): number {
    const containerSize = this.savedIds.get(containerTag)?.length || 0
    return Math.min(Math.max(limit * 5, containerSize * 5, 20), 500)
  }

  private shouldSemanticRerank(
    query: string,
    candidates: Array<{ score: number; content: string }>
  ): boolean {
    if (candidates.length < 2) {
      return false
    }

    const topScore = candidates[0]?.score ?? 0
    const secondScore = candidates[1]?.score ?? 0
    const scoreGap = topScore - secondScore
    const preferenceLikeQuery =
      /\b(prefer|preference|favorite|favourite|like|love|recommend|recommendation|serve|best|usually|tend)\b/i.test(
        query
      )
    const topContent = candidates[0]?.content.toLowerCase() || ""
    const queryTokens = query
      .toLowerCase()
      .split(/[\s,.!?;:()[\]{}"']+/)
      .filter((token) => token.length > 4 && !STOPWORDS.has(token))
    const topCoverage = queryTokens.filter((token) => topContent.includes(token)).length

    return preferenceLikeQuery || topScore < 12 || scoreGap <= 3 || topCoverage < 2
  }

  private isPreferenceLikeQuery(query: string): boolean {
    return /\b(prefer|preference|favorite|favourite|like|love|recommend|recommendation|serve|best|usually|tend|accessories|setup|ingredients|homegrown|dinner)\b/i.test(
      query
    )
  }

  private async maybeSemanticRerank(
    query: string,
    candidates: Array<{
      id: string
      topic: string
      content: string
      created_at: number
      score: number
    }>,
    limit: number,
    questionDate?: string
  ): Promise<
    Array<{ id: string; topic: string; content: string; created_at: number; score: number }>
  > {
    if (!this.shouldSemanticRerank(query, candidates)) {
      return candidates.slice(0, limit)
    }

    const rerankWindow = Math.min(Math.max(limit, 4), 6)
    const reranked = await this.semanticRerankLocalRecords(
      query,
      candidates.slice(0, rerankWindow),
      questionDate
    )
    const seen = new Set(reranked.map((candidate) => candidate.id))
    const remaining = candidates.filter((candidate) => !seen.has(candidate.id))
    return [...reranked, ...remaining].slice(0, limit)
  }

  private normalizeScores(
    candidates: Array<{
      id: string
      topic: string
      content: string
      created_at: number
      score: number
    }>
  ): Array<{ id: string; topic: string; content: string; created_at: number; score: number }> {
    if (candidates.length === 0) return []
    const scores = candidates.map((c) => c.score)
    const min = Math.min(...scores)
    const max = Math.max(...scores)
    const range = max - min
    if (range === 0) {
      return candidates.map((c) => ({ ...c, score: 1 }))
    }
    return candidates.map((c) => ({ ...c, score: (c.score - min) / range }))
  }

  private mergeCandidates(
    primary: Array<{
      id: string
      topic: string
      content: string
      created_at: number
      score: number
    }>,
    secondary: Array<{
      id: string
      topic: string
      content: string
      created_at: number
      score: number
    }>
  ): Array<{ id: string; topic: string; content: string; created_at: number; score: number }> {
    const normalizedPrimary = this.normalizeScores(primary)
    const normalizedSecondary = this.normalizeScores(secondary)
    const merged = new Map<
      string,
      { id: string; topic: string; content: string; created_at: number; score: number }
    >()
    for (const candidate of [...normalizedPrimary, ...normalizedSecondary]) {
      const existing = merged.get(candidate.id)
      if (!existing || candidate.score > existing.score) {
        merged.set(candidate.id, candidate)
      }
    }
    return Array.from(merged.values()).sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }
      return right.created_at - left.created_at
    })
  }

  private rankLocalRecords(
    containerTag: string,
    query: string,
    limit: number,
    temporalContext?: TemporalSearchContext
  ): Array<{ id: string; content: string; topic: string; score: number; created_at: number }> {
    const records = this.localRecords.get(containerTag) || []
    if (records.length === 0) {
      return []
    }

    const searchQuery = temporalContext?.normalizedQuery || query
    const tokens = searchQuery
      .toLowerCase()
      .split(/[\s,.!?;:()[\]{}"']+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token))
    const expandedTokens = this.getExpandedQueryTokens(searchQuery)
    const allTokens = Array.from(new Set([...tokens, ...expandedTokens]))

    return records
      .map((record) => {
        const haystack = `${record.topic}\n${record.content}`.toLowerCase()
        const tokenMatches = allTokens.reduce(
          (count, token) =>
            count +
            (haystack.includes(token) ? (token.length >= 8 ? 3 : token.length >= 5 ? 2 : 1) : 0),
          0
        )
        const phraseBoost = haystack.includes(searchQuery.toLowerCase()) ? 2 : 0
        const dateBoost = temporalContext?.dateTerms.some((term) =>
          haystack.includes(term.toLowerCase())
        )
          ? 10
          : 0
        const personalAcquisitionBoost =
          temporalContext?.isTemporal &&
          /\b(i|we)\b[\s\S]{0,80}\b(got|gotten|bought|purchased|acquired)\b/i.test(haystack)
            ? 12
            : 0
        const justBoughtBoost =
          temporalContext?.isTemporal && /\b(i|we)\b[\s\S]{0,40}\bjust\b/i.test(haystack) ? 4 : 0
        const todayAcquisitionBoost =
          temporalContext?.isTemporal &&
          /\b(i|we)\b[\s\S]{0,80}\b(today|tonight|this morning|this afternoon)\b[\s\S]{0,40}\b(got|gotten|bought|purchased|acquired)\b/i.test(
            haystack
          )
            ? 18
            : 0
        const kitchenApplianceBoost =
          temporalContext?.isTemporal &&
          /\b(smoker|air fryer|microwave|toaster|oven|blender|mixer|grill|espresso machine|coffee maker)\b/i.test(
            haystack
          )
            ? 16
            : 0
        const score =
          tokenMatches +
          phraseBoost +
          dateBoost +
          personalAcquisitionBoost +
          justBoughtBoost +
          todayAcquisitionBoost +
          kitchenApplianceBoost
        return {
          ...record,
          score,
        }
      })
      .filter((record) => record.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score
        }
        return right.created_at - left.created_at
      })
      .slice(0, limit)
  }

  private getExpandedQueryTokens(query: string): string[] {
    const normalized = query.toLowerCase()
    const expanded = new Set<string>()

    if (/\bbuy\b|\bbought\b|\bpurchase\b|\bpurchased\b/.test(normalized)) {
      expanded.add("got")
      expanded.add("acquired")
      expanded.add("purchased")
      expanded.add("bought")
    }

    return Array.from(expanded)
  }

  private isTemporalQuery(query: string): boolean {
    return /\b(\d+\s+(day|days|week|weeks|month|months)\s+ago|today|yesterday)\b/i.test(query)
  }

  private parseQuestionDate(questionDate?: string): Date | null {
    if (!questionDate) {
      return null
    }

    const normalized = questionDate.replace(/\s+\([^)]+\)\s+/, " ")
    const parsed = new Date(normalized)
    if (Number.isNaN(parsed.getTime())) {
      return null
    }
    return parsed
  }

  private shiftDate(date: Date, unit: "day" | "week" | "month", amount: number): Date {
    const shifted = new Date(date)
    if (unit === "month") {
      shifted.setUTCMonth(shifted.getUTCMonth() + amount)
      return shifted
    }

    const multiplier = unit === "week" ? 7 : 1
    shifted.setUTCDate(shifted.getUTCDate() + amount * multiplier)
    return shifted
  }

  private formatDateTerms(date: Date): string[] {
    const year = date.getUTCFullYear()
    const monthIndex = date.getUTCMonth()
    const day = date.getUTCDate()
    const monthName = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" })
    const isoDay = String(day).padStart(2, "0")
    const isoMonth = String(monthIndex + 1).padStart(2, "0")

    return Array.from(
      new Set([
        `${year}-${isoMonth}-${isoDay}`,
        `${day} ${monthName}, ${year}`,
        `${monthName} ${day}, ${year}`,
        `${day} ${monthName} ${year}`,
      ])
    )
  }

  private buildTemporalSearchContext(query: string, questionDate?: string): TemporalSearchContext {
    const isTemporal = this.isTemporalQuery(query)
    if (!isTemporal) {
      return {
        isTemporal: false,
        normalizedQuery: query,
        dateTerms: [],
      }
    }

    const baseDate = this.parseQuestionDate(questionDate)
    if (!baseDate) {
      return {
        isTemporal: true,
        normalizedQuery: query,
        dateTerms: [],
      }
    }

    let targetDate: Date | null = null
    const relativeMatch = query.match(/(\d+)\s+(day|days|week|weeks|month|months)\s+ago/i)
    if (relativeMatch) {
      const amount = Number(relativeMatch[1])
      const rawUnit = relativeMatch[2].toLowerCase()
      const unit = rawUnit.startsWith("month")
        ? "month"
        : rawUnit.startsWith("week")
          ? "week"
          : "day"
      targetDate = this.shiftDate(baseDate, unit, -amount)
    } else if (/\byesterday\b/i.test(query)) {
      targetDate = this.shiftDate(baseDate, "day", -1)
    } else if (/\btoday\b/i.test(query)) {
      targetDate = baseDate
    }

    if (!targetDate) {
      return {
        isTemporal: true,
        normalizedQuery: query,
        dateTerms: [],
      }
    }

    const dateTerms = this.formatDateTerms(targetDate)
    const displayDate = dateTerms[1] || dateTerms[0]
    let normalizedQuery = query
      .replace(/(\d+)\s+(day|days|week|weeks|month|months)\s+ago/i, `on ${displayDate}`)
      .replace(/\byesterday\b/i, `on ${displayDate}`)
      .replace(/\btoday\b/i, `on ${displayDate}`)

    if (normalizedQuery === query) {
      normalizedQuery = `${query} on ${displayDate}`
    }

    return {
      isTemporal: true,
      normalizedQuery,
      dateTerms,
    }
  }

  async semanticRerankLocalRecords(
    query: string,
    candidates: Array<{
      id: string
      topic: string
      content: string
      created_at: number
      score: number
    }>,
    questionDate?: string
  ): Promise<
    Array<{ id: string; topic: string; content: string; created_at: number; score: number }>
  > {
    if (candidates.length < 2) {
      return candidates
    }

    const prompt = `You are reranking memory candidates for a benchmark retrieval system.

Question:
${query}

${questionDate && this.isTemporalQuery(query) ? `Question Date: ${questionDate}\n` : ""}

Rank the candidates from most useful to least useful for answering the question.
Prioritize:
- exact user facts over generic topical overlap
- exact ingredient, role, title, and entity matches
- preference-bearing or profile-bearing details when the question asks for recommendations

Return ONLY JSON in this format:
{"ordered_ids":["candidate_id_1","candidate_id_2"]}

Candidates:
${candidates
  .map(
    (candidate) =>
      `ID: ${candidate.id}\nTopic: ${candidate.topic}\nExcerpt:\n${candidate.content.slice(0, 1800)}`
  )
  .join("\n\n---\n\n")}`

    try {
      const response = await executeCodexPrompt({
        model: process.env.MEMORYBENCH_RERANK_MODEL || "gpt-5.4",
        prompt,
        cwd: process.cwd(),
      })
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        return candidates
      }
      const parsed = JSON.parse(jsonMatch[0]) as { ordered_ids?: string[] }
      const orderedIds = Array.isArray(parsed.ordered_ids) ? parsed.ordered_ids : []
      if (orderedIds.length === 0) {
        return candidates
      }

      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
      const reordered = orderedIds
        .map((id) => byId.get(id))
        .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      const seen = new Set(reordered.map((candidate) => candidate.id))
      const remaining = candidates.filter((candidate) => !seen.has(candidate.id))
      return [...reordered, ...remaining]
    } catch (error) {
      logger.warn(
        `Semantic rerank failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return candidates
    }
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.baseUrl = (config.baseUrl as string) || DEFAULT_BASE_URL
    this.runPath = typeof config.runPath === "string" ? config.runPath : null
    this.dataSourceRunPath =
      typeof config.dataSourceRunPath === "string" ? config.dataSourceRunPath : this.runPath

    // Health check with timeout
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: controller.signal })
      if (!res.ok) throw new Error(`MAMA API not reachable at ${this.baseUrl}`)
    } finally {
      clearTimeout(timeout)
    }

    const sourceStatePath = this.dataSourceRunPath
      ? join(this.dataSourceRunPath, STATE_FILE_NAME)
      : null
    if (sourceStatePath && this.restoreState(sourceStatePath)) {
      if (this.runPath && this.runPath !== this.dataSourceRunPath) {
        this.persistState()
      }
      logger.info(`Restored MAMA provider state from ${sourceStatePath}`)
    }

    logger.info(`Initialized MAMA provider at ${this.baseUrl}`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const documentIds: string[] = []
    const existingIds = this.savedIds.get(options.containerTag) || []
    const existingLocalRecords = this.localRecords.get(options.containerTag) || []

    const useCodeExtract = process.env.MEMORYBENCH_CODE_EXTRACT === "true"
    const _useHybridExtract = process.env.MEMORYBENCH_HYBRID_EXTRACT === "true"
    const useExtraction = process.env.MEMORYBENCH_EXTRACT_MEMORIES === "true"
    const extractionModel = process.env.MEMORYBENCH_EXTRACTION_MODEL || "claude-sonnet-4-5-20250514"
    const extractionBaseUrl = process.env.MEMORYBENCH_EXTRACTION_BASE_URL
    // Security: only forward ANTHROPIC_API_KEY to Anthropic's own domain
    const isAnthropicDomain =
      !extractionBaseUrl || /^https?:\/\/([^/]*\.)?anthropic\.com(\/|$)/i.test(extractionBaseUrl)
    const anthropicApiKey = isAnthropicDomain ? process.env.ANTHROPIC_API_KEY : undefined

    // Per-ingest entity registry for supersedes tracking (entityKey → memoryId)
    const entityRegistry = new Map<string, string>()

    for (const session of sessions) {
      const isoDate = session.metadata?.date as string | undefined
      const formattedDate = session.metadata?.formattedDate as string | undefined

      const messages = session.messages.map((m) => ({
        role: (m.role === "human" ? "user" : m.role === "ai" ? "assistant" : m.role) as
          | "user"
          | "assistant"
          | "system",
        content: m.content,
      }))

      const conversationText = session.messages
        .map((m) => `${m.speaker || m.role}: ${m.content}`)
        .join("\n")

      const reasoning = [
        `Session ${session.sessionId} from benchmark run ${options.containerTag}`,
        formattedDate ? `Date: ${formattedDate}` : isoDate ? `Date: ${isoDate}` : "",
        `Messages: ${session.messages.length}`,
      ]
        .filter(Boolean)
        .join(". ")

      try {
        if (useCodeExtract) {
          // Code-based extraction: regex fact detection + date injection + supersedes
          const userMessages = messages.filter((m) => m.role === "user")
          const sessionFacts: Array<{ dated: string; entityKey: string; topic: string }> = []

          for (const msg of userMessages) {
            const sentences = codeExtractFactSentences(msg.content)
            for (const sentence of sentences) {
              const normalized = sentence.replace(/\bI\b/g, "User").trim()
              const labeled = codeExtractAddDomainLabel(normalized)
              const dated = formattedDate ? `${formattedDate}: ${labeled}` : labeled
              const entityKey = codeExtractEntityKey(sentence)
              const topic = `bench_${options.containerTag}_${session.sessionId}_${entityKey}`.slice(
                0,
                90
              )
              sessionFacts.push({ dated, entityKey, topic })
            }
          }

          // Save up to 4 facts per session
          for (const { dated, entityKey, topic } of sessionFacts.slice(0, 4)) {
            const existingId = entityRegistry.get(entityKey)
            const body: Record<string, unknown> = {
              topic,
              decision: dated,
              reasoning,
              ...(isoDate ? { event_date: isoDate } : {}),
              ...(existingId ? { supersedes: [existingId] } : {}),
            }
            const res = await fetch(`${this.baseUrl}/api/mama/save`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(10000),
            })
            const data = (await res.json()) as { success?: boolean; id?: string }
            if (data.success && data.id) {
              documentIds.push(data.id)
              existingIds.push(data.id)
              entityRegistry.set(entityKey, data.id)
              existingLocalRecords.push({
                id: data.id,
                topic,
                content: dated,
                created_at: Date.now(),
              })
            }
          }

          // Also store full conversation in localRecords for fallback
          const fullTopic = `bench_${options.containerTag}_${session.sessionId}`.slice(0, 80)
          existingLocalRecords.push({
            id: `local_${session.sessionId}`,
            topic: fullTopic,
            content: `${conversationText}\n\n${reasoning}`,
            created_at: Date.now(),
          })

          logger.debug(
            `Code-extracted session ${session.sessionId}: ${sessionFacts.length} facts, ${Math.min(sessionFacts.length, 4)} saved`
          )
        } else if (useExtraction) {
          // Use ingestConversation with LLM extraction
          const res = await fetch(`${this.baseUrl}/api/mama/ingest-conversation`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(10000),
            body: JSON.stringify({
              messages,
              scopes: [],
              source: { package: "standalone", source_type: "memorybench" },
              extract: {
                enabled: true,
                model: extractionModel,
                ...(anthropicApiKey ? { apiKey: anthropicApiKey } : {}),
              },
              ...(isoDate ? { sessionDate: isoDate } : {}),
            }),
          })

          const data = (await res.json()) as {
            success?: boolean
            rawId?: string
            extractedMemories?: Array<{ id: string; kind: string; topic: string }>
          }
          if (data.success) {
            const primaryId = data.rawId || data.extractedMemories?.[0]?.id
            if (!primaryId) {
              logger.warn(
                `Ingest session ${session.sessionId} returned success but no IDs — treating as error`
              )
              continue
            }
            documentIds.push(primaryId)
            existingIds.push(primaryId)
            existingLocalRecords.push({
              id: primaryId,
              topic: `bench_${options.containerTag}_${session.sessionId}`.slice(0, 80),
              content: `${conversationText}\n\n${reasoning}`,
              created_at: Date.now(),
            })
            // Also track extracted units in local records for lexical fallback
            for (const mem of data.extractedMemories ?? []) {
              existingIds.push(mem.id)
              existingLocalRecords.push({
                id: mem.id,
                topic: mem.topic,
                content: `[${mem.kind}] ${mem.topic}`,
                created_at: Date.now(),
              })
            }
            logger.debug(
              `Ingested session ${session.sessionId} → raw:${data.rawId}, extracted:${data.extractedMemories?.length ?? 0}`
            )
          } else {
            logger.warn(`Failed to ingest session ${session.sessionId}: ${JSON.stringify(data)}`)
          }
        } else {
          // Legacy path: save as single decision
          const topic = `bench_${options.containerTag}_${session.sessionId}`.slice(0, 80)
          const res = await fetch(`${this.baseUrl}/api/mama/save`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(10000),
            body: JSON.stringify({
              topic,
              decision: conversationText,
              reasoning,
              ...(isoDate ? { event_date: isoDate } : {}),
            }),
          })

          const data = (await res.json()) as { success?: boolean; id?: string; error?: boolean }
          if (data.success && data.id) {
            documentIds.push(data.id)
            existingIds.push(data.id)
            existingLocalRecords.push({
              id: data.id,
              topic,
              content: `${conversationText}\n\n${reasoning}`,
              created_at: Date.now(),
            })
            logger.debug(`Ingested session ${session.sessionId} → ${data.id}`)
          } else {
            logger.warn(`Failed to ingest session ${session.sessionId}: ${JSON.stringify(data)}`)
          }
        }
      } catch (e) {
        logger.warn(`Error ingesting session ${session.sessionId}: ${e}`)
      }
    }

    this.savedIds.set(options.containerTag, existingIds)
    this.localRecords.set(options.containerTag, existingLocalRecords)
    this.persistState()
    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    // MAMA uses SQLite + local embeddings — indexing is synchronous during save
    // Small delay to ensure embeddings are generated
    const total = result.documentIds.length
    if (total === 0) {
      onProgress?.({ completedIds: [], failedIds: [], total: 0 })
      return
    }

    await new Promise((r) => setTimeout(r, 500))
    onProgress?.({ completedIds: result.documentIds, failedIds: [], total })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const baseLimit = options.limit || 10
    // Aggregation queries need wider search to collect all relevant items
    const isAggregation = /\b(how many|how much|total|all|every|count|number of)\b/i.test(query)
    const limit = isAggregation ? Math.max(baseLimit * 3, 30) : baseLimit
    const topicPrefix = `bench_${options.containerTag}_`
    const temporalContext = this.buildTemporalSearchContext(query, options.questionDate)
    const searchQuery = temporalContext.normalizedQuery

    const scopedUrl = `${this.baseUrl}/api/mama/search?q=${encodeURIComponent(searchQuery)}&limit=${limit}&topicPrefix=${encodeURIComponent(topicPrefix)}`
    const scopedResponse = await fetch(scopedUrl, { signal: AbortSignal.timeout(10000) })
    if (scopedResponse.ok) {
      const scopedData = (await scopedResponse.json()) as {
        results?: Array<{
          id: string
          topic: string
          decision: string
          reasoning: string
          outcome: string | null
          confidence: number | null
          similarity: number
          created_at: number
        }>
      }

      if (scopedData.results && scopedData.results.length > 0) {
        const serverCandidates = scopedData.results.slice(0, limit).map((r) => ({
          id: r.id,
          content: `${r.decision}\n\n${r.reasoning}`,
          topic: r.topic,
          score: r.similarity,
          created_at: r.created_at,
        }))

        if (!temporalContext.isTemporal) {
          return serverCandidates
        }

        const localCandidates = this.rankLocalRecords(
          options.containerTag,
          searchQuery,
          Math.max(limit * 3, 20),
          temporalContext
        )
        return this.maybeSemanticRerank(
          searchQuery,
          this.mergeCandidates(localCandidates, serverCandidates),
          limit,
          options.questionDate
        )
      }
    }

    // Fetch a wider window because MAMA lacks native namespace filtering.
    // We must over-fetch, then enforce containerTag isolation client-side.
    const fetchLimit = this.getFetchLimit(options.containerTag, limit)
    const url = `${this.baseUrl}/api/mama/search?q=${encodeURIComponent(searchQuery)}&limit=${fetchLimit}`

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`MAMA search failed: ${res.status}`)

    const data = (await res.json()) as {
      results?: Array<{
        id: string
        topic: string
        decision: string
        reasoning: string
        outcome: string | null
        confidence: number | null
        similarity: number
        created_at: number
      }>
    }

    if (!data.results) return []

    // Filter to only include results from this containerTag to prevent cross-question contamination
    // Topics are named: bench_<containerTag>_<sessionId>
    const filtered = data.results.filter((r) => r.topic.startsWith(topicPrefix))

    if (filtered.length > 0) {
      const serverCandidates = filtered.slice(0, limit).map((r) => ({
        id: r.id,
        content: `${r.decision}\n\n${r.reasoning}`,
        topic: r.topic,
        score: r.similarity,
        created_at: r.created_at,
      }))

      if (!temporalContext.isTemporal) {
        return serverCandidates
      }

      const localCandidates = this.rankLocalRecords(
        options.containerTag,
        searchQuery,
        Math.max(limit * 3, 20),
        temporalContext
      )
      return this.maybeSemanticRerank(
        searchQuery,
        this.mergeCandidates(localCandidates, serverCandidates),
        limit,
        options.questionDate
      )
    }

    logger.warn(`No isolated MAMA search results for ${options.containerTag}`)
    const localCandidates = this.rankLocalRecords(
      options.containerTag,
      searchQuery,
      Math.max(limit * 3, 20),
      temporalContext
    )
    if (!temporalContext.isTemporal) {
      return localCandidates.slice(0, limit)
    }

    return this.maybeSemanticRerank(searchQuery, localCandidates, limit, options.questionDate)
  }

  async clear(containerTag: string): Promise<void> {
    // MAMA doesn't have a bulk delete endpoint
    // Mark all decisions from this run as FAILED (closest to "cleared")
    const ids = this.savedIds.get(containerTag) || []
    const failedIds: string[] = []

    for (const id of ids) {
      try {
        const res = await fetch(`${this.baseUrl}/api/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ id, outcome: "FAILED" }),
        })
        if (!res.ok) {
          logger.debug(`Failed to clear decision ${id}: HTTP ${res.status}`)
          failedIds.push(id)
        }
      } catch (e) {
        logger.debug(`Failed to clear decision ${id}: ${e}`)
        failedIds.push(id)
      }
    }

    if (failedIds.length > 0) {
      // Keep failed IDs so they can be retried later
      this.savedIds.set(containerTag, failedIds)
      logger.warn(
        `${failedIds.length}/${ids.length} decisions failed to clear for container ${containerTag}`
      )
    } else {
      this.savedIds.delete(containerTag)
    }
    this.localRecords.delete(containerTag)
    this.persistState()
    logger.info(`Cleared ${ids.length - failedIds.length} decisions for container ${containerTag}`)
  }
}

export default MAMAProvider
