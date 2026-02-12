/**
 * MAMA (Memory-Augmented MCP Architecture) - Decision Context Formatter
 *
 * Formats decision history with token budget enforcement and top-N selection
 * Tasks: 6.1-6.6, 8.1-8.5 (Context formatting with top-N selection)
 * AC #1: Context under 500 tokens
 * AC #4: Rolling summary for large histories
 * AC #5: Top-N selection with summary
 *
 * @module decision-formatter
 * @version 2.0
 * @date 2025-11-14
 */

import { formatTopNContext } from './relevance-scorer.js';

/**
 * Decision object for formatting
 */
export interface DecisionForFormat {
  id?: string;
  topic?: string;
  decision: string;
  reasoning?: string | null;
  outcome?: string | null;
  failure_reason?: string | null;
  limitation?: string | null;
  user_involvement?: string;
  confidence?: number;
  created_at: number | string;
  updated_at?: number | string;
  superseded_by?: string | null;
  relevanceScore?: number;
  similarity?: number;
  recency_age_days?: number;
  recency_score?: number;
  final_score?: number;
  trust_context?: TrustContext | string | null;
  evidence?: string | string[] | unknown;
  alternatives?: string | string[] | unknown;
  risks?: string;
}

/**
 * Trust context object
 */
export interface TrustContext {
  source?: {
    file?: string;
    line?: number;
    author?: string;
    timestamp?: number | string;
  };
  causality?: {
    impact?: string;
  };
  verification?: {
    test_file?: string;
    result?: string;
  };
  context_match?: {
    user_intent?: string;
  };
  track_record?: {
    recent_successes?: unknown[];
    recent_failures?: unknown[];
    success_rate?: number;
    sample_size?: number;
  };
}

/**
 * Semantic edges for related decisions
 */
export interface SemanticEdges {
  refines?: Array<{ topic: string; decision: string }>;
  refined_by?: Array<{ topic: string; decision: string }>;
  contradicts?: Array<{ topic: string; decision: string }>;
  contradicted_by?: Array<{ topic: string; decision: string }>;
}

/**
 * Formatting options
 */
export interface FormatOptions {
  maxTokens?: number;
  useTopN?: boolean;
  topN?: number;
  useTeaser?: boolean;
  limit?: number;
}

/**
 * Safely parse JSON string, returning fallback on error
 */
function safeParseJson<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

/**
 * Format decision context for Claude injection with top-N selection
 *
 * Task 6.1-6.2, 8.1-8.5: Build context format template with top-N selection
 * AC #1: Format decision history
 * AC #4: Handle large histories with rolling summary
 * AC #5: Top-N selection with summary (top 3 full detail, rest summarized)
 *
 * Story 014.7.10 - Task 5: Fallback Formatting
 * Tries Instant Answer format first (if trust_context available), falls back to legacy
 *
 * @param decisions - Decision chain (sorted by relevance)
 * @param options - Formatting options
 * @returns Formatted context for injection
 */
export function formatContext(
  decisions: DecisionForFormat[],
  options: FormatOptions = {}
): string | null {
  const {
    maxTokens = 500,
    useTopN = decisions.length >= 4, // Auto-enable for 4+ decisions
    topN = 3,
    useTeaser = true, // New: Use Teaser format to encourage interaction
  } = options;

  if (!decisions || decisions.length === 0) {
    return null;
  }

  // New approach: Teaser format (curiosity-driven)
  // MAMA = Librarian: Shows book previews, Claude decides to read
  if (useTeaser) {
    // Show top 3 results (Google-style)
    const teaserList = formatTeaserList(decisions, topN);

    if (teaserList) {
      return teaserList;
    }
  }

  // Fallback: Legacy format
  return formatLegacyContext(decisions, { maxTokens, useTopN, topN });
}

/**
 * Format decisions using legacy format (no trust context)
 *
 * Story 014.7.10 - Task 5.1: Fallback formatting
 * AC #3: Graceful degradation for decisions without trust_context
 *
 * @param decisions - Decision chain (sorted by relevance)
 * @param options - Formatting options
 * @returns Formatted context (legacy format)
 */
export function formatLegacyContext(
  decisions: DecisionForFormat[],
  options: FormatOptions = {}
): string | null {
  if (!decisions || decisions.length === 0) {
    return null;
  }

  const { maxTokens = 500, useTopN = decisions.length >= 4, topN = 3 } = options;

  // Task 8.1: Use top-N selection for 4+ decisions (AC #5)
  let context: string;

  if (useTopN && decisions.length > topN) {
    // Task 8.1: Modify to use top-N selection
    context = formatWithTopN(decisions, topN);
  } else {
    // Find current decision (superseded_by = NULL or missing)
    const current = decisions.find((d) => !d.superseded_by) || decisions[0];
    const history = decisions.filter((d) => d.id !== current.id);

    // Task 6.2: Build context format template (legacy)
    if (decisions.length <= 3) {
      // Small history: Full details
      context = formatSmallHistory(current, history);
    } else {
      // Large history: Rolling summary
      context = formatLargeHistory(current, history);
    }
  }

  // Task 6.3, 8.4: Ensure token budget stays under 500 tokens
  return ensureTokenBudget(context, maxTokens);
}

/**
 * Format with top-N selection
 *
 * Task 8.2-8.3: Full detail for top 3, summary for rest
 * AC #5: Top-N selection with summary
 *
 * @param decisions - All decisions (sorted by relevance)
 * @param topN - Number of decisions for full detail
 * @returns Formatted context
 */
function formatWithTopN(decisions: DecisionForFormat[], topN: number): string {
  // Use formatTopNContext from relevance-scorer.js
  const { full, summary } = formatTopNContext(
    decisions.map((d) => ({
      ...d,
      created_at: typeof d.created_at === 'string' ? Date.parse(d.created_at) : d.created_at,
      updated_at:
        typeof d.updated_at === 'string'
          ? Date.parse(d.updated_at)
          : typeof d.updated_at === 'number'
            ? d.updated_at
            : undefined,
      reasoning: d.reasoning === null ? undefined : d.reasoning,
    })),
    topN
  );

  const current = full[0]; // Highest relevance
  const topic = current?.topic || 'Unknown';

  // Task 8.2: Full detail for top 3 decisions
  let context = `
🧠 DECISION HISTORY: ${topic}

Top ${full.length} Most Relevant Decisions:
`.trim();

  for (let i = 0; i < full.length; i++) {
    const d = full[i];
    const duration = calculateDuration(d.created_at);
    const outcomeEmoji = getOutcomeEmoji(d.outcome ?? null);
    const relevancePercent = Math.round((d.relevanceScore || 0) * 100);

    context += `\n\n${i + 1}. ${d.decision} (${duration}, relevance: ${relevancePercent}%) ${outcomeEmoji}`;
    context += `\n   Reasoning: ${d.reasoning || 'N/A'}`;

    if (d.outcome === 'FAILED') {
      context += `\n   ⚠️ Failure: ${d.failure_reason || 'Unknown reason'}`;
    }
  }

  // Task 8.3: Summary for rest (count, duration, key failures only)
  if (summary && summary.count > 0) {
    context += `\n\n━━━━━━━━━━━━━━━━━━━━━━━`;
    context += `\nHistory: ${summary.count} additional decisions over ${summary.duration_days} days`;

    if (summary.failures && summary.failures.length > 0) {
      context += `\n\n⚠️ Other Failures:`;
      for (const failure of summary.failures) {
        context += `\n- ${failure.decision}: ${failure.reason || 'Unknown'}`;
      }
    }
  }

  return context;
}

/**
 * Format small decision history (3 or fewer)
 */
function formatSmallHistory(current: DecisionForFormat, history: DecisionForFormat[]): string {
  const duration = calculateDuration(current.created_at);

  let context = `
🧠 DECISION HISTORY: ${current.topic}

Current: ${current.decision} (${duration}, confidence: ${current.confidence})
Reasoning: ${current.reasoning || 'N/A'}
`.trim();

  // Add history details
  if (history.length > 0) {
    context += '\n\nPrevious Decisions:\n';

    for (const decision of history) {
      const durationDays = calculateDurationDays(
        decision.created_at,
        decision.updated_at || Date.now()
      );
      const outcomeEmoji = getOutcomeEmoji(decision.outcome ?? null);

      context += `- ${decision.decision} (${durationDays} days) ${outcomeEmoji}\n`;

      if (decision.outcome === 'FAILED') {
        context += `  Reason: ${decision.failure_reason || 'Unknown'}\n`;
      }
    }
  }

  return context;
}

/**
 * Format large decision history (4+ decisions)
 *
 * Task 6.2: Rolling summary for large histories
 * AC #4: Highlight top 3 failures
 */
function formatLargeHistory(current: DecisionForFormat, history: DecisionForFormat[]): string {
  // Include current decision in total duration calculation
  const allDecisions = [current, ...history];
  const totalDuration = calculateTotalDuration(allDecisions);

  // Extract failures
  const failures = history.filter((d) => d.outcome === 'FAILED');
  const topFailures = failures.slice(0, 3);

  // Get last evolution
  const lastEvolution = history.length > 0 ? history[0] : null;

  let context = `
🧠 DECISION HISTORY: ${current.topic}

Current: ${current.decision} (confidence: ${current.confidence})
Reasoning: ${current.reasoning || 'N/A'}

History: ${history.length + 1} decisions over ${totalDuration}
`.trim();

  // Add key failures
  if (topFailures.length > 0) {
    context += '\n\n⚠️ Key Failures (avoid these):\n';

    for (const failure of topFailures) {
      context += `- ${failure.decision}: ${failure.failure_reason || 'Unknown reason'}\n`;
    }
  }

  // Add last evolution
  if (lastEvolution) {
    context += `\nLast evolution: ${lastEvolution.decision} → ${current.decision}`;

    if (current.reasoning) {
      const reasonSummary = current.reasoning.substring(0, 100);
      context += ` (${reasonSummary}${current.reasoning.length > 100 ? '...' : ''})`;
    }
  }

  return context;
}

/**
 * Ensure token budget is enforced
 *
 * Task 6.3-6.5: Token budget enforcement
 * AC #1: Context stays under 500 tokens
 */
export function ensureTokenBudget(text: string, maxTokens: number): string {
  // Task 6.4: Token estimation (~1 token per 4 characters)
  const estimatedTokens = estimateTokens(text);

  if (estimatedTokens <= maxTokens) {
    return text;
  }

  // Task 6.5: Truncate to fit budget
  const ratio = maxTokens / estimatedTokens;
  const truncated = text.substring(0, Math.floor(text.length * ratio));

  return truncated + '\n\n... (truncated to fit token budget)';
}

/**
 * Estimate token count from text
 *
 * Task 6.4: Simple token estimation
 * Heuristic: ~1 token per 4 characters
 */
export function estimateTokens(text: string): number {
  // Task 6.4: ~1 token per 4 characters
  return Math.ceil(text.length / 4);
}

/**
 * Calculate human-readable duration
 */
function calculateDuration(timestamp: number | string): string {
  // Handle Unix timestamp (number or numeric string) and ISO 8601 string
  let ts: number;
  if (typeof timestamp === 'string') {
    // Try parsing as number first (e.g., "1763971277689")
    const num = Number(timestamp);
    ts = isNaN(num) ? Date.parse(timestamp) : num;
  } else {
    ts = timestamp;
  }

  if (isNaN(ts) || ts === null || ts === undefined) {
    return 'unknown';
  }

  const now = Date.now();
  const diffMs = now - ts;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / (1000 * 60));
      return `${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;
    }
    return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  }

  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}

/**
 * Calculate duration between two timestamps in days
 */
function calculateDurationDays(start: number | string, end: number | string): number {
  let startTs: number;
  let endTs: number;

  if (typeof start === 'string') {
    const num = Number(start);
    startTs = isNaN(num) ? Date.parse(start) : num;
  } else {
    startTs = start;
  }

  if (typeof end === 'string') {
    const num = Number(end);
    endTs = isNaN(num) ? Date.parse(end) : num;
  } else {
    endTs = end;
  }

  if (isNaN(startTs) || isNaN(endTs)) {
    return 0;
  }

  const diffMs = endTs - startTs;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Calculate total duration across decision history
 */
function calculateTotalDuration(history: DecisionForFormat[]): string {
  if (history.length === 0) {
    return 'N/A';
  }

  // Convert all timestamps to numbers for comparison
  const timestamps = history
    .map((d) => {
      const created =
        typeof d.created_at === 'string' ? Date.parse(d.created_at) : (d.created_at as number);
      const updated = d.updated_at
        ? typeof d.updated_at === 'string'
          ? Date.parse(d.updated_at)
          : d.updated_at
        : created;
      return { created, updated };
    })
    .filter((t) => !isNaN(t.created) && !isNaN(t.updated));

  if (timestamps.length === 0) {
    return 'N/A';
  }

  const earliest = Math.min(...timestamps.map((t) => t.created));
  const latest = Math.max(...timestamps.map((t) => t.updated));

  const durationDays = calculateDurationDays(earliest, latest);

  if (durationDays < 7) {
    return `${durationDays} days`;
  } else if (durationDays < 30) {
    const weeks = Math.floor(durationDays / 7);
    return `${weeks} week${weeks !== 1 ? 's' : ''}`;
  } else {
    const months = Math.floor(durationDays / 30);
    return `${months} month${months !== 1 ? 's' : ''}`;
  }
}

/**
 * Get emoji for outcome
 */
function getOutcomeEmoji(outcome: string | null): string {
  const emojiMap: Record<string, string> = {
    SUCCESS: '✅',
    FAILED: '❌',
    PARTIAL: '⚠️',
    ONGOING: '⏳',
  };

  return outcome ? emojiMap[outcome] || '' : '';
}

/**
 * Format context in Claude-friendly Instant Answer format
 *
 * Story 014.7.10: Claude-Friendly Context Formatting
 * AC #1: Instant Answer format with trust components
 */
export function formatInstantAnswer(
  decision: DecisionForFormat | null,
  options: FormatOptions = {}
): string | null {
  const { maxTokens = 500 } = options;

  if (!decision) {
    return null;
  }

  // Extract quick answer (first line of decision)
  const quickAnswer = extractQuickAnswer(decision);

  if (!quickAnswer) {
    return null;
  }

  // Extract code example (from reasoning)
  const codeExample = extractCodeExample(decision);

  // Format trust context
  const trustSection = formatTrustContext(
    typeof decision.trust_context === 'string'
      ? parseTrustContext(decision.trust_context)
      : decision.trust_context
  );

  // Build output
  let output = `⚡ INSTANT ANSWER\n\n${quickAnswer}`;

  if (codeExample) {
    output += `\n\n${codeExample}`;
  }

  if (trustSection) {
    output += `\n\n${trustSection}`;
  }

  // Token budget check
  if (estimateTokens(output) > maxTokens) {
    output = truncateToFit(output, maxTokens);
  }

  return output;
}

/**
 * Extract quick answer from decision
 */
export function extractQuickAnswer(decision: DecisionForFormat): string | null {
  if (!decision.decision || typeof decision.decision !== 'string') {
    return null;
  }

  const text = decision.decision.trim();

  if (text.length === 0) {
    return null;
  }

  // Extract first line
  const lines = text.split('\n');
  const firstLine = lines[0].trim();

  // Check if first line contains multiple real sentences
  const sentenceMatch = firstLine.match(/^.+?[.!?](?=\s+[A-Z])/);
  if (sentenceMatch) {
    return sentenceMatch[0].trim();
  }

  // Single sentence or no sentence boundary - use full first line if reasonable
  if (firstLine.length <= 150) {
    return firstLine;
  }

  // First line too long - truncate to 100 chars
  return firstLine.substring(0, 100) + '...';
}

/**
 * Extract code example from reasoning
 */
export function extractCodeExample(decision: DecisionForFormat): string | null {
  if (!decision.reasoning || typeof decision.reasoning !== 'string') {
    return null;
  }

  // Match markdown code blocks
  const codeBlockRegex = /```[\s\S]*?```/;
  const match = decision.reasoning.match(codeBlockRegex);

  if (match) {
    return match[0];
  }

  // Check if decision field contains code patterns
  if (decision.decision && typeof decision.decision === 'string') {
    const hasCode =
      decision.decision.includes('mama.save(') ||
      decision.decision.includes('await ') ||
      decision.decision.includes('=>');

    if (hasCode) {
      return `\`\`\`javascript\n${decision.decision}\n\`\`\``;
    }
  }

  return null;
}

/**
 * Format trust context section
 *
 * Story 014.7.10 AC #2: Trust Context display
 */
export function formatTrustContext(trustCtx: TrustContext | null | undefined): string | null {
  if (!trustCtx) {
    return null;
  }

  const lines = ['━'.repeat(40), '🔍 WHY TRUST THIS?', ''];

  let hasContent = false;

  // 1. Source transparency
  if (trustCtx.source) {
    const { file, line, author, timestamp } = trustCtx.source;
    const timeAgo = timestamp ? calculateDuration(timestamp) : 'unknown';
    lines.push(`📍 Source: ${file}:${line} (${timeAgo}, by ${author})`);
    hasContent = true;
  }

  // 2. Causality
  if (trustCtx.causality && trustCtx.causality.impact) {
    lines.push(`🔗 Reason: ${trustCtx.causality.impact}`);
    hasContent = true;
  }

  // 3. Verifiability
  if (trustCtx.verification) {
    const { test_file, result } = trustCtx.verification;
    const status = result === 'success' ? 'passed' : result;
    lines.push(`✅ Verified: ${test_file} ${status}`);
    hasContent = true;
  }

  // 4. Context relevance
  if (trustCtx.context_match && trustCtx.context_match.user_intent) {
    lines.push(`🎯 Applies to: ${trustCtx.context_match.user_intent}`);
    hasContent = true;
  }

  // 5. Track record
  if (trustCtx.track_record) {
    const { recent_successes, recent_failures } = trustCtx.track_record;
    const successCount = recent_successes?.length || 0;
    const failureCount = recent_failures?.length || 0;
    const total = successCount + failureCount;

    if (total > 0) {
      lines.push(`📊 Track record: ${successCount}/${total} recent successes`);
      hasContent = true;
    }
  }

  if (!hasContent) {
    return null;
  }

  lines.push('━'.repeat(40));

  return lines.join('\n');
}

/**
 * Truncate output to fit token budget
 */
function truncateToFit(output: string, maxTokens: number): string {
  const sections = output.split('\n\n');
  const quickAnswer = sections[0];

  let result = quickAnswer;
  let remainingTokens = maxTokens - estimateTokens(result);

  // Try to add code example
  const codeIndex = sections.findIndex((s) => s.startsWith('```'));
  if (codeIndex > 0) {
    const codeSection = sections[codeIndex];
    const codeTokens = estimateTokens(codeSection);

    if (codeTokens <= remainingTokens) {
      result += '\n\n' + codeSection;
      remainingTokens -= codeTokens;
    }
  }

  // Try to add trust section (trimmed if needed)
  const trustIndex = sections.findIndex((s) => s.startsWith('━'));
  if (trustIndex > 0 && remainingTokens > 50) {
    const trustSection = sections[trustIndex];
    const trustTokens = estimateTokens(trustSection);

    if (trustTokens <= remainingTokens) {
      result += '\n\n' + trustSection;
    } else {
      const trustLines = trustSection.split('\n');
      let trimmed = trustLines[0] + '\n' + trustLines[1] + '\n';

      for (let i = 2; i < trustLines.length - 1; i++) {
        const line = trustLines[i] + '\n';
        if (estimateTokens(trimmed + line) <= remainingTokens - 10) {
          trimmed += line;
        } else {
          break;
        }
      }

      trimmed += trustLines[trustLines.length - 1];
      result += '\n\n' + trimmed;
    }
  }

  return result;
}

/**
 * Format multiple decisions as Google-style search results
 */
function formatTeaserList(decisions: DecisionForFormat[], topN = 3): string | null {
  if (!decisions || decisions.length === 0) {
    return null;
  }

  const topDecisions = decisions.slice(0, topN);
  const count = topDecisions.length;

  let output = `💡 MAMA found ${count} related topic${count > 1 ? 's' : ''}:\n`;

  for (let i = 0; i < topDecisions.length; i++) {
    const d = topDecisions[i];
    const relevance = Math.round((d.similarity || d.confidence || 0) * 100);

    // Preview (max 60 chars)
    const preview = d.decision.length > 60 ? d.decision.substring(0, 60) + '...' : d.decision;

    output += `\n${i + 1}. ${d.topic} (${relevance}% match)`;
    output += `\n   "${preview}"`;

    // Recency metadata (NEW - Gaussian Decay)
    if (d.recency_age_days !== undefined && d.created_at) {
      const timeAgo = calculateDuration(d.created_at);
      const recencyScore = d.recency_score ? Math.round(d.recency_score * 100) : null;
      const finalScore = d.final_score ? Math.round(d.final_score * 100) : null;

      output += `\n   ⏰ ${timeAgo}`;
      if (recencyScore !== null && finalScore !== null) {
        output += ` | Recency: ${recencyScore}% | Final: ${finalScore}%`;
      }
    }

    output += `\n   🔍 mama.recall('${d.topic}')`;

    if (i < topDecisions.length - 1) {
      output += '\n';
    }
  }

  return output;
}

/**
 * Format decision as curiosity-inducing teaser
 */
export function formatTeaser(decision: DecisionForFormat | null): string | null {
  if (!decision) {
    return null;
  }

  const timeAgo = calculateDuration(decision.created_at);

  // Extract preview (first 60 chars)
  const preview =
    decision.decision.length > 60 ? decision.decision.substring(0, 60) + '...' : decision.decision;

  // Extract files from trust_context or show generic
  let files = 'Multiple files';
  const trustCtx =
    typeof decision.trust_context === 'string'
      ? parseTrustContext(decision.trust_context)
      : decision.trust_context;
  if (trustCtx?.source?.file) {
    const fileStr = trustCtx.source.file;
    const fileList = fileStr.split(',').map((f) => f.trim());

    if (fileList.length === 1) {
      files = fileList[0];
    } else if (fileList.length === 2) {
      files = fileList.join(', ');
    } else {
      files = `${fileList[0]}, ${fileList[1]} (+${fileList.length - 2})`;
    }
  }

  const teaser = `
💡 MAMA has related info

📚 Topic: ${decision.topic}
📖 Preview: "${preview}"
📁 Files: ${files}
⏰ Updated: ${timeAgo}

🔍 Read more: mama.recall('${decision.topic}')
  `.trim();

  return teaser;
}

/**
 * Format mama.recall() results in readable format
 */
export function formatRecall(
  decisions: DecisionForFormat[],
  semanticEdges: SemanticEdges | null = null
): string {
  if (!decisions || decisions.length === 0) {
    return '❌ No decisions found';
  }

  // Single decision: full detail
  if (decisions.length === 1) {
    return formatSingleDecision(decisions[0]);
  }

  // Multiple decisions: history view
  return formatDecisionHistory(decisions, semanticEdges);
}

/**
 * Format single decision with full detail
 */
function formatSingleDecision(decision: DecisionForFormat): string {
  const timeAgo = calculateDuration(decision.created_at);
  const confidencePercent = Math.round((decision.confidence || 0) * 100);
  const outcomeEmoji = getOutcomeEmoji(decision.outcome ?? null);
  const outcomeText = decision.outcome || 'Not yet tracked';

  let output = `
📋 Decision: ${decision.topic}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${decision.reasoning || decision.decision}
`.trim();

  // Metadata section
  output += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  output += `\n📊 Confidence: ${confidencePercent}%`;
  output += `\n⏰ Created: ${timeAgo}`;
  output += `\n${outcomeEmoji} Outcome: ${outcomeText}`;

  if (decision.outcome === 'FAILED' && decision.failure_reason) {
    output += `\n⚠️  Failure reason: ${decision.failure_reason}`;
  }

  // Narrative fields section (Story 2.2)
  if (decision.evidence || decision.alternatives || decision.risks) {
    output += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    output += '\n📝 Narrative Details\n';

    if (decision.evidence) {
      const evidenceList = Array.isArray(decision.evidence)
        ? decision.evidence
        : typeof decision.evidence === 'string'
          ? safeParseJson<string[]>(decision.evidence, [decision.evidence])
          : [decision.evidence];
      if (evidenceList.length > 0) {
        output += '\n🔍 Evidence:';
        (evidenceList as string[]).forEach((item, idx) => {
          output += `\n  ${idx + 1}. ${item}`;
        });
      }
    }

    if (decision.alternatives) {
      const altList = Array.isArray(decision.alternatives)
        ? decision.alternatives
        : typeof decision.alternatives === 'string'
          ? safeParseJson<string[]>(decision.alternatives, [decision.alternatives])
          : [decision.alternatives];
      if (altList.length > 0) {
        output += '\n\n🔀 Alternatives Considered:';
        (altList as string[]).forEach((item, idx) => {
          output += `\n  ${idx + 1}. ${item}`;
        });
      }
    }

    if (decision.risks) {
      output += `\n\n⚠️  Risks: ${decision.risks}`;
    }
  }

  // Trust context section (if available)
  const trustCtx =
    typeof decision.trust_context === 'string'
      ? parseTrustContext(decision.trust_context)
      : decision.trust_context;
  if (trustCtx) {
    output += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    output += '\n🔍 Trust Context\n';

    if (trustCtx.source) {
      const { file, line, author } = trustCtx.source;
      output += `\n📍 Source: ${file}${line ? ':' + line : ''} (by ${author || 'unknown'})`;
    }

    if (trustCtx.causality?.impact) {
      output += `\n🔗 Impact: ${trustCtx.causality.impact}`;
    }

    if (trustCtx.verification) {
      const { test_file, result } = trustCtx.verification;
      const status = result === 'success' ? '✅ passed' : `⚠️ ${result}`;
      output += `\n${status}: ${test_file || 'Verified'}`;
    }

    if (trustCtx.track_record) {
      const { success_rate, sample_size } = trustCtx.track_record;
      if (sample_size && sample_size > 0) {
        const rate = Math.round((success_rate || 0) * 100);
        output += `\n📊 Track record: ${rate}% success (${sample_size} samples)`;
      }
    }
  }

  return output;
}

/**
 * Format decision history (multiple decisions)
 */
function formatDecisionHistory(
  decisions: DecisionForFormat[],
  semanticEdges: SemanticEdges | null = null
): string {
  const topic = decisions[0].topic;
  const latest = decisions[0];
  const older = decisions.slice(1);

  let output = `
📋 Decision History: ${topic}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Latest Decision (${calculateDuration(latest.created_at)}):
${latest.decision}
`.trim();

  // Show brief reasoning if available
  if (latest.reasoning) {
    const briefReasoning = latest.reasoning.split('\n')[0].substring(0, 150);
    output += `\n\nReasoning: ${briefReasoning}${latest.reasoning.length > 150 ? '...' : ''}`;
  }

  output += `\n\nConfidence: ${Math.round((latest.confidence || 0) * 100)}%`;

  // Show narrative fields for latest decision (Story 2.2)
  if (latest.evidence || latest.alternatives || latest.risks) {
    if (latest.evidence) {
      const evidenceList = Array.isArray(latest.evidence)
        ? latest.evidence
        : typeof latest.evidence === 'string'
          ? safeParseJson<string[]>(latest.evidence, [latest.evidence])
          : [latest.evidence];
      if (evidenceList.length > 0) {
        output += '\n\n🔍 Evidence:';
        (evidenceList as string[]).slice(0, 3).forEach((item, idx) => {
          output += `\n  ${idx + 1}. ${item}`;
        });
        if (evidenceList.length > 3) {
          output += `\n  ... and ${evidenceList.length - 3} more`;
        }
      }
    }

    if (latest.alternatives) {
      const altList = Array.isArray(latest.alternatives)
        ? latest.alternatives
        : typeof latest.alternatives === 'string'
          ? safeParseJson<string[]>(latest.alternatives, [latest.alternatives])
          : [latest.alternatives];
      if (altList.length > 0) {
        output += '\n\n🔀 Alternatives: ';
        output += (altList as string[]).slice(0, 2).join('; ');
        if (altList.length > 2) {
          output += `... (+${altList.length - 2} more)`;
        }
      }
    }

    if (latest.risks) {
      const risksPreview =
        latest.risks.length > 100 ? latest.risks.substring(0, 100) + '...' : latest.risks;
      output += `\n\n⚠️  Risks: ${risksPreview}`;
    }
  }

  // Show older decisions (supersedes chain)
  if (older.length > 0) {
    output += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    output += `\nPrevious Decisions (${older.length}):\n`;

    for (let i = 0; i < Math.min(older.length, 5); i++) {
      const d = older[i];
      const timeAgo = calculateDuration(d.created_at);
      const emoji = getOutcomeEmoji(d.outcome ?? null);
      output += `\n${i + 2}. ${d.decision} (${timeAgo}) ${emoji}`;

      if (d.outcome === 'FAILED' && d.failure_reason) {
        output += `\n   ⚠️ ${d.failure_reason}`;
      }
    }

    if (older.length > 5) {
      output += `\n\n... and ${older.length - 5} more`;
    }
  }

  // Show semantic edges (related decisions)
  if (semanticEdges) {
    const totalEdges =
      (semanticEdges.refines?.length || 0) +
      (semanticEdges.refined_by?.length || 0) +
      (semanticEdges.contradicts?.length || 0) +
      (semanticEdges.contradicted_by?.length || 0);

    if (totalEdges > 0) {
      output += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
      output += `\n🔗 Related Decisions (${totalEdges}):\n`;

      // Refines (builds upon)
      if (semanticEdges.refines && semanticEdges.refines.length > 0) {
        output += '\n✨ Refines (builds upon):';
        semanticEdges.refines.slice(0, 3).forEach((e) => {
          const preview = e.decision.substring(0, 60);
          output += `\n   • ${e.topic}: ${preview}${e.decision.length > 60 ? '...' : ''}`;
        });
        if (semanticEdges.refines.length > 3) {
          output += `\n   ... and ${semanticEdges.refines.length - 3} more`;
        }
      }

      // Refined by (later improvements)
      if (semanticEdges.refined_by && semanticEdges.refined_by.length > 0) {
        output += '\n\n🔄 Refined by (later improvements):';
        semanticEdges.refined_by.slice(0, 3).forEach((e) => {
          const preview = e.decision.substring(0, 60);
          output += `\n   • ${e.topic}: ${preview}${e.decision.length > 60 ? '...' : ''}`;
        });
        if (semanticEdges.refined_by.length > 3) {
          output += `\n   ... and ${semanticEdges.refined_by.length - 3} more`;
        }
      }

      // Contradicts
      if (semanticEdges.contradicts && semanticEdges.contradicts.length > 0) {
        output += '\n\n⚡ Contradicts:';
        semanticEdges.contradicts.forEach((e) => {
          const preview = e.decision.substring(0, 60);
          output += `\n   • ${e.topic}: ${preview}${e.decision.length > 60 ? '...' : ''}`;
        });
      }

      // Contradicted by
      if (semanticEdges.contradicted_by && semanticEdges.contradicted_by.length > 0) {
        output += '\n\n❌ Contradicted by:';
        semanticEdges.contradicted_by.forEach((e) => {
          const preview = e.decision.substring(0, 60);
          output += `\n   • ${e.topic}: ${preview}${e.decision.length > 60 ? '...' : ''}`;
        });
      }
    }
  }

  output += '\n\n💡 Tip: Review individual decisions for full context';

  return output;
}

/**
 * Parse trust_context (might be JSON string)
 */
function parseTrustContext(trustContext: string | TrustContext | null): TrustContext | null {
  if (!trustContext) {
    return null;
  }

  // Already parsed
  if (typeof trustContext === 'object') {
    return trustContext;
  }

  // Parse JSON string
  if (typeof trustContext === 'string') {
    try {
      return JSON.parse(trustContext) as TrustContext;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Format recent decisions list (all topics, chronological)
 */
export function formatList(decisions: DecisionForFormat[], options: FormatOptions = {}): string {
  const { limit = 20 } = options;

  if (!decisions || decisions.length === 0) {
    return '❌ No decisions found';
  }

  // Limit results
  const items = decisions.slice(0, limit);

  let output = `📋 Recent Decisions (Last ${items.length})\n`;
  output += '━'.repeat(60) + '\n';

  for (let i = 0; i < items.length; i++) {
    const d = items[i];
    const timeAgo = calculateDuration(d.created_at);
    const type = d.user_involvement === 'approved' ? '👤 User' : '🤖 Assistant';
    const status = d.outcome ? getOutcomeEmoji(d.outcome) + ' ' + d.outcome : '⏳ Pending';
    const confidence = Math.round((d.confidence || 0) * 100);

    // Preview (max 60 chars)
    const preview = d.decision.length > 60 ? d.decision.substring(0, 60) + '...' : d.decision;

    output += `\n${i + 1}. [${timeAgo}] ${type}\n`;
    output += `   📚 ${d.topic}\n`;
    output += `   💡 ${preview}\n`;
    output += `   📊 ${confidence}% confidence | ${status}\n`;
  }

  output += '\n' + '━'.repeat(60);
  output += `\n💡 Tip: Use mama.recall('topic') for full details\n`;

  return output;
}
