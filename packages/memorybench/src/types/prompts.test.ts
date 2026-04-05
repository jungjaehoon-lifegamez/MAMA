import test from "node:test"
import assert from "node:assert/strict"

import { buildContextString } from "./prompts"

test("buildContextString should compact large provider results", () => {
  const hugeTail = "x".repeat(4000)
  const context = [
    {
      id: "1",
      topic: "bench_target_session_1",
      score: 0.99,
      content: `user: I waited over a year for the decision.${hugeTail}`,
      created_at: 10,
    },
    {
      id: "2",
      topic: "bench_target_session_2",
      score: 0.88,
      content: "user: Distractor session.",
      created_at: 9,
    },
    {
      id: "3",
      topic: "bench_target_session_3",
      score: 0.77,
      content: "user: Another distractor session.",
      created_at: 8,
    },
    {
      id: "4",
      topic: "bench_target_session_4",
      score: 0.66,
      content: "user: Extra distractor session.",
      created_at: 7,
    },
    {
      id: "5",
      topic: "bench_target_session_5",
      score: 0.55,
      content: "user: This fifth result should now be included.",
      created_at: 6,
    },
    {
      id: "6",
      topic: "bench_target_session_6",
      score: 0.44,
      content: "user: This sixth result should also be included.",
      created_at: 5,
    },
    {
      id: "7",
      topic: "bench_target_session_7",
      score: 0.33,
      content: "user: This seventh result is now included (MAX_CONTEXT_RESULTS=10).",
      created_at: 4,
    },
    {
      id: "8",
      topic: "bench_target_session_8",
      score: 0.29,
      content: "user: Eighth result.",
      created_at: 3,
    },
    {
      id: "9",
      topic: "bench_target_session_9",
      score: 0.26,
      content: "user: Ninth result.",
      created_at: 2,
    },
    {
      id: "10",
      topic: "bench_target_session_10",
      score: 0.24,
      content: "user: Tenth result.",
      created_at: 1,
    },
    {
      id: "11",
      topic: "bench_target_session_11",
      score: 0.22,
      content: "user: This eleventh result should be omitted.",
      created_at: 0,
    },
  ]

  const promptContext = buildContextString(context)

  assert.match(promptContext, /bench_target_session_1/)
  assert.match(promptContext, /relevance_snippet/)
  assert.match(promptContext, /numeric_clues/)
  assert.match(promptContext, /bench_target_session_5/)
  assert.match(promptContext, /bench_target_session_6/)
  assert.match(promptContext, /bench_target_session_7/)
  assert.doesNotMatch(promptContext, /bench_target_session_11/)
  assert.ok(promptContext.length < 9000)
})

test("buildContextString should surface the most relevant snippet instead of the content prefix", () => {
  const noisyPrefix = "noise ".repeat(500)
  const context = [
    {
      id: "1",
      topic: "bench_target_session_1",
      score: 0.99,
      content: `${noisyPrefix} user: I waited over a year for the decision on my asylum application.`,
      created_at: 10,
    },
  ]

  const promptContext = buildContextString(
    context,
    "How long did I wait for the decision on my asylum application?"
  )
  const parsed = JSON.parse(promptContext)
  const excerpt = parsed[0].relevance_snippet as string

  assert.match(excerpt, /over a year/)
  assert.ok(excerpt.length < context[0].content.length / 4)
})

test("buildContextString should surface acquisition clues for purchase questions", () => {
  const context = [
    {
      id: "1",
      topic: "bench_target_session_1",
      score: 0.99,
      content:
        "user: I just got a smoker today and I'm excited to experiment with different types of wood and meats today.",
      created_at: 10,
    },
  ]

  const promptContext = buildContextString(context, "What kitchen appliance did I buy 10 days ago?")
  const parsed = JSON.parse(promptContext)
  const acquisitionClues = parsed[0].acquisition_clues as string[]

  assert.ok(acquisitionClues.some((clue) => /smoker/i.test(clue)))
})
