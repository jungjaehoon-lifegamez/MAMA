/**
 * Token Budget Enforcement (STORY-008)
 *
 * Provides fail-closed enforcement of per-model context window limits.
 * When total tokens exceed the model's hard limit, a structured error
 * is thrown instead of silently truncating.
 */

import { getConfig } from '../cli/config/config-manager.js';
import { countTokens } from './token-estimator.js';

/** Default per-model-prefix context window limits */
const DEFAULT_MODEL_LIMITS: Record<string, number> = {
  claude: 180_000,
  codex: 120_000,
  gpt: 120_000,
};

/**
 * Structured error thrown when token budget is exceeded.
 */
export class TokenBudgetExceededError extends Error {
  readonly code = 'TOKEN_BUDGET_EXCEEDED' as const;
  readonly budget: TokenBudget;

  constructor(budget: TokenBudget) {
    super(
      `Token budget exceeded for model "${budget.model}": ` +
        `${budget.totalTokens} tokens > ${budget.limitTokens} limit ` +
        `(system=${budget.systemTokens}, tools=${budget.toolsTokens}, history=${budget.historyTokens})`
    );
    this.name = 'TokenBudgetExceededError';
    this.budget = budget;
  }
}

/**
 * Token budget breakdown by category.
 */
export interface TokenBudget {
  model: string;
  limitTokens: number;
  systemTokens: number;
  toolsTokens: number;
  historyTokens: number;
  totalTokens: number;
  withinBudget: boolean;
}

/**
 * Resolve the context window limit for a given model name.
 * Matches by prefix: "claude-sonnet-4-6" matches "claude" key.
 */
export function getModelLimit(model: string): number {
  const configLimits = getConfig().prompt?.model_limits;
  const limits = { ...DEFAULT_MODEL_LIMITS, ...configLimits };

  const lowerModel = model.toLowerCase();
  for (const [prefix, limit] of Object.entries(limits)) {
    if (lowerModel.startsWith(prefix.toLowerCase())) {
      return limit;
    }
  }

  // Fail-closed: unknown model gets conservative 120K limit
  return 120_000;
}

/**
 * Calculate token budget breakdown for a prompt.
 *
 * @param model - Model name (e.g., "claude-sonnet-4-6")
 * @param systemPrompt - System prompt text
 * @param toolsPrompt - Gateway tools prompt text
 * @param historyText - Conversation history text
 * @returns Token budget breakdown
 */
export function calculateBudget(
  model: string,
  systemPrompt: string,
  toolsPrompt: string = '',
  historyText: string = ''
): TokenBudget {
  const limitTokens = getModelLimit(model);
  const systemTokens = countTokens(systemPrompt);
  const toolsTokens = countTokens(toolsPrompt);
  const historyTokens = countTokens(historyText);
  const totalTokens = systemTokens + toolsTokens + historyTokens;

  return {
    model,
    limitTokens,
    systemTokens,
    toolsTokens,
    historyTokens,
    totalTokens,
    withinBudget: totalTokens <= limitTokens,
  };
}

/**
 * Enforce token budget. Throws TokenBudgetExceededError if over limit.
 *
 * @throws {TokenBudgetExceededError} When total tokens exceed model limit
 */
export function enforceBudget(
  model: string,
  systemPrompt: string,
  toolsPrompt: string = '',
  historyText: string = ''
): TokenBudget {
  const budget = calculateBudget(model, systemPrompt, toolsPrompt, historyText);
  if (!budget.withinBudget) {
    throw new TokenBudgetExceededError(budget);
  }
  return budget;
}
