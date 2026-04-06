/**
 * Tool-use Answer Phase
 *
 * ClaudeSession(CLI) + gateway-tools pattern: LLM calls mama_search directly.
 * Static search results as initial context, Claude re-searches if insufficient.
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

const MAX_TOOL_CALLS = 3

function getToolUseModel(): string {
  return process.env.MEMORYBENCH_TOOL_USE_MODEL || "sonnet"
}

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

/** Format search results as raw text for LLM consumption */
function formatResults(results: unknown[], limit: number): string {
  return results
    .slice(0, limit)
    .map((r, i) => {
      const rec = r as Record<string, unknown>
      const text = (rec.decision as string) || (rec.content as string) || ""
      return `[${i + 1}] topic: ${rec.topic}\n${text}`
    })
    .join("\n\n")
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
      // ignore malformed tool_call blocks
    }
  }
  return calls
}

function removeToolCallBlocks(text: string): string {
  return text.replace(/```tool_call\s*\n[\s\S]*?\n```/g, "").trim()
}

function getTypeInstruction(questionType: string): string {
  switch (questionType) {
    case "single-session-preference":
      return `[PREFERENCE QUESTION] The user is asking for a recommendation or advice. Look for ANY related items, purchases, hobbies, or preferences the user mentioned — even if not directly about the question topic. Use what you find to personalize your response.`
    case "temporal-reasoning":
      return `[TEMPORAL QUESTION] This requires date calculation. Identify exact dates from the context, compute the difference carefully (count calendar days/months), and show your math.`
    case "knowledge-update":
      return `[KNOWLEDGE UPDATE QUESTION] The user's situation may have changed over time. Look for the LATEST information. Pay attention to words like "initially", "now", "recently", "upgraded".`
    case "multi-session":
      return `[MULTI-SESSION QUESTION] The answer may require combining information scattered across multiple conversations. Count carefully and list each item before giving a total.`
    default:
      return `[FACTUAL RECALL] Answer with the specific fact the user mentioned. Be precise with names, numbers, and details.`
  }
}

export async function runToolUseAnswerPhase(
  provider: Provider,
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

  const model = getToolUseModel()
  logger.info(
    `[tool-use] Answering ${pendingQuestions.length} questions (model: ${model}, max tool calls: ${MAX_TOOL_CALLS})`
  )

  for (let i = 0; i < pendingQuestions.length; i++) {
    const question = pendingQuestions[i]
    const containerTag = `${question.questionId}-${checkpoint.dataSourceRunId}`
    const questionDate = checkpoint.questions[question.questionId]?.questionDate
    const questionType = checkpoint.questions[question.questionId]?.questionType || ""
    const resultFile = checkpoint.questions[question.questionId]?.phases.search.resultFile ?? ""
    if (!resultFile) continue

    const startTime = Date.now()
    checkpointManager.updatePhase(checkpoint, question.questionId, "answer", {
      status: "in_progress",
      startedAt: new Date().toISOString(),
    })

    const session = new ClaudeSession({
      model,
      systemPrompt: GATEWAY_TOOLS_SYSTEM,
      timeoutMs: 120_000,
    })

    try {
      await session.start()

      const searchData = JSON.parse(readFileSync(resultFile, "utf8"))
      const initialContext: unknown[] = searchData.results || []
      const contextStr = formatResults(initialContext, 10)
      const typeInstruction = getTypeInstruction(questionType)

      const firstPrompt = `${questionDate ? `Question date: ${questionDate}\n` : ""}Question: ${question.question}

${typeInstruction}

Initial search results:
${contextStr || "(no results)"}

This question is about a specific thing the user mentioned in a past conversation. Do NOT give generic advice.
Check whether the initial results contain a specific factual answer to this exact question. If not, use mama_search to find it.
Only say "I don't know" after exhausting all search attempts.`

      let response = await session.prompt(firstPrompt)
      let toolCallCount = 0

      while (toolCallCount < MAX_TOOL_CALLS) {
        const toolCalls = parseToolCalls(response)
        if (toolCalls.length === 0) break

        const resultParts: string[] = []
        for (const call of toolCalls) {
          if (call.name === "mama_search") {
            const query = String(call.input.query || "")
            toolCallCount++
            logger.debug(`[tool-use] ${question.questionId} tool call ${toolCallCount}: "${query}"`)
            const results = await provider.search(query, {
              containerTag,
              limit: 10,
              questionDate,
            })
            resultParts.push(
              `mama_search("${query}") results:\n${formatResults(results, 5) || "(no results)"}`
            )
          }
        }

        if (resultParts.length === 0) break

        response = await session.prompt(
          resultParts.join("\n\n") +
            "\n\nBased on all information gathered, provide your final answer."
        )
      }

      const finalAnswer = removeToolCallBlocks(response)
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
      logger.error(`[tool-use] Failed to answer ${question.questionId}: ${error}`)
    } finally {
      session.close()
    }
  }
}
