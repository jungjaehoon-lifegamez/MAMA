/**
 * Tool-use Answer Phase
 *
 * ClaudeSession(CLI) + gateway-tools 패턴으로 LLM이 mama_search를 직접 호출.
 * Static search 결과를 초기 컨텍스트로 주고, Claude가 부족하면 스스로 재검색.
 *
 * Format: ```tool_call\n{"name":"mama_search","input":{"query":"..."}}\n```
 */

import { readFileSync, existsSync } from "fs"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ClaudeSession } from "../../utils/claude-session"

const TOOL_USE_MODEL = process.env.MEMORYBENCH_TOOL_USE_MODEL || "sonnet"
const MAX_TOOL_CALLS = 3
const MAMA_BASE_URL = "http://localhost:3847"

const GATEWAY_TOOLS_SYSTEM = `You have access to one tool to search the user's personal memory database:

Call tools via JSON block:
\`\`\`tool_call
{"name": "mama_search", "input": {"query": "your search query"}}
\`\`\`

Available tool:
- **mama_search**(query) — Search the user's personal memory and past conversations

Decision flow:
1. **Scan initial results for a specific factual answer** to the exact question asked — not just loosely related topics.
2. **Answer directly ONLY if** initial results contain a clear, specific answer to what was asked.
3. **Search if** initial results mention related topics but lack the precise detail needed to answer the question.
4. **Also try different angles**: related objects, activities, or entities (e.g., for "battery life" → "power bank", "charger"; for "workout" → "gym", "exercise").
5. You may search up to ${MAX_TOOL_CALLS} times.

Rules:
- ONLY use facts explicitly present in the results — do NOT infer or fabricate
- Only say "I don't know" after genuinely exhausting all search angles
- Do NOT include tool_call blocks in your final answer`

async function callMamaSearch(
  query: string,
  containerTag: string,
  questionDate?: string
): Promise<unknown[]> {
  try {
    // topicPrefix = "bench_<questionId>" — matches how topics are stored
    const questionId = containerTag.split("-")[0]
    const topicPrefix = `bench_${questionId}`
    const url = new URL(`${MAMA_BASE_URL}/api/mama/search`)
    url.searchParams.set("q", query)
    url.searchParams.set("topicPrefix", topicPrefix)
    url.searchParams.set("limit", "10")
    if (questionDate) url.searchParams.set("questionDate", questionDate)

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) })
    const data = (await res.json()) as { results?: unknown[] }
    return data.results ?? []
  } catch {
    return []
  }
}

function parseToolCalls(text: string): Array<{ name: string; input: Record<string, unknown> }> {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = []
  const regex = /```tool_call\s*\n([\s\S]*?)\n```/g
  let match
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim())
      if (parsed.name && typeof parsed.name === "string") {
        calls.push({ name: parsed.name, input: parsed.input || {} })
      }
    } catch {
      // ignore malformed
    }
  }
  return calls
}

function removedToolCallBlocks(text: string): string {
  return text.replace(/```tool_call\s*\n[\s\S]*?\n```/g, "").trim()
}

export async function runToolUseAnswerPhase(
  _provider: Provider,
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
    const searchStatus = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "search")
    const resultFile = checkpoint.questions[q.questionId]?.phases.search.resultFile
    return (
      status !== "completed" && searchStatus === "completed" && resultFile && existsSync(resultFile)
    )
  })

  if (pendingQuestions.length === 0) {
    logger.info("[tool-use] No questions pending answering")
    return
  }

  logger.info(
    `[tool-use] Answering ${pendingQuestions.length} questions (model: ${TOOL_USE_MODEL}, max tool calls: ${MAX_TOOL_CALLS})`
  )

  for (let i = 0; i < pendingQuestions.length; i++) {
    const question = pendingQuestions[i]
    const containerTag = `${question.questionId}-${checkpoint.dataSourceRunId}`
    const questionDate = checkpoint.questions[question.questionId]?.questionDate
    const resultFile = checkpoint.questions[question.questionId].phases.search.resultFile!

    const startTime = Date.now()
    checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
      status: "in_progress",
      startedAt: new Date().toISOString(),
    })

    // Fresh session per question
    const session = new ClaudeSession({
      model: TOOL_USE_MODEL,
      systemPrompt: GATEWAY_TOOLS_SYSTEM,
      timeoutMs: 120_000,
    })

    try {
      await session.start()

      const searchData = JSON.parse(readFileSync(resultFile, "utf8"))
      const initialContext: unknown[] = searchData.results || []
      // Use raw decision text — buildContextString uses keyword snippet extraction
      // which produces empty strings when query and content have a semantic gap.
      const contextStr = initialContext
        .slice(0, 10)
        .map((r, i) => {
          const rec = r as Record<string, unknown>
          const text = (rec.decision as string) || (rec.content as string) || ""
          return `[${i + 1}] topic: ${rec.topic}\n${text.slice(0, 400)}`
        })
        .join("\n\n")

      const firstPrompt = `${questionDate ? `Question date: ${questionDate}\n` : ""}Question: ${question.question}

Initial search results:
${contextStr || "(no results)"}

This question is about a specific thing the user mentioned in a past conversation. Do NOT give generic advice.
Check whether the initial results contain a specific factual answer to this exact question. If not, use mama_search to find it.
Only say "I don't know" after exhausting all search attempts.`

      let response = await session.prompt(firstPrompt)
      let toolCallCount = 0

      // Tool-use loop
      while (toolCallCount < MAX_TOOL_CALLS) {
        const toolCalls = parseToolCalls(response)
        if (toolCalls.length === 0) break

        // Execute tool calls, build results message
        const resultParts: string[] = []
        for (const call of toolCalls) {
          if (call.name === "mama_search") {
            const query = String(call.input.query || "")
            toolCallCount++
            logger.debug(`[tool-use] ${question.questionId} tool call ${toolCallCount}: "${query}"`)
            const results = await callMamaSearch(query, containerTag, questionDate)
            // Use raw decision text so Claude sees full content regardless of keyword-based snippet extraction
            const snippet = results
              .slice(0, 5)
              .map((r, i) => {
                const rec = r as Record<string, unknown>
                const text = (rec.decision as string) || (rec.content as string) || ""
                return `[${i + 1}] topic: ${rec.topic}\n${text.slice(0, 400)}`
              })
              .join("\n\n")
            resultParts.push(`mama_search("${query}") results:\n${snippet || "(no results)"}`)
          }
        }

        if (resultParts.length === 0) break

        // Feed results back, ask for answer
        response = await session.prompt(
          resultParts.join("\n\n") +
            "\n\nBased on all information gathered, provide your final answer."
        )
      }

      const finalAnswer = removedToolCallBlocks(response).trim()
      if (!finalAnswer) throw new Error("Empty answer from model")

      const durationMs = Date.now() - startTime
      checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
        status: "completed",
        hypothesis: finalAnswer,
        completedAt: new Date().toISOString(),
        durationMs,
      })

      logger.progress(
        i + 1,
        pendingQuestions.length,
        `[tool-use] Answered ${question.questionId} (${durationMs}ms, ${toolCallCount} tool calls)`
      )
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
        status: "failed",
        error,
      })
      logger.error(
        `[tool-use] Failed to answer ${question.questionId}: ${error} | ${e instanceof Error ? e.stack?.split("\n")[1] : ""}`
      )
    } finally {
      session.close()
    }
  }
}
