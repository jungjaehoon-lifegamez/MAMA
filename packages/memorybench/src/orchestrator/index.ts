import type { ProviderName } from "../types/provider"
import type { BenchmarkName } from "../types/benchmark"
import type { JudgeName } from "../types/judge"
import type { RunCheckpoint, SamplingConfig } from "../types/checkpoint"
import type { ConcurrencyConfig } from "../types/concurrency"
import { createProvider } from "../providers"
import { createBenchmark } from "../benchmarks"
import { createJudge } from "../judges"
import { CheckpointManager } from "./checkpoint"
import { getProviderConfig, getJudgeConfig } from "../utils/config"
import { resolveModel } from "../utils/models"
import { logger } from "../utils/logger"
import { runIngestPhase } from "./phases/ingest"
import { runIndexingPhase } from "./phases/indexing"
import { runSearchPhase } from "./phases/search"
import { runAnswerPhase } from "./phases/answer"
import { runToolUseAnswerPhase } from "./phases/answer-tool-use"
import { runEvaluatePhase } from "./phases/evaluate"
import { generateReport, saveReport, printReport } from "./phases/report"

export interface OrchestratorOptions {
  provider: ProviderName
  benchmark: BenchmarkName
  judgeModel: string
  runId: string
  answeringModel?: string
  limit?: number
  sampling?: SamplingConfig
  concurrency?: ConcurrencyConfig
  force?: boolean
  questionIds?: string[]
  phases?: ("ingest" | "indexing" | "search" | "answer" | "evaluate" | "report")[]
}

function selectQuestionsBySampling(
  allQuestions: { questionId: string; questionType: string }[],
  sampling: SamplingConfig
): string[] {
  if (sampling.mode === "full") {
    return allQuestions.map((q) => q.questionId)
  }

  if (sampling.mode === "limit" && sampling.limit) {
    if (!Number.isInteger(sampling.limit) || sampling.limit <= 0) {
      throw new Error(`sampling.limit must be a positive integer, got ${sampling.limit}`)
    }
    return allQuestions.slice(0, sampling.limit).map((q) => q.questionId)
  }

  if (sampling.mode === "sample" && sampling.perCategory) {
    if (!Number.isInteger(sampling.perCategory) || sampling.perCategory <= 0) {
      throw new Error(
        `sampling.perCategory must be a positive integer, got ${sampling.perCategory}`
      )
    }
    const byType: Record<string, { questionId: string; questionType: string }[]> = {}
    for (const q of allQuestions) {
      if (!byType[q.questionType]) byType[q.questionType] = []
      byType[q.questionType].push(q)
    }

    const selected: string[] = []
    for (const questions of Object.values(byType)) {
      if (sampling.sampleType === "random") {
        const shuffled = [...questions].sort(() => Math.random() - 0.5)
        selected.push(...shuffled.slice(0, sampling.perCategory).map((q) => q.questionId))
      } else {
        selected.push(...questions.slice(0, sampling.perCategory).map((q) => q.questionId))
      }
    }
    return selected
  }

  return allQuestions.map((q) => q.questionId)
}

export class Orchestrator {
  private checkpointManager: CheckpointManager

  constructor() {
    this.checkpointManager = new CheckpointManager()
  }

  async run(options: OrchestratorOptions): Promise<void> {
    const {
      provider: providerName,
      benchmark: benchmarkName,
      judgeModel,
      runId,
      answeringModel = "gpt-4o",
      limit,
      sampling,
      concurrency,
      force = false,
      questionIds,
      phases = ["ingest", "indexing", "search", "answer", "evaluate", "report"],
    } = options

    const judgeModelInfo = resolveModel(judgeModel)
    const judgeName = judgeModelInfo.provider as JudgeName

    logger.info(`Starting MemoryBench run: ${providerName} + ${benchmarkName}`)
    logger.info(`Run ID: ${runId}`)
    logger.info(
      `Judge: ${judgeModelInfo.displayName} (${judgeModelInfo.id}), Answering Model: ${answeringModel}`
    )
    logger.info(`Force: ${force}, Phases: ${phases?.join(", ") || "all"}`)
    if (sampling) {
      logger.info(`Sampling config received: ${JSON.stringify(sampling)}`)
      if (sampling.mode === "sample") {
        logger.info(
          `Sampling: ${sampling.perCategory} per category (${sampling.sampleType || "consecutive"})`
        )
      } else if (sampling.mode === "limit") {
        logger.info(`Limit: ${sampling.limit} questions`)
      } else {
        logger.info(`Selection: full (all questions)`)
      }
    } else if (limit) {
      logger.info(`Limit: ${limit} questions`)
    } else {
      logger.info(`No sampling or limit provided`)
    }

    if (force && this.checkpointManager.exists(runId)) {
      this.checkpointManager.delete(runId)
      logger.info("Cleared existing checkpoint (--force)")
    }

    let checkpoint!: RunCheckpoint
    let effectiveLimit: number | undefined
    let targetQuestionIds: string[] | undefined
    let isNewRun = false

    if (!this.checkpointManager.exists(runId)) {
      isNewRun = true
      checkpoint = this.checkpointManager.create(
        runId,
        providerName,
        benchmarkName,
        judgeModel,
        answeringModel,
        { limit, sampling, concurrency, status: "initializing" }
      )
      logger.info("Created checkpoint (initializing)")
    }

    const benchmark = createBenchmark(benchmarkName)
    await benchmark.load()
    const allQuestions = benchmark.getQuestions()

    if (this.checkpointManager.exists(runId) && !isNewRun) {
      checkpoint = this.checkpointManager.load(runId)!

      // Only override models when the caller explicitly provided overrides;
      // otherwise preserve the checkpoint's stored models for resume
      if (judgeModel !== checkpoint.judge) {
        checkpoint.judge = judgeModel
      }
      if (options.answeringModel !== undefined) {
        checkpoint.answeringModel = answeringModel
      }

      effectiveLimit = checkpoint.limit
      targetQuestionIds = checkpoint.targetQuestionIds

      if (!targetQuestionIds) {
        const startedQuestions = Object.values(checkpoint.questions)
          .filter((q) => Object.values(q.phases).some((p) => p.status !== "pending"))
          .map((q) => q.questionId)

        if (startedQuestions.length > 0) {
          const pendingQuestions = Object.values(checkpoint.questions)
            .filter((q) => Object.values(q.phases).every((p) => p.status === "pending"))
            .map((q) => q.questionId)

          if (limit) {
            const remainingSlots = limit - startedQuestions.length
            targetQuestionIds = [
              ...startedQuestions,
              ...pendingQuestions.slice(0, Math.max(0, remainingSlots)),
            ]
            effectiveLimit = limit
            logger.warn(
              `Old checkpoint detected. Using CLI limit (${limit}) to determine target questions.`
            )
          } else {
            targetQuestionIds = [...startedQuestions, ...pendingQuestions]
            logger.warn(
              `Old checkpoint without stored limit. Processing all ${targetQuestionIds.length} questions (${startedQuestions.length} started + ${pendingQuestions.length} pending).`
            )
          }

          checkpoint.limit = effectiveLimit
          checkpoint.targetQuestionIds = targetQuestionIds
          this.checkpointManager.save(checkpoint)
        } else {
          if (limit) {
            const limitedQuestions = allQuestions.slice(0, limit).map((q) => q.questionId)
            targetQuestionIds = limitedQuestions
            effectiveLimit = limit
            checkpoint.limit = limit
            checkpoint.targetQuestionIds = targetQuestionIds
            this.checkpointManager.save(checkpoint)
            logger.warn(
              `Old checkpoint with no progress. Applying limit (${limit}) to first ${limit} questions.`
            )
          } else {
            // Legacy checkpoint without targetQuestionIds and no progress:
            // populate with all known question IDs from the checkpoint
            targetQuestionIds = Object.values(checkpoint.questions).map((q) => q.questionId)
            checkpoint.targetQuestionIds = targetQuestionIds
            this.checkpointManager.save(checkpoint)
            logger.warn(
              `Legacy checkpoint without targetQuestionIds. Populated with all ${targetQuestionIds.length} checkpoint questions.`
            )
          }
        }
      }

      const summary = this.checkpointManager.getSummary(checkpoint)
      const targetCount = targetQuestionIds?.length || summary.total

      const inProgressQuestions = Object.values(checkpoint.questions)
        .filter((q) => Object.values(q.phases).some((p) => p.status === "in_progress"))
        .map((q) => q.questionId)

      logger.info(
        `Resuming from checkpoint: ${summary.ingested}/${targetCount} ingested, ${summary.evaluated}/${targetCount} evaluated`
      )
      if (inProgressQuestions.length > 0) {
        logger.info(`In-progress questions: ${inProgressQuestions.join(", ")}`)
      }

      this.checkpointManager.updateStatus(checkpoint, "running")
    } else {
      logger.info(
        `New run path: isNewRun=${isNewRun}, sampling=${JSON.stringify(sampling)}, limit=${limit}`
      )
      effectiveLimit = limit

      if (questionIds && questionIds.length > 0) {
        const allQuestionIdSet = new Set(allQuestions.map((q) => q.questionId))
        const unknownIds = questionIds.filter((id) => !allQuestionIdSet.has(id))
        if (unknownIds.length > 0) {
          throw new Error(`Unknown questionIds not found in benchmark: ${unknownIds.join(", ")}`)
        }
        logger.info(`Using explicit questionIds: ${questionIds.length} questions`)
        targetQuestionIds = questionIds
      } else if (sampling) {
        logger.info(`Using sampling mode: ${sampling.mode}`)
        targetQuestionIds = selectQuestionsBySampling(allQuestions, sampling)
        checkpoint.sampling = sampling
        logger.info(
          `Sampling selected ${targetQuestionIds.length} questions from ${allQuestions.length} total`
        )
      } else if (effectiveLimit) {
        logger.info(`Using limit: ${effectiveLimit}`)
        targetQuestionIds = allQuestions.slice(0, effectiveLimit).map((q) => q.questionId)
      } else {
        logger.info(`No sampling/limit specified, using all ${allQuestions.length} questions`)
      }

      checkpoint.targetQuestionIds = targetQuestionIds
      checkpoint.limit = effectiveLimit

      const questionsToInit = targetQuestionIds
        ? allQuestions.filter((q) => targetQuestionIds!.includes(q.questionId))
        : allQuestions

      for (const q of questionsToInit) {
        const containerTag = `${q.questionId}-${checkpoint.dataSourceRunId}`
        this.checkpointManager.initQuestion(checkpoint, q.questionId, containerTag, {
          question: q.question,
          groundTruth: q.groundTruth,
          questionType: q.questionType,
          questionDate: q.metadata?.questionDate as string | undefined,
        })
      }

      this.checkpointManager.updateStatus(checkpoint, "running")
    }

    const provider = createProvider(providerName)
    await provider.initialize({
      ...getProviderConfig(providerName),
      runPath: this.checkpointManager.getRunPath(checkpoint.runId),
      dataSourceRunPath: this.checkpointManager.getRunPath(
        checkpoint.dataSourceRunId || checkpoint.runId
      ),
    })

    try {
      if (phases.includes("ingest")) {
        await runIngestPhase(
          provider,
          benchmark,
          checkpoint,
          this.checkpointManager,
          targetQuestionIds
        )
      }

      if (phases.includes("indexing")) {
        await runIndexingPhase(provider, checkpoint, this.checkpointManager, targetQuestionIds)
      }

      if (phases.includes("search")) {
        await runSearchPhase(
          provider,
          benchmark,
          checkpoint,
          this.checkpointManager,
          targetQuestionIds
        )
      }

      if (phases.includes("answer")) {
        if (process.env.MEMORYBENCH_TOOL_USE_ANSWER === "true") {
          await runToolUseAnswerPhase(
            provider,
            benchmark,
            checkpoint,
            this.checkpointManager,
            targetQuestionIds
          )
        } else {
          await runAnswerPhase(
            benchmark,
            checkpoint,
            this.checkpointManager,
            targetQuestionIds,
            provider
          )
        }
      }

      if (phases.includes("evaluate")) {
        const judge = createJudge(judgeName)
        const judgeConfig = getJudgeConfig(judgeName)
        judgeConfig.model = judgeModel
        await judge.initialize(judgeConfig)
        await runEvaluatePhase(
          judge,
          benchmark,
          checkpoint,
          this.checkpointManager,
          targetQuestionIds,
          provider
        )
      }

      if (phases.includes("report")) {
        const report = generateReport(benchmark, checkpoint)
        saveReport(report)
        printReport(report)
      }

      // Flush all pending checkpoint saves before marking as complete
      await this.checkpointManager.flush(checkpoint.runId)
      this.checkpointManager.updateStatus(checkpoint, "completed")
      logger.success("Run complete!")
    } catch (error) {
      // Always flush checkpoint state before propagating the error
      await this.checkpointManager.flush(checkpoint.runId)
      this.checkpointManager.updateStatus(checkpoint, "failed")
      throw error
    }
  }

  async ingest(
    options: Omit<OrchestratorOptions, "judgeModel" | "phases"> & { judgeModel?: string }
  ): Promise<void> {
    await this.run({
      ...options,
      judgeModel: options.judgeModel || "gpt-4o",
      phases: ["ingest", "indexing"],
    })
  }

  async search(
    options: Omit<OrchestratorOptions, "judgeModel" | "phases"> & { judgeModel?: string }
  ): Promise<void> {
    await this.run({ ...options, judgeModel: options.judgeModel || "gpt-4o", phases: ["search"] })
  }

  async evaluate(options: OrchestratorOptions): Promise<void> {
    await this.run({ ...options, phases: ["answer", "evaluate", "report"] })
  }

  async testQuestion(options: OrchestratorOptions & { questionId: string }): Promise<void> {
    await this.run({
      ...options,
      questionIds: [options.questionId],
      phases: ["search", "answer", "evaluate", "report"],
    })
  }

  getStatus(runId: string): void {
    const checkpoint = this.checkpointManager.load(runId)
    if (!checkpoint) {
      throw new Error(`No run found: ${runId}`)
    }

    const summary = this.checkpointManager.getSummary(checkpoint)
    logger.info("\n" + "=".repeat(50))
    logger.info(`Run: ${runId}`)
    logger.info(`Provider: ${checkpoint.provider}`)
    logger.info(`Benchmark: ${checkpoint.benchmark}`)
    logger.info("=".repeat(50))
    logger.info(`Total Questions: ${summary.total}`)
    logger.info(`Ingested: ${summary.ingested}`)
    logger.info(`Indexed: ${summary.indexed}`)
    logger.info(`Searched: ${summary.searched}`)
    logger.info(`Answered: ${summary.answered}`)
    logger.info(`Evaluated: ${summary.evaluated}`)
    logger.info("=".repeat(50) + "\n")
  }
}

export const orchestrator = new Orchestrator()
export { CheckpointManager } from "./checkpoint"
