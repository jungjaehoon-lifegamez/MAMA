/**
 * Swarm Anti-Pattern Detector
 *
 * Detects repetitive failure patterns for agents before task execution.
 * Searches MAMA DB for past failures and provides warnings to prevent recurring issues.
 *
 * Features:
 * - Queries MAMA DB for agent-specific failure history (topic: swarm:{agentId}:failed)
 * - Detects patterns when failure count exceeds threshold (default: 2)
 * - Generates actionable warnings with recommendations
 * - Graceful fallback when MAMA DB unavailable
 *
 * @module swarm-anti-pattern-detector
 * @version 1.0
 */

import type { MamaApiClient } from '../../gateways/context-injector.js';

/**
 * Anti-pattern warning structure
 */
export interface AntiPatternWarning {
  /** Agent ID that exhibited the pattern */
  agentId: string;
  /** Pattern description */
  pattern: string;
  /** Number of recent failures */
  failureCount: number;
  /** Last error message (if available) */
  lastError?: string;
  /** Recommended action to avoid repeating the failure */
  recommendation: string;
}

/**
 * Configuration options for AntiPatternDetector
 */
export interface AntiPatternDetectorOptions {
  /** MamaApiClient for searching past decisions */
  mamaApi: MamaApiClient;
  /** Minimum failure count to trigger warning (default: 2) */
  minFailures?: number;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

/**
 * Swarm Anti-Pattern Detector
 *
 * Analyzes past task failures to detect patterns and warn agents before execution.
 * Integrates with SwarmTaskRunner to inject warnings into task prompts.
 *
 * @example
 * ```typescript
 * const detector = new SwarmAntiPatternDetector({
 *   mamaApi: createMamaApiAdapter(),
 *   minFailures: 2,
 *   verbose: true
 * });
 *
 * const warnings = await detector.detect('developer', 'Implement auth');
 * if (warnings.length > 0) {
 *   console.log(detector.formatWarnings(warnings));
 * }
 * ```
 */
export class SwarmAntiPatternDetector {
  private mamaApi: MamaApiClient;
  private options: Required<Omit<AntiPatternDetectorOptions, 'mamaApi'>>;

  constructor(options: AntiPatternDetectorOptions) {
    this.mamaApi = options.mamaApi;
    this.options = {
      minFailures: options.minFailures ?? 2,
      verbose: options.verbose ?? false,
    };
  }

  /**
   * Detect anti-patterns for a given agent before task execution
   *
   * @param agentId - Agent about to execute a task
   * @param taskDescription - Task description for context matching
   * @returns Array of warnings (empty if no patterns detected)
   */
  async detect(agentId: string, taskDescription: string): Promise<AntiPatternWarning[]> {
    try {
      // Search for failed tasks by this agent
      const topic = `swarm:${agentId}:failed`;
      const results = await this.mamaApi.search(topic, 10);

      if (this.options.verbose) {
        console.log(
          `[AntiPatternDetector] Found ${results.length} past failures for agent ${agentId}`
        );
      }

      // Filter for actual failures (outcome === 'failed')
      const failures = results.filter((r) => r.outcome === 'failed');

      if (failures.length < this.options.minFailures) {
        // Not enough failures to trigger warning
        return [];
      }

      // Analyze failures for patterns
      const warnings: AntiPatternWarning[] = [];

      // Check for similar error patterns in task description
      const similarFailures = failures.filter((f) =>
        this.isSimilarContext(taskDescription, f.reasoning || '')
      );

      if (similarFailures.length >= this.options.minFailures) {
        // Specific pattern detected
        const lastFailure = similarFailures[0];
        warnings.push({
          agentId,
          pattern: `Repeated failures on similar tasks (${similarFailures.length} occurrences)`,
          failureCount: similarFailures.length,
          lastError: lastFailure.reasoning,
          recommendation: `Review previous error: "${this.truncate(lastFailure.reasoning || 'Unknown error', 100)}". Consider alternative approach.`,
        });
      } else if (failures.length >= this.options.minFailures) {
        // General failure pattern
        const lastFailure = failures[0];
        warnings.push({
          agentId,
          pattern: `High failure rate for this agent (${failures.length} recent failures)`,
          failureCount: failures.length,
          lastError: lastFailure.reasoning,
          recommendation: `Agent has ${failures.length} recent failures. Proceed with caution and verify approach before execution.`,
        });
      }

      if (this.options.verbose && warnings.length > 0) {
        console.log(
          `[AntiPatternDetector] Generated ${warnings.length} warnings for agent ${agentId}`
        );
      }

      return warnings;
    } catch (error) {
      // Graceful fallback - log error but don't block task execution
      if (this.options.verbose) {
        console.warn(
          `[AntiPatternDetector] Failed to detect patterns for agent ${agentId}:`,
          error
        );
      }
      return [];
    }
  }

  /**
   * Format warnings into a prompt warning section
   *
   * @param warnings - Array of warnings to format
   * @returns Formatted warning text (empty string if no warnings)
   */
  formatWarnings(warnings: AntiPatternWarning[]): string {
    if (warnings.length === 0) {
      return '';
    }

    const header = '⚠️ **Anti-pattern Warning** — Previous failures detected for this agent:\n';
    const lines = warnings.map(
      (w) =>
        `- Agent \`${w.agentId}\`: ${w.pattern} (${w.failureCount} failures)\n  Recommendation: ${w.recommendation}`
    );

    return header + lines.join('\n');
  }

  /**
   * Check if task description is similar to a past failure context
   *
   * Simple keyword-based similarity check.
   * Can be enhanced with semantic similarity in the future.
   */
  private isSimilarContext(taskDescription: string, pastError: string): boolean {
    if (!pastError) {
      return false;
    }

    const taskLower = taskDescription.toLowerCase();
    const errorLower = pastError.toLowerCase();

    // Extract key terms (simple approach - look for common technical keywords)
    const taskKeywords = this.extractKeywords(taskLower);
    const errorKeywords = this.extractKeywords(errorLower);

    // Check for keyword overlap using Jaccard similarity (at least 30% match)
    const intersection = taskKeywords.filter((kw) => errorKeywords.includes(kw));
    const union = [...new Set([...taskKeywords, ...errorKeywords])];
    const similarity = intersection.length / Math.max(union.length, 1);

    return similarity >= 0.3;
  }

  /**
   * Extract keywords from text (simple tokenization)
   */
  private extractKeywords(text: string): string[] {
    // Split by whitespace and filter out common words
    const commonWords = new Set([
      'the',
      'a',
      'an',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
      'by',
      'from',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'this',
      'that',
      'these',
      'those',
      'then',
      'than',
      'has',
      'have',
      'had',
      'can',
      'could',
      'should',
      'will',
      'would',
      'not',
      'no',
      'do',
      'does',
      'did',
      'done',
      'when',
      'while',
      'after',
      'before',
      'during',
      'using',
      'used',
      'use',
      'into',
      'about',
      'task',
      'tasks',
      'error',
      'errors',
      'failed',
      'fail',
    ]);

    return text
      .split(/\s+/)
      .map((word) => word.replace(/[^a-z0-9]/g, ''))
      .filter((word) => word.length > 2 && !commonWords.has(word));
  }

  /**
   * Truncate text to max length with ellipsis
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + '...';
  }
}
