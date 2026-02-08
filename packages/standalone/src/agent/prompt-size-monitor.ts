/**
 * Prompt Size Monitor for MAMA OS Standalone
 *
 * Monitors system prompt size and provides priority-based graceful truncation.
 * Layers are assigned priorities (1=critical, 6=ephemeral) and truncated
 * from lowest priority first when size limits are exceeded.
 */

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
  /** Estimated token count (chars / 4, rounded up) */
  estimatedTokens: number;
  /** Whether total is within the truncation threshold */
  withinBudget: boolean;
  /** Warning message if approaching or exceeding limits, null otherwise */
  warning: string | null;
  /** Names of layers that were truncated or removed */
  truncatedLayers: string[];
}

/** Char count at which a warning is emitted */
const WARN_CHARS = 15_000;
/** Char count at which truncation begins */
const TRUNCATE_CHARS = 25_000;
/** Absolute maximum — anything beyond is force-truncated */
const HARD_LIMIT_CHARS = 40_000;

/**
 * Monitors and enforces system prompt size limits.
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
    const estimatedTokens = this.estimateTokens(totalChars);
    const truncatedLayers: string[] = [];

    let warning: string | null = null;
    let withinBudget = true;

    if (totalChars > HARD_LIMIT_CHARS) {
      warning =
        `System prompt exceeds hard limit: ${totalChars} chars ` +
        `(${estimatedTokens} est. tokens) > ${HARD_LIMIT_CHARS} chars. ` +
        `Force truncation required.`;
      withinBudget = false;
    } else if (totalChars > TRUNCATE_CHARS) {
      warning =
        `System prompt exceeds truncation threshold: ${totalChars} chars ` +
        `(${estimatedTokens} est. tokens) > ${TRUNCATE_CHARS} chars. ` +
        `Truncation recommended.`;
      withinBudget = false;
    } else if (totalChars > WARN_CHARS) {
      warning =
        `System prompt approaching limit: ${totalChars} chars ` +
        `(${estimatedTokens} est. tokens) > ${WARN_CHARS} chars warning threshold.`;
      withinBudget = true;
    }

    return { totalChars, estimatedTokens, withinBudget, warning, truncatedLayers };
  }

  /**
   * Enforce size limits by truncating layers in priority order.
   *
   * Layers with higher priority numbers (lower importance) are removed first.
   * Within the same priority level, larger layers are removed first.
   * Priority 1 layers are never truncated.
   *
   * @param layers - Prompt layers to enforce limits on
   * @param maxChars - Maximum allowed characters (defaults to TRUNCATE_CHARS)
   * @returns Object with truncated layers array and updated monitor result
   */
  enforce(
    layers: PromptLayer[],
    maxChars: number = TRUNCATE_CHARS
  ): { layers: PromptLayer[]; result: MonitorResult } {
    const totalChars = layers.reduce((sum, layer) => sum + layer.content.length, 0);

    if (totalChars <= maxChars) {
      return { layers: [...layers], result: this.check(layers) };
    }

    // Sort candidates for truncation: highest priority number first, then largest first
    const sortedByExpendability = [...layers]
      .map((layer, index) => ({ layer, index }))
      .filter(({ layer }) => layer.priority > 1)
      .sort((a, b) => {
        if (b.layer.priority !== a.layer.priority) {
          return b.layer.priority - a.layer.priority;
        }
        return b.layer.content.length - a.layer.content.length;
      });

    const truncatedLayers: string[] = [];
    const resultLayers = [...layers];
    let currentTotal = totalChars;

    for (const { layer, index } of sortedByExpendability) {
      if (currentTotal <= maxChars) {
        break;
      }

      const excess = currentTotal - maxChars;

      if (layer.content.length <= excess) {
        currentTotal -= layer.content.length;
        resultLayers[index] = { ...layer, content: '' };
        truncatedLayers.push(layer.name);
      } else {
        const keepChars = layer.content.length - excess;
        const truncationMarker = `\n\n[... ${layer.name} truncated: ${excess} chars removed ...]`;
        const safeKeep = Math.max(0, keepChars - truncationMarker.length);
        resultLayers[index] = {
          ...layer,
          content: layer.content.slice(0, safeKeep) + truncationMarker,
        };
        currentTotal = currentTotal - excess + truncationMarker.length;
        truncatedLayers.push(layer.name);
      }
    }

    const finalLayers = resultLayers.filter((layer) => layer.content.length > 0);
    const finalTotal = finalLayers.reduce((sum, layer) => sum + layer.content.length, 0);
    const estimatedTokens = this.estimateTokens(finalTotal);

    const withinBudget = finalTotal <= maxChars;
    let warning: string | null = null;

    if (!withinBudget) {
      warning =
        `System prompt still exceeds limit after truncation: ${finalTotal} chars ` +
        `(${estimatedTokens} est. tokens). Only priority-1 layers remain.`;
    } else if (truncatedLayers.length > 0) {
      warning =
        `Truncated ${truncatedLayers.length} layer(s) to fit within ${maxChars} chars: ` +
        `${truncatedLayers.join(', ')}.`;
    }

    return {
      layers: finalLayers,
      result: {
        totalChars: finalTotal,
        estimatedTokens,
        withinBudget,
        warning,
        truncatedLayers,
      },
    };
  }

  /**
   * Estimate token count from character count.
   *
   * Uses the standard ~4 chars per token heuristic for English text.
   *
   * @param chars - Character count
   * @returns Estimated token count (rounded up)
   */
  estimateTokens(chars: number): number {
    return Math.ceil(chars / 4);
  }
}
