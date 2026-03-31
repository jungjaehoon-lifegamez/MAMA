import test from "node:test"
import assert from "node:assert/strict"

import { generateAnswerWithRetry, isRetryableAnswerErrorMessage } from "./answer"

test("generateAnswerWithRetry should retry empty model responses and eventually succeed", async () => {
  let attempts = 0
  let resets = 0

  const result = await generateAnswerWithRetry({
    maxAttempts: 3,
    generate: async () => {
      attempts++
      if (attempts < 3) {
        return "   "
      }
      return "final answer"
    },
    resetSession: async () => {
      resets++
    },
  })

  assert.equal(result, "final answer")
  assert.equal(attempts, 3)
  assert.equal(resets, 2)
})

test("generateAnswerWithRetry should fail after max retries for empty responses", async () => {
  let attempts = 0

  await assert.rejects(
    () =>
      generateAnswerWithRetry({
        maxAttempts: 2,
        generate: async () => {
          attempts++
          return ""
        },
      }),
    /Empty answer from model/
  )

  assert.equal(attempts, 2)
})

test("isRetryableAnswerErrorMessage should only treat transient empty-response errors as retryable", () => {
  assert.equal(isRetryableAnswerErrorMessage("Empty answer from model"), true)
  assert.equal(isRetryableAnswerErrorMessage("Codex exec returned an empty response"), true)
  assert.equal(isRetryableAnswerErrorMessage("Request timeout: tools/call (180000ms)"), true)
  assert.equal(isRetryableAnswerErrorMessage("Selected model is at capacity. Please try a different model."), false)
})
