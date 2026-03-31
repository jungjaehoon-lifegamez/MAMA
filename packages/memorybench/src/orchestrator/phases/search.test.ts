import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runSearchPhase } from "./search"
import { CheckpointManager } from "../checkpoint"
import type { Provider } from "../../types/provider"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"

test("runSearchPhase should pass questionDate to provider.search", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "memorybench-search-phase-"))
  const checkpointManager = new CheckpointManager(basePath)
  const checkpoint = checkpointManager.create(
    "search-phase-run",
    "mama",
    "longmemeval",
    "gpt-5.4-mini",
    "gpt-5.4-mini"
  )

  checkpointManager.initQuestion(checkpoint, "q1", "q1-run", {
    question: "What kitchen appliance did I buy 10 days ago?",
    groundTruth: "a smoker",
    questionType: "temporal-reasoning",
    questionDate: "2023/03/25 (Sat) 18:26",
  })
  checkpointManager.updatePhase(checkpoint, "q1", "indexing", {
    status: "completed",
  })

  let receivedQuestionDate: string | undefined
  const provider: Provider = {
    name: "mama",
    async initialize() {},
    async ingest() {
      return { documentIds: [] }
    },
    async awaitIndexing() {},
    async search(_query, options) {
      receivedQuestionDate = options.questionDate
      return []
    },
    async clear() {},
  }

  const benchmark: Benchmark = {
    name: "longmemeval",
    async load() {},
    getQuestions() {
      return [
        {
          questionId: "q1",
          question: "What kitchen appliance did I buy 10 days ago?",
          questionType: "temporal-reasoning",
          groundTruth: "a smoker",
          haystackSessionIds: [],
          metadata: { questionDate: "2023/03/25 (Sat) 18:26" },
        },
      ]
    },
    getHaystackSessions() {
      return []
    },
    getGroundTruth() {
      return "a smoker"
    },
    getQuestionTypes() {
      return {}
    },
  }

  try {
    await runSearchPhase(provider, benchmark, checkpoint as RunCheckpoint, checkpointManager)
    assert.equal(receivedQuestionDate, "2023/03/25 (Sat) 18:26")
  } finally {
    rmSync(basePath, { recursive: true, force: true })
  }
})
