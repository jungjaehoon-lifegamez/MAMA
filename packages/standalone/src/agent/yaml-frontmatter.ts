/**
 * YAML Frontmatter Parser for MAMA OS Standalone
 *
 * Parses YAML frontmatter from markdown rule files and filters rules
 * by agent context (agentId, tier, channel, keywords). Used by the
 * prompt enhancer to inject only relevant rules into system prompts.
 */

import * as yaml from 'js-yaml';

/**
 * Filtering criteria embedded in rule frontmatter.
 * Each field uses OR logic internally; AND logic across fields.
 */
export interface AppliesTo {
  /** Agent IDs this rule applies to */
  agentId?: string[];
  /** Tier levels this rule applies to */
  tier?: number[];
  /** Channel IDs this rule applies to */
  channel?: string[];
  /** Keywords that activate this rule */
  keywords?: string[];
}

/**
 * Runtime context used to match rules against the current agent state.
 */
export interface RuleContext {
  /** Current agent identifier */
  agentId?: string;
  /** Current tier level */
  tier?: number;
  /** Current channel identifier */
  channelId?: string;
  /** Active keywords for the current request */
  keywords?: string[];
}

/**
 * Result of parsing a markdown file with optional YAML frontmatter.
 */
export interface ParsedRule {
  /** Filtering criteria, or null for universal rules (applies to all) */
  appliesTo: AppliesTo | null;
  /** Markdown content with frontmatter stripped */
  content: string;
  /** Original full content including frontmatter (for hashing) */
  rawContent: string;
}

interface RawFrontmatter {
  applies_to?: {
    agent_id?: string[];
    tier?: number[];
    channel?: string[];
    keywords?: string[];
  };
}

/**
 * Parse YAML frontmatter from a markdown rule file.
 *
 * Detects `---` delimited YAML block at the start of the file,
 * extracts the `applies_to` field (snake_case in YAML → camelCase in TS),
 * and returns the markdown content with frontmatter stripped.
 *
 * On malformed YAML, logs a warning and returns `appliesTo: null`
 * (treating the rule as universal).
 *
 * @param markdownContent - Full markdown file content including frontmatter
 * @returns Parsed rule with filtering criteria and cleaned content
 */
export function parseFrontmatter(markdownContent: string): ParsedRule {
  const rawContent = markdownContent;

  // Match --- delimited YAML block at start of file
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = frontmatterRegex.exec(markdownContent);

  if (!match) {
    return {
      appliesTo: null,
      content: markdownContent,
      rawContent,
    };
  }

  const yamlBlock = match[1];
  const content = markdownContent.slice(match[0].length);

  let parsed: RawFrontmatter;
  try {
    parsed = (yaml.load(yamlBlock) as RawFrontmatter) ?? {};
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[yaml-frontmatter] Malformed YAML frontmatter: ${message}`);
    return {
      appliesTo: null,
      content,
      rawContent,
    };
  }

  if (!parsed.applies_to) {
    return {
      appliesTo: null,
      content,
      rawContent,
    };
  }

  const raw = parsed.applies_to;
  const appliesTo: AppliesTo = {};

  if (Array.isArray(raw.agent_id) && raw.agent_id.length > 0) {
    appliesTo.agentId = raw.agent_id;
  }
  if (Array.isArray(raw.tier) && raw.tier.length > 0) {
    appliesTo.tier = raw.tier;
  }
  if (Array.isArray(raw.channel) && raw.channel.length > 0) {
    appliesTo.channel = raw.channel;
  }
  if (Array.isArray(raw.keywords) && raw.keywords.length > 0) {
    appliesTo.keywords = raw.keywords;
  }

  // If no valid fields were extracted, treat as universal
  const hasFields = Object.keys(appliesTo).length > 0;

  return {
    appliesTo: hasFields ? appliesTo : null,
    content,
    rawContent,
  };
}

/**
 * Check whether a rule's `appliesTo` criteria match the given context.
 *
 * Logic:
 * - If `appliesTo` is null → true (universal rule, always matches)
 * - If `context` is undefined → true (no filtering applied)
 * - OR within each field: e.g., `agentId: ['dev', 'reviewer']` matches either
 * - AND across fields: all present fields must match
 * - Fields missing from `appliesTo` are skipped (not checked)
 *
 * @param appliesTo - Rule filtering criteria (null = universal)
 * @param context - Current agent runtime context (undefined = no filtering)
 * @returns true if the rule should be included
 */
export function matchesContext(
  appliesTo: AppliesTo | null,
  context: RuleContext | undefined
): boolean {
  if (appliesTo === null) {
    return true;
  }

  if (context === undefined) {
    return true;
  }

  // Check agentId: OR within field
  if (appliesTo.agentId && appliesTo.agentId.length > 0) {
    if (!context.agentId || !appliesTo.agentId.includes(context.agentId)) {
      return false;
    }
  }

  // Check tier: OR within field
  if (appliesTo.tier && appliesTo.tier.length > 0) {
    if (context.tier === undefined || !appliesTo.tier.includes(context.tier)) {
      return false;
    }
  }

  // Check channel: OR within field
  if (appliesTo.channel && appliesTo.channel.length > 0) {
    if (!context.channelId || !appliesTo.channel.includes(context.channelId)) {
      return false;
    }
  }

  // Check keywords: OR within field (at least one keyword must match)
  if (appliesTo.keywords && appliesTo.keywords.length > 0) {
    if (!context.keywords || context.keywords.length === 0) {
      return false;
    }
    const hasMatchingKeyword = appliesTo.keywords.some((kw) => context.keywords!.includes(kw));
    if (!hasMatchingKeyword) {
      return false;
    }
  }

  return true;
}
