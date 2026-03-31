import type { Judge, JudgeConfig, JudgeInput, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { buildJudgePrompt, parseJudgeResponse, getJudgePrompt } from "./base"
import { logger } from "../utils/logger"
import { getModelConfig, ModelConfig, DEFAULT_JUDGE_MODELS } from "../utils/models"
import { generateTextForModel } from "../utils/text-generation"
import type { ClaudeSession } from "../utils/claude-session"

export class AnthropicJudge implements Judge {
  name = "anthropic"
  private modelConfig: ModelConfig | null = null
  private claudeSession: ClaudeSession | null = null

  setClaudeSession(session: ClaudeSession): void {
    this.claudeSession = session
  }

  async initialize(config: JudgeConfig): Promise<void> {
    const modelAlias = config.model || DEFAULT_JUDGE_MODELS.anthropic
    this.modelConfig = getModelConfig(modelAlias)
    logger.info(
      `Initialized Anthropic judge with model: ${this.modelConfig.displayName} (${this.modelConfig.id})`
    )
  }

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    if (!this.modelConfig) throw new Error("Judge not initialized")

    const prompt = buildJudgePrompt(input)
    const text = await generateTextForModel(this.modelConfig, prompt, {
      claudeSession: this.claudeSession ?? undefined,
    })

    return parseJudgeResponse(text)
  }

  getPromptForQuestionType(questionType: string, providerPrompts?: ProviderPrompts): string {
    return getJudgePrompt(questionType, providerPrompts)
  }

  getModelConfig() {
    if (!this.modelConfig) throw new Error("Judge not initialized")
    return this.modelConfig
  }
}

export default AnthropicJudge
