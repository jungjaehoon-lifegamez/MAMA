import test from "node:test"
import assert from "node:assert/strict"

import { buildDefaultAnswerPrompt } from "./defaults"

test("buildDefaultAnswerPrompt should require exact entity and title matching", () => {
  const prompt = buildDefaultAnswerPrompt(
    "How many engineers do I lead when I just started my new role as Software Engineer Manager?",
    [],
    "2023/05/30 (Tue) 10:18"
  )

  assert.match(prompt, /different role|title|entity/i)
  assert.match(prompt, /Senior Software Engineer/i)
  assert.match(prompt, /Software Engineer Manager/i)
  assert.match(prompt, /explicitly state the mismatch|name the mismatch/i)
  assert.match(prompt, /I don't know/i)
})
