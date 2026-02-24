/**
 * Prompt Size Monitor for MAMA OS Standalone
 *
 * Monitors system prompt size and provides priority-based graceful truncation.
 * Layers are assigned priorities (1=critical, 6=ephemeral) and truncated
 * from lowest priority first when size limits are exceeded.
 *
 * Uses js-tiktoken for accurate token counting (STORY-007).
 */

import { getConfig } from '../cli/config/config-manager.js';
import { countTokens } from './token-estimator.js';

/**
 * A named layer of the system prompt with a priority level.
 *
 * Priority levels:
 * - 1: CLAUDE.md, SOUL.md, IDENTITY.md (NEVER truncate)
 * - 2: Gateway Tools (extreme truncation only)
 * - 3: Context Prompt (regeneratable)
 * - 4: AGENTS.md (can re-read from file)
 * - 5: Rules (can read file on demand)
 * - 6: Keyword Instructions (ephemeral, safe to drop)
 */
export interface PromptLayer {
  /** Layer identifier for diagnostics */
  name: string;
  /** Layer content */
  content: string;
  /**
   * Priority level (1 = highest / never truncate, 6 = lowest / drop first).
   *
   * 1 = CLAUDE.md, SOUL.md, IDENTITY.md (NEVER truncate)
   * 2 = Gateway Tools (extreme only)
   * 3 = Context Prompt (regeneratable)
   * 4 = AGENTS.md (can re-read)
   * 5 = Rules (can read file)
   * 6 = Keyword Instructions (ephemeral)
   */
  priority: number;
}

/**
 * Result of a prompt size check or enforcement pass.
 */
export interface MonitorResult {
  /** Total character count across all layers */
  totalChars: number;
  /** @deprecated Use totalTokens instead. This uses chars/4 heuristic. */
  estimatedTokens: number;
  /** Actual token count via tiktoken (or byte-length fallback) */
  totalTokens: number;
  /** Whether total is within the truncation threshold */
  withinBudget: boolean;
  /** Warning message if approaching or exceeding limits, null otherwise */
  warning: string | null;
  /** Names of layers that were truncated or removed */
  truncatedLayers: string[];
}

/** Token count at which a warning is emitted */
const WARN_TOKENS = () => getConfig().prompt?.warn_tokens ?? 3_750;
/** Token count at which truncation begins */
const TRUNCATE_TOKENS = () => getConfig().prompt?.truncate_tokens ?? 6_250;
/** Absolute maximum — anything beyond is force-truncated */
const HARD_LIMIT_TOKENS = () => getConfig().prompt?.hard_limit_tokens ?? 10_000;

/**
 * Monitors and enforces system prompt size limits using token counting.
 *
 * Uses a priority-based truncation strategy: layers with higher priority
 * numbers (lower importance) are truncated first. Priority 1 layers are
 * never truncated. Within the same priority, larger layers are truncated first.
 *
 * @example
 * ```typescript
 * const monitor = new PromptSizeMonitor();
 * const result = monitor.check(layers);
 * if (!result.withinBudget) {
 *   const { layers: trimmed } = monitor.enforce(layers);
 * }
 * ```
 */
export class PromptSizeMonitor {
  /**
   * Check prompt layers for size and return diagnostic info without modifying them.
   *
   * @param layers - Prompt layers to analyze
   * @returns Monitor result with size metrics and warnings
   */
  check(layers: PromptLayer[]): MonitorResult {
    const totalChars = layers.reduce((sum, layer) => sum + layer.content.length, 0);
    const combined = layers.map((l) => l.content).join('');
    const totalTokens = countTokens(combined);
    const estimatedTokens = this.estimateTokens(totalChars);
    const truncatedLayers: string[] = [];

    let warning: string | null = null;
    let withinBudget = true;

    if (totalTokens > HARD_LIMIT_TOKENS()) {
      warning =
        `System prompt exceeds hard limit: ${totalTokens} tokens ` +
        `(${totalChars} chars) > ${HARD_LIMIT_TOKENS()} token limit. ` +
        `Force truncation required.`;
      withinBudget = false;
    } else if (totalTokens > TRUNCATE_TOKENS()) {
      warning =
        `System prompt exceeds truncation threshold: ${totalTokens} tokens ` +
        `(${totalChars} chars) > ${TRUNCATE_TOKENS()} token limit. ` +
        `Truncation recommended.`;
      withinBudget = false;
    } else if (totalTokens > WARN_TOKENS()) {
      warning =
        `System prompt approaching limit: ${totalTokens} tokens ` +
        `(${totalChars} chars) > ${WARN_TOKENS()} token warning threshold.`;
      withinBudget = true;
    }

    return { totalChars, estimatedTokens, totalTokens, withinBudget, warning, truncatedLayers };
  }

  /**
   * Enforce size limits by truncating layers in priority order.
   *
   * Layers with higher priority numbers (lower importance) are removed first.
   * Within the same priority level, larger layers are removed first.
   * Priority 1 layers are never truncated.
   *
   * @param layers - Prompt layers to enforce limits on
   * @param maxTokens - Maximum allowed tokens (defaults to TRUNCATE_TOKENS)
   * @returns Object with truncated layers array and updated monitor result
   */
  enforce(
    layers: PromptLayer[],
    maxTokens: number = TRUNCATE_TOKENS()
  ): { layers: PromptLayer[]; result: MonitorResult } {
    // Count tokens per layer
    const layerTokens = layers.map((l) => countTokens(l.content));
    const totalTokens = layerTokens.reduce((sum, t) => sum + t, 0);

    if (totalTokens <= maxTokens) {
      return { layers: [...layers], result: this.check(layers) };
    }

    // Sort candidates for truncation: highest priority number first, then largest first
    const sortedByExpendability = layers
      .map((layer, index) => ({ layer, index, tokens: layerTokens[index] }))
      .filter(({ layer }) => layer.priority > 1)
      .sort((a, b) => {
        if (b.layer.priority !== a.layer.priority) {
          return b.layer.priority - a.layer.priority;
        }
        return b.tokens - a.tokens;
      });

    const truncatedLayers: string[] = [];
    const resultLayers = [...layers];
    let currentTokens = totalTokens;

    for (const { layer, index, tokens } of sortedByExpendability) {
      if (currentTokens <= maxTokens) {
        break;
      }

      const excess = currentTokens - maxTokens;

      if (tokens <= excess) {
        // Full removal
        currentTokens -= tokens;
        resultLayers[index] = { ...layer, content: '' };
        truncatedLayers.push(layer.name);
      } else {
        // Partial truncation: estimate chars to remove based on layer's token density
        const charsPerToken = tokens > 0 ? layer.content.length / tokens : 4;
        const charsToRemove = Math.ceil(excess * charsPerToken);
        const truncationMarker = `\n\n[... ${layer.name} truncated: ~${excess} tokens removed ...]`;
        const safeKeep = Math.max(
          0,
          layer.content.length - charsToRemove - truncationMarker.length
        );
        const newContent = layer.content.slice(0, safeKeep) + truncationMarker;
        const newTokens = countTokens(newContent);
        resultLayers[index] = {
          ...layer,
          content: newContent,
        };
        currentTokens = currentTokens - tokens + newTokens;
        truncatedLayers.push(layer.name);
      }
    }

    const finalLayers = resultLayers.filter((layer) => layer.content.length > 0);
    const finalCheck = this.check(finalLayers);

    const withinBudget = finalCheck.totalTokens <= maxTokens;
    let warning: string | null = null;

    if (!withinBudget) {
      warning =
        `System prompt still exceeds limit after truncation: ${finalCheck.totalTokens} tokens. ` +
        `Only priority-1 layers remain.`;
    } else if (truncatedLayers.length > 0) {
      warning =
        `Truncated ${truncatedLayers.length} layer(s) to fit within ${maxTokens} tokens: ` +
        `${truncatedLayers.join(', ')}.`;
    }

    return {
      layers: finalLayers,
      result: {
        ...finalCheck,
        withinBudget,
        warning,
        truncatedLayers,
      },
    };
  }

  /**
   * @deprecated Use countTokens() from token-estimator instead.
   * Estimate token count from character count using chars/4 heuristic.
   */
  estimateTokens(chars: number): number {
    return Math.ceil(chars / 4);
  }
}
