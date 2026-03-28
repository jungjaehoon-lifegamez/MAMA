import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText } from "ai"

const client = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const { text } = await generateText({
  model: client("claude-haiku-4-5-20251001"),
  prompt: "Say hi",
  maxTokens: 20,
})
console.log("✅ OK:", text)
