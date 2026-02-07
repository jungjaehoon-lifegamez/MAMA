/**
 * Category Router
 *
 * Routes messages to agents based on category pattern matching.
 * Categories are checked after explicit triggers but before keyword matching,
 * providing more precise routing than simple keywords.
 *
 * Supports regex patterns, priority ordering, and Korean/English patterns.
 */

import type { CategoryConfig, AgentPersonaConfig } from './types.js';

/**
 * Result of a category match
 */
export interface CategoryMatchResult {
  /** Matched category name */
  categoryName: string;
  /** Agent IDs to route to */
  agentIds: string[];
  /** The pattern that matched */
  matchedPattern: string;
}

/**
 * Category Router
 */
export class CategoryRouter {
  private categories: CategoryConfig[];

  /** Compiled regex cache: Map<pattern_string, RegExp> */
  private regexCache: Map<string, RegExp> = new Map();

  constructor(categories: CategoryConfig[] = []) {
    this.categories = this.sortByPriority(categories);
    this.precompilePatterns(this.categories);
  }

  /**
   * Route a message to agents based on category patterns.
   * Returns the first matching category's agents, or null if no match.
   */
  route(content: string, availableAgents: AgentPersonaConfig[]): CategoryMatchResult | null {
    const availableIds = new Set(availableAgents.map((a) => a.id));

    for (const category of this.categories) {
      for (const pattern of category.patterns) {
        const regex = this.getCompiledRegex(pattern);
        if (!regex) continue;

        if (regex.test(content)) {
          // Filter to only available agents
          const matchedAgents = category.agent_ids.filter((id) => availableIds.has(id));

          if (matchedAgents.length > 0) {
            return {
              categoryName: category.name,
              agentIds: matchedAgents,
              matchedPattern: pattern,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Update categories (for hot reload)
   */
  updateCategories(categories: CategoryConfig[]): void {
    this.regexCache.clear();
    this.categories = this.sortByPriority(categories);
    this.precompilePatterns(this.categories);
  }

  /**
   * Get current categories (for debugging)
   */
  getCategories(): CategoryConfig[] {
    return [...this.categories];
  }

  /**
   * Sort categories by priority (higher first)
   */
  private sortByPriority(categories: CategoryConfig[]): CategoryConfig[] {
    return [...categories].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /**
   * Precompile all regex patterns for performance
   */
  private precompilePatterns(categories: CategoryConfig[]): void {
    for (const category of categories) {
      for (const pattern of category.patterns) {
        this.getCompiledRegex(pattern);
      }
    }
  }

  /**
   * Get or compile a regex pattern (case-insensitive)
   */
  private getCompiledRegex(pattern: string): RegExp | null {
    if (this.regexCache.has(pattern)) {
      return this.regexCache.get(pattern)!;
    }

    try {
      const regex = new RegExp(pattern, 'i');
      this.regexCache.set(pattern, regex);
      return regex;
    } catch {
      console.warn(`[CategoryRouter] Invalid regex pattern: ${pattern}`);
      return null;
    }
  }
}
