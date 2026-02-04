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

const { info } = require('./debug-logger');
const { formatTopNContext } = require('./relevance-scorer');
const { sanitizeForPrompt } = require('./prompt-sanitizer');

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
 * @param {Array<Object>} decisions - Decision chain (sorted by relevance)
 * @param {Object} options - Formatting options
 * @param {number} options.maxTokens - Token budget (default: 500)
 * @param {boolean} options.useTopN - Use top-N selection (default: true for 4+ decisions)
 * @param {number} options.topN - Number of decisions for full detail (default: 3)
 * @returns {string} Formatted context for injection
 */
function formatContext(decisions, options = {}) {
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
 * @param {Array<Object>} decisions - Decision chain (sorted by relevance)
 * @param {Object} options - Formatting options
 * @param {number} options.maxTokens - Token budget (default: 500)
 * @param {boolean} options.useTopN - Use top-N selection (default: true for 4+ decisions)
 * @param {number} options.topN - Number of decisions for full detail (default: 3)
 * @returns {string} Formatted context (legacy format)
 */
function formatLegacyContext(decisions, options = {}) {
  if (!decisions || decisions.length === 0) {
    return null;
  }

  const { maxTokens = 500, useTopN = decisions.length >= 4, topN = 3 } = options;

  // Task 8.1: Use top-N selection for 4+ decisions (AC #5)
  let context;

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
 * @param {Array<Object>} decisions - All decisions (sorted by relevance)
 * @param {number} topN - Number of decisions for full detail
 * @returns {string} Formatted context
 */
function formatWithTopN(decisions, topN) {
  // Use formatTopNContext from relevance-scorer.js
  const { full, summary } = formatTopNContext(decisions, topN);

  const current = full[0]; // Highest relevance
  const topic = sanitizeForPrompt(current.topic);

  // Task 8.2: Full detail for top 3 decisions
  let context = `
🧠 DECISION HISTORY: ${topic}

Top ${full.length} Most Relevant Decisions:
`.trim();

  for (let i = 0; i < full.length; i++) {
    const d = full[i];
    const duration = calculateDuration(d.created_at);
    const outcomeEmoji = getOutcomeEmoji(d.outcome);
    const relevancePercent = Math.round((d.relevanceScore || 0) * 100);

    context += `\n\n${i + 1}. ${sanitizeForPrompt(d.decision)} (${duration}, relevance: ${relevancePercent}%) ${outcomeEmoji}`;
    context += `\n   Reasoning: ${sanitizeForPrompt(d.reasoning || 'N/A')}`;

    if (d.outcome === 'FAILED') {
      context += `\n   ⚠️ Failure: ${sanitizeForPrompt(d.failure_reason || 'Unknown reason')}`;
    }
  }

  // Task 8.3: Summary for rest (count, duration, key failures only)
  if (summary && summary.count > 0) {
    context += `\n\n━━━━━━━━━━━━━━━━━━━━━━━`;
    context += `\nHistory: ${summary.count} additional decisions over ${summary.duration_days} days`;

    if (summary.failures && summary.failures.length > 0) {
      context += `\n\n⚠️ Other Failures:`;
      for (const failure of summary.failures) {
        context += `\n- ${sanitizeForPrompt(failure.decision)}: ${sanitizeForPrompt(failure.reason || 'Unknown')}`;
      }
    }
  }

  return context;
}

/**
 * Format small decision history (3 or fewer)
 *
 * @param {Object} current - Current decision
 * @param {Array<Object>} history - Previous decisions
 * @returns {string} Formatted context
 */
function formatSmallHistory(current, history) {
  const duration = calculateDuration(current.created_at);

  let context = `
🧠 DECISION HISTORY: ${sanitizeForPrompt(current.topic)}

Current: ${sanitizeForPrompt(current.decision)} (${duration}, confidence: ${current.confidence})
Reasoning: ${sanitizeForPrompt(current.reasoning || 'N/A')}
`.trim();

  // Add history details
  if (history.length > 0) {
    context += '\n\nPrevious Decisions:\n';

    for (const decision of history) {
      const durationDays = calculateDurationDays(
        decision.created_at,
        decision.updated_at || Date.now()
      );
      const outcomeEmoji = getOutcomeEmoji(decision.outcome);

      context += `- ${sanitizeForPrompt(decision.decision)} (${durationDays} days) ${outcomeEmoji}\n`;

      if (decision.outcome === 'FAILED') {
        context += `  Reason: ${sanitizeForPrompt(decision.failure_reason || 'Unknown')}\n`;
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
 *
 * @param {Object} current - Current decision
 * @param {Array<Object>} history - Previous decisions
 * @returns {string} Formatted context with rolling summary
 */
function formatLargeHistory(current, history) {
  // Include current decision in total duration calculation
  const allDecisions = [current, ...history];
  const totalDuration = calculateTotalDuration(allDecisions);

  // Extract failures
  const failures = history.filter((d) => d.outcome === 'FAILED');
  const topFailures = failures.slice(0, 3);

  // Get last evolution
  const lastEvolution = history.length > 0 ? history[0] : null;

  let context = `
🧠 DECISION HISTORY: ${sanitizeForPrompt(current.topic)}

Current: ${sanitizeForPrompt(current.decision)} (confidence: ${current.confidence})
Reasoning: ${sanitizeForPrompt(current.reasoning || 'N/A')}

History: ${history.length + 1} decisions over ${totalDuration}
`.trim();

  // Add key failures
  if (topFailures.length > 0) {
    context += '\n\n⚠️ Key Failures (avoid these):\n';

    for (const failure of topFailures) {
      context += `- ${sanitizeForPrompt(failure.decision)}: ${sanitizeForPrompt(failure.failure_reason || 'Unknown reason')}\n`;
    }
  }

  // Add last evolution
  if (lastEvolution) {
    context += `\nLast evolution: ${sanitizeForPrompt(lastEvolution.decision)} → ${sanitizeForPrompt(current.decision)}`;

    if (current.reasoning) {
      const reasonSummary = sanitizeForPrompt(current.reasoning.substring(0, 100));
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
 *
 * @param {string} text - Context text
 * @param {number} maxTokens - Maximum tokens allowed
 * @returns {string} Truncated text if needed
 */
function ensureTokenBudget(text, maxTokens) {
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
 *
 * @param {string} text - Text to estimate
 * @returns {number} Estimated token count
 */
function estimateTokens(text) {
  // Task 6.4: ~1 token per 4 characters
  return Math.ceil(text.length / 4);
}

/**
 * Calculate human-readable duration
 *
 * @param {number|string} timestamp - Unix timestamp (ms) or ISO 8601 string
 * @returns {string} Human-readable duration (e.g., "3 days ago")
 */
function calculateDuration(timestamp) {
  // Handle Unix timestamp (number or numeric string) and ISO 8601 string
  let ts;
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
 * Calculate duration between two timestamps
 *
 * @param {number|string} start - Start timestamp (ms) or ISO 8601 string
 * @param {number|string} end - End timestamp (ms) or ISO 8601 string
 * @returns {number} Duration in days
 */
function calculateDurationDays(start, end) {
  // Handle Unix timestamp (number or numeric string) and ISO 8601 string
  let startTs, endTs;

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
 *
 * @param {Array<Object>} history - Decision history
 * @returns {string} Human-readable total duration
 */
function calculateTotalDuration(history) {
  if (history.length === 0) {
    return 'N/A';
  }

  // Convert all timestamps to numbers for comparison
  const timestamps = history
    .map((d) => {
      const created = typeof d.created_at === 'string' ? Date.parse(d.created_at) : d.created_at;
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
 *
 * @param {string} outcome - Decision outcome
 * @returns {string} Emoji representation
 */
function getOutcomeEmoji(outcome) {
  const emojiMap = {
    SUCCESS: '✅',
    FAILED: '❌',
    PARTIAL: '⚠️',
    ONGOING: '⏳',
  };

  return emojiMap[outcome] || '';
}

/**
 * Format context in Claude-friendly Instant Answer format
 *
 * Story 014.7.10: Claude-Friendly Context Formatting
 * AC #1: Instant Answer format with trust components
 *
 * Prioritizes:
 * 1. Quick answer (one line)
 * 2. Code example (if available)
 * 3. Trust evidence (5 components)
 * 4. Minimal reasoning (< 150 chars)
 *
 * @param {Object} decision - Decision object
 * @param {Object} options - Formatting options
 * @param {number} options.maxTokens - Token budget (default: 500)
 * @returns {string|null} Formatted instant answer or null
 */
function formatInstantAnswer(decision, options = {}) {
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
  const trustSection = formatTrustContext(decision.trust_context);

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
 *
 * Returns first line or sentence from decision field
 *
 * @param {Object} decision - Decision object
 * @returns {string|null} Quick answer or null
 */
function extractQuickAnswer(decision) {
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
  // Match period/exclamation/question mark followed by space and capital letter
  const sentenceMatch = firstLine.match(/^.+?[.!?](?=\s+[A-Z])/);
  if (sentenceMatch) {
    // Multiple sentences detected - return first sentence
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
 *
 * Looks for markdown code blocks (```...```)
 *
 * @param {Object} decision - Decision object
 * @returns {string|null} Code example or null
 */
function extractCodeExample(decision) {
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
      // Wrap in code block
      return `\`\`\`javascript\n${decision.decision}\n\`\`\``;
    }
  }

  return null;
}

/**
 * Format trust context section
 *
 * Story 014.7.10 AC #2: Trust Context display
 *
 * Shows 5 trust components:
 * 1. Source transparency
 * 2. Causality
 * 3. Verifiability
 * 4. Context relevance
 * 5. Track record
 *
 * @param {Object} trustCtx - Trust context object
 * @returns {string|null} Formatted trust section or null
 */
function formatTrustContext(trustCtx) {
  if (!trustCtx) {
    return null;
  }

  const lines = ['━'.repeat(40), '🔍 WHY TRUST THIS?', ''];

  let hasContent = false;

  // 1. Source transparency
  if (trustCtx.source) {
    const { file, line, author, timestamp } = trustCtx.source;
    const timeAgo = calculateDuration(timestamp);
    lines.push(
      `📍 Source: ${sanitizeForPrompt(file)}:${line} (${timeAgo}, by ${sanitizeForPrompt(author)})`
    );
    hasContent = true;
  }

  // 2. Causality
  if (trustCtx.causality && trustCtx.causality.impact) {
    lines.push(`🔗 Reason: ${sanitizeForPrompt(trustCtx.causality.impact)}`);
    hasContent = true;
  }

  // 3. Verifiability
  if (trustCtx.verification) {
    const { test_file, result } = trustCtx.verification;
    const status = result === 'success' ? 'passed' : sanitizeForPrompt(result);
    lines.push(`✅ Verified: ${sanitizeForPrompt(test_file || 'Verified')} ${status}`);
    hasContent = true;
  }

  // 4. Context relevance
  if (trustCtx.context_match && trustCtx.context_match.user_intent) {
    lines.push(`🎯 Applies to: ${sanitizeForPrompt(trustCtx.context_match.user_intent)}`);
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
 *
 * Prioritizes:
 * 1. Keep quick answer (always)
 * 2. Keep code example (if fits)
 * 3. Trim trust section (if needed)
 *
 * @param {string} output - Full output
 * @param {number} maxTokens - Maximum tokens
 * @returns {string} Truncated output
 */
function truncateToFit(output, maxTokens) {
  // Split sections
  const sections = output.split('\n\n');
  const quickAnswer = sections[0]; // "⚡ INSTANT ANSWER\n\n[answer]"

  // Always keep quick answer
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
      // Trim trust section to fit
      const trustLines = trustSection.split('\n');
      let trimmed = trustLines[0] + '\n' + trustLines[1] + '\n'; // Header

      for (let i = 2; i < trustLines.length - 1; i++) {
        const line = trustLines[i] + '\n';
        if (estimateTokens(trimmed + line) <= remainingTokens - 10) {
          trimmed += line;
        } else {
          break;
        }
      }

      trimmed += trustLines[trustLines.length - 1]; // Footer
      result += '\n\n' + trimmed;
    }
  }

  return result;
}

/**
 * Format multiple decisions as Google-style search results
 *
 * Shows top N results with relevance scores, allowing user to choose
 * Story: Google-style teaser list for better UX
 *
 * @param {Array<Object>} decisions - Decision objects (sorted by relevance)
 * @param {number} topN - Number of results to show (default: 3)
 * @returns {string|null} Formatted teaser list or null
 */
function formatTeaserList(decisions, topN = 3) {
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

    output += `\n${i + 1}. ${sanitizeForPrompt(d.topic)} (${relevance}% match)`;
    output += `\n   "${sanitizeForPrompt(preview)}"`;

    // Recency metadata (NEW - Gaussian Decay)
    // Shows age and recency impact to help Claude adjust parameters
    if (d.recency_age_days !== undefined && d.created_at) {
      const timeAgo = calculateDuration(d.created_at); // Use human-readable time (mins/hours/days)
      const recencyScore = d.recency_score ? Math.round(d.recency_score * 100) : null;
      const finalScore = d.final_score ? Math.round(d.final_score * 100) : null;

      output += `\n   ⏰ ${timeAgo}`;
      if (recencyScore !== null && finalScore !== null) {
        output += ` | Recency: ${recencyScore}% | Final: ${finalScore}%`;
      }
    }

    output += `\n   🔍 mama.recall(${JSON.stringify(d.topic)})`;

    if (i < topDecisions.length - 1) {
      output += '\n';
    }
  }

  return output;
}

/**
 * Format decision as curiosity-inducing teaser
 *
 * MAMA = Librarian: Shows book preview, Claude decides to read
 * "Just enough context to spark curiosity" - makes Claude want to learn more
 *
 * @param {Object} decision - Decision object
 * @returns {string|null} Formatted teaser or null
 */
function formatTeaser(decision) {
  if (!decision) {
    return null;
  }

  const timeAgo = calculateDuration(decision.created_at);

  // Extract preview (first 60 chars)
  const preview =
    decision.decision.length > 60 ? decision.decision.substring(0, 60) + '...' : decision.decision;

  // Extract files from trust_context or show generic
  let files = 'Multiple files';
  if (decision.trust_context?.source?.file) {
    const fileStr = decision.trust_context.source.file;
    const fileList = fileStr.split(',').map((f) => f.trim());

    if (fileList.length === 1) {
      files = fileList[0];
    } else if (fileList.length === 2) {
      files = fileList.join(', ');
    } else {
      files = `${fileList[0]}, ${fileList[1]} (+${fileList.length - 2})`;
    }
  }

  // Build teaser
  const teaser = `
💡 MAMA has related info

📚 Topic: ${sanitizeForPrompt(decision.topic)}
📖 Preview: "${sanitizeForPrompt(preview)}"
📁 Files: ${files}
⏰ Updated: ${timeAgo}

🔍 Read more: mama.recall(${JSON.stringify(decision.topic)})
  `.trim();

  return teaser;
}

/**
 * Format mama.recall() results in readable format
 *
 * Transforms raw JSON into readable markdown with:
 * - Properly formatted reasoning (markdown preserved)
 * - Parsed trust_context (not JSON string)
 * - Clean metadata display
 *
 * @param {Array<Object>} decisions - Decision history from recall()
 * @returns {string} Formatted output for human reading
 */
function formatRecall(decisions, semanticEdges = null) {
  if (!decisions || decisions.length === 0) {
    return '❌ No decisions found';
  }

  // Single decision: full detail
  if (decisions.length === 1) {
    return formatSingleDecision(decisions[0], semanticEdges);
  }

  // Multiple decisions: history view
  return formatDecisionHistory(decisions, semanticEdges);
}

/**
 * Format single decision with full detail
 *
 * @param {Object} decision - Single decision object
 * @returns {string} Formatted decision
 */
function formatSingleDecision(decision) {
  const timeAgo = calculateDuration(decision.created_at);
  const confidencePercent = Math.round((decision.confidence || 0) * 100);
  const outcomeEmoji = getOutcomeEmoji(decision.outcome);
  const outcomeText = decision.outcome || 'Not yet tracked';

  let output = `
📋 Decision: ${sanitizeForPrompt(decision.topic)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${sanitizeForPrompt(decision.reasoning || decision.decision)}
`.trim();

  // Metadata section
  output += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  output += `\n📊 Confidence: ${confidencePercent}%`;
  output += `\n⏰ Created: ${timeAgo}`;
  output += `\n${outcomeEmoji} Outcome: ${outcomeText}`;

  if (decision.outcome === 'FAILED' && decision.failure_reason) {
    output += `\n⚠️  Failure reason: ${sanitizeForPrompt(decision.failure_reason)}`;
  }

  // Trust context section (if available)
  const trustCtx = parseTrustContext(decision.trust_context);
  if (trustCtx) {
    output += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    output += '\n🔍 Trust Context\n';

    if (trustCtx.source) {
      const { file, line, author } = trustCtx.source;
      output += `\n📍 Source: ${sanitizeForPrompt(file)}${line ? ':' + line : ''} (by ${sanitizeForPrompt(author || 'unknown')})`;
    }

    if (trustCtx.causality?.impact) {
      output += `\n🔗 Impact: ${sanitizeForPrompt(trustCtx.causality.impact)}`;
    }

    if (trustCtx.verification) {
      const { test_file, result } = trustCtx.verification;
      const safeResult = sanitizeForPrompt(result);
      const status = result === 'success' ? '✅ passed' : `⚠️ ${safeResult}`;
      output += `\n${status}: ${sanitizeForPrompt(test_file || 'Verified')}`;
    }

    if (trustCtx.track_record) {
      const { success_rate, sample_size } = trustCtx.track_record;
      if (sample_size > 0) {
        const rate = Math.round(success_rate * 100);
        output += `\n📊 Track record: ${rate}% success (${sample_size} samples)`;
      }
    }
  }

  return output;
}

/**
 * Format decision history (multiple decisions)
 *
 * @param {Array<Object>} decisions - Decision array
 * @param {Object} [semanticEdges] - Semantic edges { refines, refined_by, contradicts, contradicted_by }
 * @returns {string} Formatted history
 */
function formatDecisionHistory(decisions, semanticEdges = null) {
  const topic = decisions[0].topic;
  const latest = decisions[0];
  const older = decisions.slice(1);

  let output = `
📋 Decision History: ${sanitizeForPrompt(topic)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Latest Decision (${calculateDuration(latest.created_at)}):
${sanitizeForPrompt(latest.decision)}
`.trim();

  // Show brief reasoning if available
  if (latest.reasoning) {
    const briefReasoning = latest.reasoning.split('\n')[0].substring(0, 150);
    output += `\n\nReasoning: ${sanitizeForPrompt(briefReasoning)}${latest.reasoning.length > 150 ? '...' : ''}`;
  }

  output += `\n\nConfidence: ${Math.round(latest.confidence * 100)}%`;

  // Show older decisions (supersedes chain)
  if (older.length > 0) {
    output += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    output += `\nPrevious Decisions (${older.length}):\n`;

    for (let i = 0; i < Math.min(older.length, 5); i++) {
      const d = older[i];
      const timeAgo = calculateDuration(d.created_at);
      const emoji = getOutcomeEmoji(d.outcome);
      output += `\n${i + 2}. ${sanitizeForPrompt(d.decision)} (${timeAgo}) ${emoji}`;

      if (d.outcome === 'FAILED' && d.failure_reason) {
        output += `\n   ⚠️ ${sanitizeForPrompt(d.failure_reason)}`;
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
          output += `\n   • ${sanitizeForPrompt(e.topic)}: ${sanitizeForPrompt(preview)}${e.decision.length > 60 ? '...' : ''}`;
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
          output += `\n   • ${sanitizeForPrompt(e.topic)}: ${sanitizeForPrompt(preview)}${e.decision.length > 60 ? '...' : ''}`;
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
          output += `\n   • ${sanitizeForPrompt(e.topic)}: ${sanitizeForPrompt(preview)}${e.decision.length > 60 ? '...' : ''}`;
        });
      }

      // Contradicted by
      if (semanticEdges.contradicted_by && semanticEdges.contradicted_by.length > 0) {
        output += '\n\n❌ Contradicted by:';
        semanticEdges.contradicted_by.forEach((e) => {
          const preview = e.decision.substring(0, 60);
          output += `\n   • ${sanitizeForPrompt(e.topic)}: ${sanitizeForPrompt(preview)}${e.decision.length > 60 ? '...' : ''}`;
        });
      }
    }
  }

  output += '\n\n💡 Tip: Review individual decisions for full context';

  return output;
}

/**
 * Parse trust_context (might be JSON string)
 *
 * @param {Object|string} trustContext - Trust context (object or JSON string)
 * @returns {Object|null} Parsed trust context
 */
function parseTrustContext(trustContext) {
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
      return JSON.parse(trustContext);
    } catch (e) {
      return null;
    }
  }

  return null;
}

/**
 * Format recent decisions list (all topics, chronological)
 *
 * Readable format for Claude - no raw JSON
 * Shows: time, type (user/assistant), topic, preview, confidence, status
 *
 * @param {Array<Object>} decisions - Recent decisions (sorted by created_at DESC)
 * @param {Object} options - Formatting options
 * @param {number} options.limit - Max decisions to show (default: 20)
 * @returns {string} Formatted list
 */
function formatList(decisions, options = {}) {
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
    output += `   📚 ${sanitizeForPrompt(d.topic)}\n`;
    output += `   💡 ${sanitizeForPrompt(preview)}\n`;
    output += `   📊 ${confidence}% confidence | ${status}\n`;
  }

  output += '\n' + '━'.repeat(60);
  output += `\n💡 Tip: Use mama.recall('topic') for full details\n`;

  return output;
}

// Export API
module.exports = {
  formatContext,
  formatInstantAnswer,
  formatLegacyContext,
  formatTeaser,
  formatRecall,
  formatList,
  ensureTokenBudget,
  estimateTokens,
  extractQuickAnswer,
  extractCodeExample,
  formatTrustContext,
};

// CLI execution for testing
if (require.main === module) {
  info('🧠 MAMA Decision Formatter - Test\n');

  // Task 6.6: Test token budget enforcement
  const mockDecisions = [
    {
      id: 'decision_mesh_structure_003',
      topic: 'mesh_structure',
      decision: 'MODERATE',
      reasoning: 'Balance between performance and completeness',
      confidence: 0.8,
      outcome: null,
      created_at: Date.now() - 5 * 24 * 60 * 60 * 1000, // 5 days ago
    },
    {
      id: 'decision_mesh_structure_002',
      topic: 'mesh_structure',
      decision: 'SIMPLE',
      reasoning: 'Learned from 001 performance failure',
      confidence: 0.6,
      outcome: 'PARTIAL',
      limitation: 'Missing layer information',
      created_at: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
      updated_at: Date.now() - 5 * 24 * 60 * 60 * 1000,
    },
    {
      id: 'decision_mesh_structure_001',
      topic: 'mesh_structure',
      decision: 'COMPLEX',
      reasoning: 'Initial choice for flexibility',
      confidence: 0.5,
      outcome: 'FAILED',
      failure_reason: 'Performance bottleneck at 10K+ meshes',
      created_at: Date.now() - 15 * 24 * 60 * 60 * 1000, // 15 days ago
      updated_at: Date.now() - 10 * 24 * 60 * 60 * 1000,
    },
  ];

  info('📋 Test 1: Format small history (3 decisions)...');
  const context1 = formatContext(mockDecisions.slice(0, 3), { maxTokens: 500 });
  info(context1);
  info(`\nTokens: ${estimateTokens(context1)}/500\n`);

  info('═══════════════════════════');
  info('📋 Test 2: Format large history (10+ decisions)...');

  // Generate large history
  const largeHistory = [mockDecisions[0]];
  for (let i = 1; i <= 10; i++) {
    largeHistory.push({
      ...mockDecisions[1],
      id: `decision_mesh_structure_${String(i).padStart(3, '0')}`,
      created_at: Date.now() - i * 5 * 24 * 60 * 60 * 1000,
    });
  }

  const context2 = formatContext(largeHistory, { maxTokens: 500 });
  info(context2);
  info(`\nTokens: ${estimateTokens(context2)}/500\n`);

  info('═══════════════════════════');
  info('📋 Test 3: Token budget enforcement (truncation)...');

  // Create very long context
  const longDecisions = largeHistory.concat(largeHistory);
  const context3 = formatContext(longDecisions, { maxTokens: 300 });
  info(context3);
  info(`\nTokens: ${estimateTokens(context3)}/300 (enforced)\n`);

  info('═══════════════════════════');
  info('✅ Decision formatter tests complete');
  info('═══════════════════════════');
}
