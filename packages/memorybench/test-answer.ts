// Debug test for answer phase
import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText } from "ai"
import { readFileSync } from "fs"

const client = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const resultFile = "data/runs/mama-bench-v1/results/001be529.json"
const searchData = JSON.parse(readFileSync(resultFile, "utf8"))
const context = searchData.results || []
const question = searchData.question

const prompt = `You are answering questions based on conversation history.
Question: ${question}
Context: ${JSON.stringify(context.slice(0, 2), null, 2).slice(0, 1000)}
Answer concisely.`

console.log("Prompt length:", prompt.length)
console.log("Testing generateText...")

try {
  const { text } = await generateText({
    model: client("claude-haiku-4-5-20251001"),
    prompt,
    maxTokens: 100,
  })
  console.log("✅ Answer:", text)
} catch (e: unknown) {
  console.error("❌ Error type:", typeof e)
  console.error("❌ instanceof Error:", e instanceof Error)
  console.error("❌ String(e):", String(e))
  if (e instanceof Error) {
    console.error("❌ message:", e.message)
    console.error("❌ stack:", e.stack?.slice(0, 500))
  } else {
    console.error("❌ raw error:", JSON.stringify(e))
  }
}
