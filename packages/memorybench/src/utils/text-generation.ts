import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { generateText } from "ai"

import { config } from "./config"
import { executeCodexPrompt } from "./codex"
import type { ModelConfig } from "./models"
import type { ClaudeSession } from "./claude-session"
import type { CodexSession } from "./codex-session"

function createSdkModel(modelConfig: ModelConfig) {
  switch (modelConfig.provider) {
    case "openai":
      return createOpenAI({ apiKey: config.openaiApiKey })(modelConfig.id)
    case "anthropic":
      return createAnthropic({ apiKey: config.anthropicApiKey })(modelConfig.id)
    case "google":
      return createGoogleGenerativeAI({ apiKey: config.googleApiKey })(modelConfig.id)
  }
}

export async function generateTextForModel(
  modelConfig: ModelConfig,
  prompt: string,
  options?: { cwd?: string; claudeSession?: ClaudeSession; codexSession?: CodexSession }
): Promise<string> {
  if (modelConfig.execution === "codex-cli") {
    if (options?.codexSession) {
      return options.codexSession.prompt(prompt)
    }
    return executeCodexPrompt({
      model: modelConfig.id,
      prompt,
      cwd: options?.cwd,
    })
  }

  if (modelConfig.execution === "claude-cli") {
    if (options?.claudeSession) {
      return options.claudeSession.prompt(prompt)
    }
    // Fallback: one-shot spawn (no persistent session provided)
    const { executeClaudePrompt } = await import("./codex")
    return executeClaudePrompt({
      model: modelConfig.id,
      prompt,
      cwd: options?.cwd,
    })
  }

  const params: Record<string, unknown> = {
    model: createSdkModel(modelConfig),
    prompt,
    maxTokens: modelConfig.defaultMaxTokens,
  }

  if (modelConfig.supportsTemperature) {
    params.temperature = modelConfig.defaultTemperature
  }

  const { text } = await generateText(params as Parameters<typeof generateText>[0])
  return text
}
