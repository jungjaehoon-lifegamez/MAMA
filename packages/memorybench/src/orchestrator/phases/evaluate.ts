import type { Judge } from "../../types/judge"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import { calculateRetrievalMetrics } from "./retrieval-eval"
import { getModelConfig } from "../../utils/models"
import { ClaudeSession } from "../../utils/claude-session"
import { CodexSession } from "../../utils/codex-session"
import type { AnthropicJudge } from "../../judges/anthropic"
import type { OpenAIJudge } from "../../judges/openai"

export async function runEvaluatePhase(
  judge: Judge,
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
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "evaluate")
    const answerStatus = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "answer")
    const hypothesis = checkpoint.questions[q.questionId]?.phases.answer.hypothesis
    return status !== "completed" && answerStatus === "completed" && hypothesis
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending evaluation")
    return
  }

  let concurrency = resolveConcurrency("evaluate", checkpoint.concurrency, provider?.concurrency)

  // Set up persistent session for CLI-based judges
  let claudeSession: ClaudeSession | null = null
  let codexSession: CodexSession | null = null
  const judgeModelConfig = judge.getModelConfig()
  if (judgeModelConfig.execution === "claude-cli" && "setClaudeSession" in judge) {
    claudeSession = new ClaudeSession({ model: judgeModelConfig.id, timeoutMs: 60_000 })
    await claudeSession.start()
    ;(judge as AnthropicJudge).setClaudeSession(claudeSession)
    concurrency = 1
    logger.info(`[evaluate] Using persistent Claude session (model: ${judgeModelConfig.id}, concurrency forced to 1)`)
  } else if (judgeModelConfig.execution === "codex-cli" && "setCodexSession" in judge) {
    codexSession = new CodexSession({ model: judgeModelConfig.id, timeoutMs: 120_000, sandbox: "read-only" })
    await codexSession.start()
    ;(judge as OpenAIJudge).setCodexSession(codexSession)
    concurrency = 1
    logger.info(`[evaluate] Using persistent Codex session (model: ${judgeModelConfig.id}, concurrency forced to 1)`)
  }

  logger.info(
    `Evaluating ${pendingQuestions.length} questions with ${judge.name} (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.execute(
    pendingQuestions,
    concurrency,
    checkpoint.runId,
    "evaluate",
    async ({ item: question, index, total }) => {
      const hypothesis = checkpoint.questions[question.questionId].phases.answer.hypothesis!

      const startTime = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      })

      try {
        const searchResults = checkpoint.questions[question.questionId].phases.search.results || []

        const [result, retrievalMetrics] = await Promise.all([
          judge.evaluate({
            question: question.question,
            questionType: question.questionType,
            groundTruth: question.groundTruth,
            hypothesis,
            providerPrompts: provider?.prompts,
          }),
          calculateRetrievalMetrics(
            judge.getModelConfig(),
            question.question,
            question.groundTruth,
            searchResults
          ),
        ])

        const durationMs = Date.now() - startTime
        checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
          status: "completed",
          score: result.score,
          label: result.label,
          explanation: result.explanation,
          retrievalMetrics,
          completedAt: new Date().toISOString(),
          durationMs,
        })

        const retrievalInfo = retrievalMetrics
          ? ` | Hit@${retrievalMetrics.k}=${retrievalMetrics.hitAtK}, MRR=${retrievalMetrics.mrr.toFixed(2)}`
          : ""
        logger.progress(
          index + 1,
          total,
          `Evaluated ${question.questionId}: ${result.label}${retrievalInfo} (${durationMs}ms)`
        )

        return { questionId: question.questionId, durationMs, label: result.label }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        checkpointManager.updatePhase(checkpoint, question.questionId, "evaluate", {
          status: "failed",
          error,
        })
        logger.error(`Failed to evaluate ${question.questionId}: ${error}`)
        throw new Error(
          `Evaluate failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`
        )
      }
    }
  )

  // Close persistent sessions
  if (claudeSession) {
    claudeSession.close()
    logger.info(`[evaluate] Claude session closed after ${claudeSession.messageCount} messages`)
  }
  if (codexSession) {
    const stats = codexSession.tokenStats
    logger.info(`[evaluate] Codex session closed after ${codexSession.messageCount} messages (${stats.input} in, ${stats.output} out, ${stats.cached} cached)`)
    codexSession.close()
  }

  logger.success("Evaluate phase complete")
}
