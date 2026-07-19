import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildChains,
  buildLineageItem,
  buildQaItem,
  chainRevisionReasoning,
  isExcludedTopic,
  mulberry32,
  normalizeCreatedAt,
  parseChoice,
  reasoningHead,
  renderLineageBlock,
  renderOptions,
  scoreResults,
  seededShuffle,
} from "./lib.mjs"

const LONG = "a decision text that is comfortably longer than the forty character minimum"
const LONG_REASON = "we switched because the earlier rationale no longer held under new load"

function row(id, topic, decision, created_at, reasoning = null) {
  return { id, topic, decision, created_at, reasoning, status: "active", kind: "decision" }
}

test("isExcludedTopic drops known fixture-pollution topics", () => {
  assert.equal(isExcludedTopic("auth_strategy"), true)
  assert.equal(isExcludedTopic("alpha"), true)
  assert.equal(isExcludedTopic("memory_scopes_project_x"), true)
  assert.equal(isExcludedTopic("my_integration_test_flow"), true)
  assert.equal(isExcludedTopic("operator_report_cadence"), false)
})

test("normalizeCreatedAt handles epoch seconds, epoch ms, TEXT datetimes, and garbage", () => {
  assert.equal(normalizeCreatedAt(1770961389), 1770961389000) // seconds
  assert.equal(normalizeCreatedAt(1777041049115), 1777041049115) // already ms
  assert.equal(normalizeCreatedAt("1770961389"), 1770961389000) // numeric string
  assert.equal(normalizeCreatedAt("2026-02-15 04:29:33"), Date.parse("2026-02-15T04:29:33Z"))
  assert.equal(normalizeCreatedAt("not a date"), null)
  assert.equal(normalizeCreatedAt(null), null)
  assert.equal(normalizeCreatedAt(undefined), null)
})

test("buildChains groups by topic oldest->newest and requires a real delta", () => {
  const rows = [
    row("d2", "cadence", `${LONG} v2`, 200),
    row("d1", "cadence", `${LONG} v1`, 100),
    row("d3", "cadence", `${LONG} v3`, 300),
    row("x1", "solo_topic", `${LONG} only one`, 100),
    row("t1", "auth_strategy", `${LONG} fixture`, 100),
    row("t2", "auth_strategy", `${LONG} fixture2`, 200),
    row("s1", "short", "too short", 100),
    row("s2", "short", "too short2", 200),
    row("n1", "no_delta", `${LONG} same`, 100),
    row("n2", "no_delta", `${LONG}   SAME`, 200),
  ]
  const chains = buildChains(rows)
  assert.equal(chains.length, 1)
  assert.equal(chains[0].topic, "cadence")
  assert.deepEqual(
    chains[0].rows.map((r) => r.id),
    ["d1", "d2", "d3"]
  )
})

test("buildQaItem marks the newest row as the answer and priors as distractors", () => {
  const chain = {
    topic: "cadence",
    rows: [
      row("d1", "cadence", `${LONG} v1`, 100),
      row("d2", "cadence", `${LONG} v2`, 200),
      row("d3", "cadence", `${LONG} v3`, 300),
    ],
  }
  const item = buildQaItem(chain, 42)
  assert.equal(item.qaType, "truth")
  assert.equal(item.options.length, 3)
  const answer = item.options.find((o) => o.label === item.answerLabel)
  assert.equal(answer.decisionId, "d3")
  assert.equal(answer.isCurrent, true)
  assert.equal(item.options.filter((o) => o.isCurrent).length, 1)
  // Deterministic for a fixed seed.
  const again = buildQaItem(chain, 42)
  assert.deepEqual(
    again.options.map((o) => o.decisionId),
    item.options.map((o) => o.decisionId)
  )
})

test("buildQaItem caps distractors at 3 and dedups identical prior texts", () => {
  const rows = []
  for (let i = 1; i <= 6; i++) {
    rows.push(row(`d${i}`, "t", `${LONG} v${i}`, i * 100))
  }
  rows.push(row("dup", "t", `${LONG} v5`, 650)) // duplicate of v5 text
  rows.sort((a, b) => a.created_at - b.created_at)
  const item = buildQaItem({ topic: "t", rows }, 7)
  assert.equal(item.options.length, 4) // 1 answer + 3 distractors
  const texts = item.options.map((o) => o.text)
  assert.equal(new Set(texts).size, texts.length)
})

test("seededShuffle is deterministic per seed", () => {
  const arr = [1, 2, 3, 4, 5]
  const a = seededShuffle(arr, mulberry32(1))
  const b = seededShuffle(arr, mulberry32(1))
  const c = seededShuffle(arr, mulberry32(2))
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
})

test("parseChoice handles bare letters, prefixed answers, and rejects garbage", () => {
  const labels = ["A", "B", "C"]
  assert.equal(parseChoice("B", labels), "B")
  assert.equal(parseChoice("  **C**  ", labels), "C")
  assert.equal(parseChoice("Answer: A", labels), "A")
  assert.equal(parseChoice("The answer is B) because...", labels), "B")
  assert.equal(parseChoice("none of these", labels), null)
  assert.equal(parseChoice("", labels), null)
  // D is not a valid label when only 3 options exist.
  assert.equal(parseChoice("D", labels), null)
})

test("renderOptions prints label) text blocks", () => {
  const item = buildQaItem(
    {
      topic: "t",
      rows: [row("d1", "t", `${LONG} v1`, 100), row("d2", "t", `${LONG} v2`, 200)],
    },
    3
  )
  const rendered = renderOptions(item)
  for (const o of item.options) {
    assert.ok(rendered.includes(`${o.label}) ${o.text}`))
  }
})

test("scoreResults computes accuracy, stale and invalid rates per condition", () => {
  const results = [
    { itemId: "1", condition: "mama", choice: "A", answerLabel: "A", promptChars: 400 },
    { itemId: "2", condition: "mama", choice: "B", answerLabel: "A", promptChars: 400 },
    { itemId: "1", condition: "raw", choice: null, answerLabel: "A", promptChars: 40000 },
    { itemId: "2", condition: "raw", choice: "A", answerLabel: "A", promptChars: 40000 },
  ]
  const scores = scoreResults(results)
  const mama = scores.find((s) => s.condition === "mama")
  const raw = scores.find((s) => s.condition === "raw")
  assert.equal(mama.accuracy, 0.5)
  assert.equal(mama.staleRate, 0.5)
  assert.equal(mama.invalidRate, 0)
  assert.equal(raw.accuracy, 0.5)
  assert.equal(raw.invalidRate, 0.5)
  assert.equal(raw.approxTokensPerItem, 10000)
})

test("chainRevisionReasoning returns the newest version's reasoning when it qualifies", () => {
  const chain = {
    topic: "cadence",
    rows: [
      row(
        "d1",
        "cadence",
        `${LONG} v1`,
        100,
        "original rationale for the first cadence choice here"
      ),
      row("d2", "cadence", `${LONG} v2`, 200, LONG_REASON),
    ],
  }
  assert.equal(chainRevisionReasoning(chain), LONG_REASON)
})

test("chainRevisionReasoning rejects short, missing, single-version, and duplicate reasonings", () => {
  // too short
  assert.equal(
    chainRevisionReasoning({
      topic: "t",
      rows: [
        row("a", "t", `${LONG} v1`, 100, "long enough prior reasoning here to pass"),
        row("b", "t", `${LONG} v2`, 200, "too short"),
      ],
    }),
    null
  )
  // missing on current
  assert.equal(
    chainRevisionReasoning({
      topic: "t",
      rows: [row("a", "t", `${LONG} v1`, 100, LONG_REASON), row("b", "t", `${LONG} v2`, 200, null)],
    }),
    null
  )
  // single version
  assert.equal(
    chainRevisionReasoning({ topic: "t", rows: [row("a", "t", `${LONG} v1`, 100, LONG_REASON)] }),
    null
  )
  // current reasoning duplicates a prior version's reasoning (no delta)
  assert.equal(
    chainRevisionReasoning({
      topic: "t",
      rows: [
        row("a", "t", `${LONG} v1`, 100, LONG_REASON),
        row("b", "t", `${LONG} v2`, 200, `  ${LONG_REASON.toUpperCase()}  `),
      ],
    }),
    null
  )
})

test("buildLineageItem: answer is the chain reasoning, distractors are other topics, deterministic", () => {
  const chain = {
    topic: "cadence",
    rows: [
      row("d1", "cadence", `${LONG} v1`, 100, "first cadence rationale that is plenty long here"),
      row("d2", "cadence", `${LONG} v2`, 200, LONG_REASON),
    ],
  }
  const pool = [
    { topic: "cadence", reasoning: LONG_REASON }, // own topic - must be excluded
    {
      topic: "budget",
      reasoning: "budget was reallocated to the new priority workstream this quarter",
    },
    {
      topic: "vendor",
      reasoning: "the incumbent vendor missed the reliability targets three months running",
    },
    {
      topic: "schema",
      reasoning: "the denormalized shape made the hot query path far too slow to ship",
    },
  ]
  const item = buildLineageItem(chain, pool, 42)
  assert.equal(item.qaType, "lineage")
  assert.equal(item.id, "lineage_cadence")
  assert.equal(item.options.length, 4) // 1 answer + 3 distractors
  const answer = item.options.find((o) => o.label === item.answerLabel)
  assert.equal(answer.text, LONG_REASON)
  // No distractor is drawn from the chain's own topic.
  assert.ok(
    item.options.every(
      (o) =>
        o.text === LONG_REASON || pool.some((p) => p.topic !== "cadence" && p.reasoning === o.text)
    )
  )
  // Deterministic for a fixed seed.
  const again = buildLineageItem(chain, pool, 42)
  assert.deepEqual(
    again.options.map((o) => o.text),
    item.options.map((o) => o.text)
  )
  assert.equal(again.answerLabel, item.answerLabel)
})

test("buildLineageItem dedups identical distractor reasonings and returns null with no pool", () => {
  const chain = {
    topic: "cadence",
    rows: [
      row("d1", "cadence", `${LONG} v1`, 100, "prior cadence reasoning long enough to count"),
      row("d2", "cadence", `${LONG} v2`, 200, LONG_REASON),
    ],
  }
  const dupPool = [
    { topic: "a", reasoning: "the same shared rationale text repeated across two topics here" },
    { topic: "b", reasoning: "the same shared rationale text repeated across two topics here" },
  ]
  const item = buildLineageItem(chain, dupPool, 5)
  const texts = item.options.map((o) => o.text)
  assert.equal(new Set(texts).size, texts.length) // deduped
  assert.equal(item.options.length, 2) // answer + one unique distractor
  // Empty pool (only own topic available) -> no item.
  assert.equal(buildLineageItem(chain, [{ topic: "cadence", reasoning: LONG_REASON }], 5), null)
})

test("reasoningHead collapses whitespace, truncates, and handles empties", () => {
  assert.equal(reasoningHead("  a   b\n c  "), "a b c")
  assert.equal(reasoningHead(""), "no reasoning recorded")
  assert.equal(reasoningHead(null), "no reasoning recorded")
  const long = "x".repeat(200)
  const head = reasoningHead(long, 50)
  assert.ok(head.length <= 53) // 50 chars + ellipsis
  assert.ok(head.endsWith("..."))
})

test("renderLineageBlock shows prior reasoning heads and CURRENT decision", () => {
  const rows = [
    row(
      "d1",
      "cadence",
      "the very first cadence decision was daily",
      100,
      "chose daily to stay tightly in sync early on"
    ),
    row(
      "d2",
      "cadence",
      "cadence moved to twice a week to cut noise",
      200,
      "daily was too noisy so we spaced it out here"
    ),
    row("d3", "cadence", "the current cadence is a weekly digest only", 300, LONG_REASON),
  ]
  const block = renderLineageBlock("cadence", rows)
  assert.ok(block.startsWith("cadence: v1 ("))
  assert.ok(block.includes("v2 ("))
  assert.ok(block.includes("CURRENT: the current cadence is a weekly digest only"))
  // The current version surfaces its decision, not its reasoning.
  assert.ok(!block.includes(LONG_REASON))
  // Empty chain is handled.
  assert.equal(renderLineageBlock("t", []), "t: (no history)")
})
