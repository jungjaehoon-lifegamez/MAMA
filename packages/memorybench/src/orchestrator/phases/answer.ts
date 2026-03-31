import { readFileSync, existsSync } from "fs"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { getModelConfig, ModelConfig, DEFAULT_ANSWERING_MODEL } from "../../utils/models"
import { buildDefaultAnswerPrompt } from "../../prompts/defaults"
import { buildContextString } from "../../types/prompts"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import { countTokens } from "../../utils/tokens"
import { generateTextForModel } from "../../utils/text-generation"
import { ClaudeSession } from "../../utils/claude-session"
import { CodexSession } from "../../utils/codex-session"

const DEFAULT_ANSWER_MAX_ATTEMPTS = 3

function getAnsweringModel(modelAlias: string): { modelConfig: ModelConfig } {
  return {
    modelConfig: getModelConfig(modelAlias || DEFAULT_ANSWERING_MODEL),
  }
}

function getAnswerMaxAttempts(): number {
  const parsed = Number.parseInt(process.env.MEMORYBENCH_ANSWER_MAX_ATTEMPTS || "", 10)
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed
  }
  return DEFAULT_ANSWER_MAX_ATTEMPTS
}

export function isRetryableAnswerErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("empty answer from model") ||
    normalized.includes("returned an empty response") ||
    normalized.includes("request timeout")
  )
}

export async function generateAnswerWithRetry(options: {
  generate: () => Promise<string>
  resetSession?: () => Promise<void>
  maxAttempts?: number
  onRetry?: (attempt: number, errorMessage: string) => void
}): Promise<string> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_ANSWER_MAX_ATTEMPTS
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const text = await options.generate()
      const normalizedText = text.trim()
      if (!normalizedText) {
        throw new Error("Empty answer from model")
      }
      return normalizedText
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastError = error instanceof Error ? error : new Error(message)

      if (attempt >= maxAttempts || !isRetryableAnswerErrorMessage(message)) {
        throw lastError
      }

      options.onRetry?.(attempt, message)
      if (options.resetSession) {
        await options.resetSession()
      }
    }
  }

  throw lastError ?? new Error("Answer generation failed")
}

function buildAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string,
  provider?: Provider
): string {
  if (provider?.prompts?.answerPrompt) {
    const customPrompt = provider.prompts.answerPrompt
    if (typeof customPrompt === "function") {
      return customPrompt(question, context, questionDate)
    }
    const contextStr = buildContextString(context, question)
    return customPrompt
      .replace("{{question}}", question)
      .replace("{{questionDate}}", questionDate || "Not specified")
      .replace("{{context}}", contextStr)
  }

  return buildDefaultAnswerPrompt(question, context, questionDate)
}

export async function runAnswerPhase(
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[],
  provider?: Provider
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((q) => questionIds.includes(q.questionId))
    : questions

  const pendingQuestions = targetQuestions.filter((q) => {
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "answer")
    const searchStatus = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "search")
    const resultFile = checkpoint.questions[q.questionId]?.phases.search.resultFile
    return (
      status !== "completed" && searchStatus === "completed" && resultFile && existsSync(resultFile)
    )
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending answering")
    return
  }

  const { modelConfig } = getAnsweringModel(checkpoint.answeringModel)
  let concurrency = resolveConcurrency("answer", checkpoint.concurrency, provider?.concurrency)
  const maxAttempts = getAnswerMaxAttempts()

  // Set up persistent session for CLI-based models
  let claudeSession: ClaudeSession | null = null
  let codexSession: CodexSession | null = null

  const closeSessions = (): void => {
    if (claudeSession) {
      claudeSession.close()
      claudeSession = null
    }
    if (codexSession) {
      codexSession.close()
      codexSession = null
    }
  }

  const startSessions = async (): Promise<void> => {
    if (modelConfig.execution === "claude-cli") {
      claudeSession = new ClaudeSession({ model: modelConfig.id, timeoutMs: 120_000 })
      await claudeSession.start()
      concurrency = 1
      logger.info(`[answer] Using persistent Claude session (model: ${modelConfig.id}, concurrency forced to 1)`)
    } else if (modelConfig.execution === "codex-cli") {
      codexSession = new CodexSession({ model: modelConfig.id, timeoutMs: 180_000, sandbox: "read-only" })
      await codexSession.start()
      concurrency = 1
      logger.info(`[answer] Using persistent Codex session (model: ${modelConfig.id}, concurrency forced to 1)`)
    }
  }

  if (modelConfig.execution === "claude-cli" || modelConfig.execution === "codex-cli") {
    await startSessions()
  }

  logger.info(
    `Generating answers for ${pendingQuestions.length} questions using ${modelConfig.displayName} (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.execute(
    pendingQuestions,
    concurrency,
    checkpoint.runId,
    "answer",
    async ({ item: question, index, total }) => {
      const resultFile = checkpoint.questions[question.questionId].phases.search.resultFile!

      const startTime = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      })

      try {
        const searchData = JSON.parse(readFileSync(resultFile, "utf8"))
        const context: unknown[] = searchData.results || []
        const questionDate = checkpoint.questions[question.questionId]?.questionDate

        const basePrompt = buildAnswerPrompt(question.question, [], questionDate, provider)
        const prompt = buildAnswerPrompt(question.question, context, questionDate, provider)

        const basePromptTokens = countTokens(basePrompt, modelConfig)
        const promptTokens = countTokens(prompt, modelConfig)
        // Derive contextTokens from the difference so it reflects the actual formatted
        // context in the prompt (not the raw JSON), which matters for providers with
        // custom prompt functions that transform context (e.g. Zep's XML-like tags).
        const contextTokens = Math.max(0, promptTokens - basePromptTokens)

        const normalizedText = await generateAnswerWithRetry({
          maxAttempts,
          generate: () =>
            generateTextForModel(modelConfig, prompt, {
              claudeSession: claudeSession ?? undefined,
              codexSession: codexSession ?? undefined,
            }),
          resetSession:
            modelConfig.execution === "sdk"
              ? undefined
              : async () => {
                  closeSessions()
                  await startSessions()
                },
          onRetry: (attempt, errorMessage) => {
            logger.warn(
              `[answer] Retrying ${question.questionId} after attempt ${attempt}/${maxAttempts}: ${errorMessage}`
            )
          },
        })

        const durationMs = Date.now() - startTime
        checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
          status: "completed",
          hypothesis: normalizedText,
          promptTokens,
          basePromptTokens,
          contextTokens,
          completedAt: new Date().toISOString(),
          durationMs,
        })

        logger.progress(
          index + 1,
          total,
          `Answered ${question.questionId} (${durationMs}ms, ${promptTokens} tokens: ${basePromptTokens} base + ${contextTokens} context)`
        )
        return { questionId: question.questionId, durationMs }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
          status: "failed",
          error,
        })
        logger.error(`Failed to answer ${question.questionId}: ${error}`)
        throw new Error(
          `Answer failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  if (claudeSession) {
    logger.info(`[answer] Persistent session closed after ${claudeSession.messageCount} messages`)
  }
  if (codexSession) {
    const stats = codexSession.tokenStats
    logger.info(`[answer] Codex session closed after ${codexSession.messageCount} messages (${stats.input} in, ${stats.output} out, ${stats.cached} cached)`)
  }
  closeSessions()

  logger.success("Answer phase complete")
}
