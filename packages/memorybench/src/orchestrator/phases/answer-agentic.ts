/**
 * Agentic Answer Phase
 *
 * Instead of using a single pre-fetched search result, this phase runs
 * iterative query expansion:
 *   1. Search with the original question
 *   2. Ask LLM to generate alternative queries based on what was found
 *   3. Run up to 2 more searches with refined queries
 *   4. Merge all results (dedup by id), answer with the combined context
 *
 * Activated by: MEMORYBENCH_AGENTIC_SEARCH=true
 * Max iterations: MEMORYBENCH_AGENTIC_MAX_ITER (default 3)
 */

import { mkdirSync, existsSync, writeFileSync } from "fs"
import { join } from "path"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { getModelConfig, DEFAULT_ANSWERING_MODEL } from "../../utils/models"
import { buildDefaultAnswerPrompt } from "../../prompts/defaults"
import { buildContextString } from "../../types/prompts"
import { generateTextForModel } from "../../utils/text-generation"
import { countTokens } from "../../utils/tokens"

const DEFAULT_MAX_ITER = 3

function getMaxIter(): number {
  const parsed = Number.parseInt(process.env.MEMORYBENCH_AGENTIC_MAX_ITER || "", 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_ITER
}

async function expandQuery(
  question: string,
  previousResults: unknown[],
  modelConfig: ReturnType<typeof getModelConfig>
): Promise<string> {
  const snippet = buildContextString(previousResults.slice(0, 3), question)
  const prompt = `You are helping search a personal memory database.

Original question: "${question}"

Results found so far (top 3):
${snippet || "(none)"}

Generate ONE alternative search query that might find additional relevant memories not captured by the original question. The query should be concise (5-15 words), different from the original, and focus on a different angle or synonym.

Respond with ONLY the alternative query, no explanation.`

  const text = await generateTextForModel(modelConfig, prompt)
  return text.trim().replace(/^["']|["']$/g, "")
}

function mergeResults(allResults: unknown[][]): unknown[] {
  const seen = new Set<string>()
  const merged: unknown[] = []
  for (const results of allResults) {
    for (const r of results) {
      const id = (r as { id?: string }).id
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      merged.push(r)
    }
  }
  // Sort by score descending
  return merged.sort(
    (a, b) => ((b as { score?: number }).score ?? 0) - ((a as { score?: number }).score ?? 0)
  )
}

export async function runAgenticAnswerPhase(
  provider: Provider,
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[]
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((q) => questionIds.includes(q.questionId))
    : questions

  const pendingQuestions = targetQuestions.filter((q) => {
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "answer")
    const indexingStatus = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "indexing")
    return status !== "completed" && indexingStatus === "completed"
  })

  if (pendingQuestions.length === 0) {
    logger.info("[agentic] No questions pending answering")
    return
  }

  const modelConfig = getModelConfig(checkpoint.answeringModel || DEFAULT_ANSWERING_MODEL)
  const maxIter = getMaxIter()
  const resultsDir = checkpointManager.getResultsDir(checkpoint.runId)
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true })

  logger.info(
    `[agentic] Answering ${pendingQuestions.length} questions with iterative search (max iter: ${maxIter}, model: ${modelConfig.displayName})`
  )

  for (let i = 0; i < pendingQuestions.length; i++) {
    const question = pendingQuestions[i]
    const containerTag = `${question.questionId}-${checkpoint.dataSourceRunId}`
    const questionDate = checkpoint.questions[question.questionId]?.questionDate

    const startTime = Date.now()
    checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
      status: "in_progress",
      startedAt: new Date().toISOString(),
    })

    try {
      // Iter 1: search with original question
      const allResults: unknown[][] = []
      const queriesUsed: string[] = [question.question]

      const results = await provider.search(question.question, {
        containerTag,
        limit: 10,
        questionDate,
      })
      allResults.push(results)

      // Iter 2..maxIter: query expansion
      for (let iter = 2; iter <= maxIter; iter++) {
        const merged = mergeResults(allResults)
        const expandedQuery = await expandQuery(question.question, merged, modelConfig)
        if (!expandedQuery || queriesUsed.includes(expandedQuery)) break
        queriesUsed.push(expandedQuery)

        const extraResults = await provider.search(expandedQuery, {
          containerTag,
          limit: 10,
          questionDate,
        })
        allResults.push(extraResults)
        logger.debug(
          `[agentic] ${question.questionId} iter ${iter}: query="${expandedQuery}", +${extraResults.length} results`
        )
      }

      const context = mergeResults(allResults).slice(0, 15)

      // Save search results file for compatibility
      const searchResultFile = join(resultsDir, `${question.questionId}-agentic-search.json`)
      writeFileSync(searchResultFile, JSON.stringify({ results: context, queriesUsed }, null, 2))
      checkpointManager.updatePhase(checkpoint, question.questionId, "search", {
        status: "completed",
        resultFile: searchResultFile,
        completedAt: new Date().toISOString(),
      })

      // Generate answer
      const prompt = buildDefaultAnswerPrompt(question.question, context, questionDate)
      const basePrompt = buildDefaultAnswerPrompt(question.question, [], questionDate)
      const promptTokens = countTokens(prompt, modelConfig)
      const basePromptTokens = countTokens(basePrompt, modelConfig)
      const contextTokens = Math.max(0, promptTokens - basePromptTokens)

      const answer = await generateTextForModel(modelConfig, prompt)
      const normalizedAnswer = answer.trim()
      if (!normalizedAnswer) throw new Error("Empty answer from model")

      const durationMs = Date.now() - startTime
      checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
        status: "completed",
        hypothesis: normalizedAnswer,
        promptTokens,
        basePromptTokens,
        contextTokens,
        completedAt: new Date().toISOString(),
        durationMs,
      })

      logger.progress(
        i + 1,
        pendingQuestions.length,
        `[agentic] Answered ${question.questionId} (${durationMs}ms, ${queriesUsed.length} queries, ${context.length} results)`
      )
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
        status: "failed",
        error,
      })
      logger.error(`[agentic] Failed to answer ${question.questionId}: ${error}`)
    }
  }
}
