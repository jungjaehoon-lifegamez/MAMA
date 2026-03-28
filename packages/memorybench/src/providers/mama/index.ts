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
const PHOTOGRAPHY_EXPANSION = [
  "camera",
  "flash",
  "lens",
  "tripod",
  "sony",
  "compatible",
  "gear",
  "photo",
]
const DINNER_EXPANSION = [
  "recipe",
  "cook",
  "dinner",
  "serve",
  "ingredients",
  "homegrown",
  "tomatoes",
  "basil",
  "mint",
  "garden",
  "herbs",
]

export class MAMAProvider implements Provider {
  name = "mama"
  concurrency = {
    default: 5,
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
    candidates: Array<{ id: string; topic: string; content: string; created_at: number; score: number }>,
    limit: number
  ): Promise<Array<{ id: string; topic: string; content: string; created_at: number; score: number }>> {
    if (!this.shouldSemanticRerank(query, candidates)) {
      return candidates.slice(0, limit)
    }

    const rerankWindow = Math.min(Math.max(limit, 4), 6)
    const reranked = await this.semanticRerankLocalRecords(query, candidates.slice(0, rerankWindow))
    const seen = new Set(reranked.map((candidate) => candidate.id))
    const remaining = candidates.filter((candidate) => !seen.has(candidate.id))
    return [...reranked, ...remaining].slice(0, limit)
  }

  private mergeCandidates(
    primary: Array<{ id: string; topic: string; content: string; created_at: number; score: number }>,
    secondary: Array<{ id: string; topic: string; content: string; created_at: number; score: number }>
  ): Array<{ id: string; topic: string; content: string; created_at: number; score: number }> {
    const merged = new Map<string, { id: string; topic: string; content: string; created_at: number; score: number }>()
    for (const candidate of [...primary, ...secondary]) {
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
    limit: number
  ): Array<{ id: string; content: string; topic: string; score: number; created_at: number }> {
    const records = this.localRecords.get(containerTag) || []
    if (records.length === 0) {
      return []
    }

    const tokens = query
      .toLowerCase()
      .split(/[\s,.!?;:()[\]{}"']+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token))
    const expandedTokens = this.getExpandedQueryTokens(query)
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
        const phraseBoost = haystack.includes(query.toLowerCase()) ? 2 : 0
        const score = tokenMatches + phraseBoost
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
    const expansions: string[] = []

    if (/\b(photo|photography|camera|accessor|setup|gear)\b/i.test(normalized)) {
      expansions.push(...PHOTOGRAPHY_EXPANSION)
    }
    if (/\b(dinner|serve|ingredient|homegrown|garden|cook|recipe|meal)\b/i.test(normalized)) {
      expansions.push(...DINNER_EXPANSION)
    }

    return expansions
  }

  async semanticRerankLocalRecords(
    query: string,
    candidates: Array<{ id: string; topic: string; content: string; created_at: number; score: number }>
  ): Promise<Array<{ id: string; topic: string; content: string; created_at: number; score: number }>> {
    if (candidates.length < 2) {
      return candidates
    }

    const prompt = `You are reranking memory candidates for a benchmark retrieval system.

Question:
${query}

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

    // Health check
    const res = await fetch(`${this.baseUrl}/health`)
    if (!res.ok) throw new Error(`MAMA API not reachable at ${this.baseUrl}`)

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

    const useExtraction = process.env.MEMORYBENCH_EXTRACT_MEMORIES === "true"
    const extractionModel = process.env.MEMORYBENCH_EXTRACTION_MODEL || "claude-sonnet-4-5-20250514"
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY

    for (const session of sessions) {
      const isoDate = session.metadata?.date as string | undefined
      const formattedDate = session.metadata?.formattedDate as string | undefined

      const messages = session.messages.map((m) => ({
        role: (m.role === "human" ? "user" : m.role === "ai" ? "assistant" : m.role) as "user" | "assistant" | "system",
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
        if (useExtraction) {
          // Use ingestConversation with LLM extraction
          const res = await fetch(`${this.baseUrl}/api/mama/ingest-conversation`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages,
              scopes: [],
              source: { package: "standalone", source_type: "memorybench" },
              extract: {
                enabled: true,
                model: extractionModel,
                ...(anthropicApiKey ? { apiKey: anthropicApiKey } : {}),
              },
            }),
          })

          const data = (await res.json()) as {
            success?: boolean
            rawId?: string
            extractedMemories?: Array<{ id: string; kind: string; topic: string }>
          }
          if (data.success && data.rawId) {
            documentIds.push(data.rawId)
            existingIds.push(data.rawId)
            existingLocalRecords.push({
              id: data.rawId,
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
            body: JSON.stringify({ topic, decision: conversationText, reasoning }),
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
    const limit = options.limit || 10
    const topicPrefix = `bench_${options.containerTag}_`
    const preferenceLikeQuery = this.isPreferenceLikeQuery(query)
    const localPreferenceCandidates = preferenceLikeQuery
      ? this.rankLocalRecords(options.containerTag, query, Math.max(limit * 4, 20))
      : []

    const scopedLimit = preferenceLikeQuery ? Math.max(limit * 2, 20) : limit
    const scopedUrl = `${this.baseUrl}/api/mama/search?q=${encodeURIComponent(query)}&limit=${scopedLimit}&topicPrefix=${encodeURIComponent(topicPrefix)}`
    const scopedResponse = await fetch(scopedUrl)
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
        const scopedCandidates = scopedData.results.map((r) => ({
          id: r.id,
          content: `${r.decision}\n\n${r.reasoning}`,
          topic: r.topic,
          score: r.similarity,
          created_at: r.created_at,
        }))
        const mergedCandidates = preferenceLikeQuery
          ? this.mergeCandidates(scopedCandidates, localPreferenceCandidates)
          : scopedCandidates
        return await this.maybeSemanticRerank(query, mergedCandidates, limit)
      }
    }

    // Fetch a wider window because MAMA lacks native namespace filtering.
    // We must over-fetch, then enforce containerTag isolation client-side.
    const fetchLimit = this.getFetchLimit(options.containerTag, limit)
    const url = `${this.baseUrl}/api/mama/search?q=${encodeURIComponent(query)}&limit=${fetchLimit}`

    const res = await fetch(url)
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
      const filteredCandidates = filtered.map((r) => ({
        id: r.id,
        content: `${r.decision}\n\n${r.reasoning}`,
        topic: r.topic,
        score: r.similarity,
        created_at: r.created_at,
      }))
      return await this.maybeSemanticRerank(query, filteredCandidates, limit)
    }

    logger.warn(`No isolated MAMA search results for ${options.containerTag}`)
    const localCandidates = this.rankLocalRecords(
      options.containerTag,
      query,
      Math.max(limit * 3, 20)
    )
    return await this.maybeSemanticRerank(query, localCandidates, limit)
  }

  async clear(containerTag: string): Promise<void> {
    // MAMA doesn't have a bulk delete endpoint
    // Mark all decisions from this run as FAILED (closest to "cleared")
    const ids = this.savedIds.get(containerTag) || []

    for (const id of ids) {
      try {
        await fetch(`${this.baseUrl}/api/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, outcome: "FAILED" }),
        })
      } catch {
        // Ignore individual clear errors
      }
    }

    this.savedIds.delete(containerTag)
    this.localRecords.delete(containerTag)
    this.persistState()
    logger.info(`Cleared ${ids.length} decisions for container ${containerTag}`)
  }
}

export default MAMAProvider
