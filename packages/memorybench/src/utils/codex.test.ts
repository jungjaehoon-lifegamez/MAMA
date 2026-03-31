import test from "node:test"
import assert from "node:assert/strict"

import { getModelConfig } from "./models"
import { buildCodexExecArgs } from "./codex"

test("gpt-5.4 should use codex-cli execution", () => {
  const model = getModelConfig("gpt-5.4")
  assert.equal(model.execution, "codex-cli")
})

test("gpt-5.3-codex should use codex-cli execution", () => {
  const model = getModelConfig("gpt-5.3-codex")
  assert.equal(model.execution, "codex-cli")
})

test("buildCodexExecArgs should configure isolated exec output", () => {
  const args = buildCodexExecArgs({
    model: "gpt-5.4",
    cwd: "/tmp/memorybench",
    outputFile: "/tmp/out.txt",
    prompt: "Reply exactly: OK",
  })

  assert.deepEqual(args, [
    "exec",
    "-m",
    "gpt-5.4",
    "-C",
    "/tmp/memorybench",
    "-s",
    "read-only",
    "--color",
    "never",
    "-o",
    "/tmp/out.txt",
    "Reply exactly: OK",
  ])
})
