// Reproduce the exact answer phase logic
import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText } from "ai"
import { readFileSync, existsSync } from "fs"
import { buildDefaultAnswerPrompt } from "./src/prompts/defaults"
import { buildContextString } from "./src/types/prompts"
import { countTokens } from "./src/utils/tokens"
import { getModelConfig } from "./src/utils/models"

const modelAlias = "sonnet-4.5"
const modelConfig = getModelConfig(modelAlias)
const client = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const questionId = "001be529"
const resultFile = `data/runs/mama-bench-v1/results/${questionId}.json`

console.log("resultFile exists:", existsSync(resultFile))

const searchData = JSON.parse(readFileSync(resultFile, "utf8"))
const context: unknown[] = searchData.results || []
const question = searchData.question
const questionDate = "2026-01-15"

console.log("question:", question)
console.log("context items:", context.length)

try {
  const basePrompt = buildDefaultAnswerPrompt(question, [], questionDate)
  const prompt = buildDefaultAnswerPrompt(question, context, questionDate)

  const basePromptTokens = countTokens(basePrompt, modelConfig)
  const promptTokens = countTokens(prompt, modelConfig)
  const contextTokens = Math.max(0, promptTokens - basePromptTokens)

  console.log(`Tokens: ${promptTokens} total (${basePromptTokens} base + ${contextTokens} context)`)

  const params = {
    model: client(modelConfig.id),
    prompt,
    maxTokens: modelConfig.defaultMaxTokens,
  }

  console.log("Calling generateText...")
  const { text } = await generateText(params)
  console.log("✅ Answer:", text.slice(0, 200))
} catch (e: unknown) {
  console.error("❌ Error type:", typeof e)
  console.error("❌ instanceof Error:", e instanceof Error)
  console.error("❌ String(e):", String(e))
  if (e && typeof e === "object" && "message" in e) {
    console.error("❌ message:", (e as { message: string }).message)
  }
  if (e instanceof Error) {
    console.error("❌ stack:", e.stack?.slice(0, 1000))
  }
}
