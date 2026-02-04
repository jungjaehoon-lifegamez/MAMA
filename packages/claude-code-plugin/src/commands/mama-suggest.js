/**
 * /mama-suggest Command
 *
 * Story M3.1: MAMA Commands Suite
 * Search decisions by semantic similarity
 *
 * Usage:
 *   mamaSuggestCommand({ query, limit, recencyWeight })
 *
 * @module commands/mama-suggest
 */

const mama = require('../core/mama-api');
const { info, error: logError } = require('../core/debug-logger');
const { sanitizeForPrompt } = require('../core/prompt-sanitizer');

/**
 * Search decisions by semantic similarity
 *
 * @param {Object} args - Command arguments
 * @param {string} args.query - Search query (required)
 * @param {number} [args.limit=5] - Maximum results to return
 * @param {number} [args.recencyWeight=0.3] - Recency weight 0.0-1.0
 * @returns {Promise<Object>} Command result
 */
async function mamaSuggestCommand(args = {}) {
  try {
    // Validate required fields
    if (!args.query) {
      return {
        success: false,
        message: formatUsageHelp(),
      };
    }

    // Parse options
    const limit = args.limit !== undefined ? parseInt(args.limit, 10) : 5;
    const recencyWeight = args.recencyWeight !== undefined ? parseFloat(args.recencyWeight) : 0.3;

    // Call mama.suggest() API
    info(`[mama-suggest] Searching for: "${args.query}"`);

    const result = await mama.suggest(args.query, {
      limit,
      recencyWeight,
    });

    if (!result || !result.suggestions || result.suggestions.length === 0) {
      info(`[mama-suggest] No suggestions found for query: ${args.query}`);

      return {
        success: true,
        suggestions: [],
        message: formatNoResultsMessage(args.query),
      };
    }

    info(`[mama-suggest] Found ${result.suggestions.length} suggestion(s)`);

    return {
      success: true,
      suggestions: result.suggestions,
      message: formatSuggestionsMessage(args.query, result.suggestions, result.markdown),
    };
  } catch (err) {
    logError(`[mama-suggest] ❌ Failed to search decisions: ${err.message}`);

    return {
      success: false,
      error: err.message,
      message: formatErrorMessage(err),
    };
  }
}

/**
 * Format suggestions message
 *
 * @param {string} query - Search query
 * @param {Array} suggestions - Suggested decisions
 * @param {string} markdown - Formatted markdown (from mama.suggest)
 * @returns {string} Formatted message
 */
function formatSuggestionsMessage(query, suggestions, markdown) {
  // Use markdown from mama.suggest if available
  if (markdown) {
    return markdown;
  }

  // Fallback: format manually
  let message = `## 🔍 Search Results: "${sanitizeForPrompt(query)}"\n\n`;
  message += `Found ${suggestions.length} related decision(s)\n\n`;
  message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

  suggestions.forEach((suggestion, index) => {
    const similarity = Math.round((suggestion.similarity || 0) * 100);
    const recency = suggestion.recency_info || '';
    const safeTopic = sanitizeForPrompt(suggestion.topic || 'Unknown topic');

    message += `### ${index + 1}. ${safeTopic} (${similarity}% match)\n\n`;
    message += `**Decision:** ${sanitizeForPrompt(suggestion.decision || 'No decision text')}\n\n`;
    message += `**Reasoning:** ${sanitizeForPrompt((suggestion.reasoning || 'No reasoning').substring(0, 200))}...\n\n`;
    message += `**Created:** ${suggestion.created_at || 'Unknown'}`;

    if (recency) {
      message += ` (${recency})`;
    }

    message += `\n**Confidence:** ${suggestion.confidence || 0.5}\n`;
    message += `**Outcome:** ${suggestion.outcome || 'pending'}\n\n`;
    message += `🔍 Recall full history: \`/mama-recall ${safeTopic}\`\n\n`;
    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  });

  return message.trim();
}

/**
 * Format no results message
 *
 * @param {string} query - Search query
 * @returns {string} Formatted message
 */
function formatNoResultsMessage(query) {
  return `
## 🔍 No Results Found

No decisions found matching: "${query}"

### Possible Reasons

1. **No decisions saved yet** - Save your first decision with \`/mama-save\`
2. **Query too specific** - Try broader search terms
3. **Embeddings not loaded** - MAMA may be in Tier 2 or 3

### Suggestions

1. Try broader search:
   - Instead of: "JWT authentication with refresh tokens"
   - Try: "authentication"

2. List all recent decisions:
   \`\`\`
   /mama-list 20
   \`\`\`

3. Check MAMA tier status:
   \`\`\`
   /mama-configure --show
   \`\`\`

4. Save a new decision:
   \`\`\`
   /mama-save
   \`\`\`
`.trim();
}

/**
 * Format error message
 *
 * @param {Error} err - Error object
 * @returns {string} Formatted message
 */
function formatErrorMessage(err) {
  let message = `## ❌ Error Searching Decisions\n\n${err.message}\n\n`;

  if (err.message.includes('Tier 2') || err.message.includes('Tier 3')) {
    message += '**Tip:** MAMA is running in degraded mode. Semantic search requires Tier 1.\n\n';
    message += 'Check tier status: `/mama-configure --show`\n';
  } else if (err.message.includes('query')) {
    message += '**Tip:** Query parameter is required.\n\n';
    message += 'Example: `mamaSuggestCommand({ query: "authentication" })`\n';
  }

  message += '\nSee usage help: `/mama-suggest --help`';

  return message.trim();
}

/**
 * Format usage help
 *
 * @returns {string} Help text
 */
function formatUsageHelp() {
  return `
## /mama-suggest - Semantic Search

Search decisions by semantic similarity using natural language queries.

### Usage

\`\`\`javascript
mamaSuggestCommand({
  query: 'search query',  // required
  limit: 5,  // optional, default: 5
  recencyWeight: 0.3  // optional, 0.0-1.0, default: 0.3
})
\`\`\`

### Parameters

- **query** (string, required): Natural language search query
  - Can be a question, keyword, or description
  - Supports multilingual queries (English, Korean, etc.)
  - Examples: "How do I handle authentication?", "mesh count", "performance optimization"

- **limit** (number, optional): Maximum results to return
  - Default: 5
  - Range: 1-20 (capped for performance)

- **recencyWeight** (number, optional): How much to weight recent decisions
  - Default: 0.3 (70% semantic similarity, 30% recency)
  - Range: 0.0-1.0
  - 0.0 = pure semantic similarity (ignore recency)
  - 1.0 = pure recency (ignore semantics) - not recommended

### How Semantic Search Works

MAMA uses **vector embeddings** to understand the meaning of your query:

1. **Query embedding**: Your query is converted to a 384-dimensional vector
2. **Similarity search**: Vector database finds most similar decision embeddings
3. **Recency boost**: Recent decisions get slight boost (configurable)
4. **Final ranking**: Combined score = similarity × (1 - recencyWeight) + recency × recencyWeight

### Examples

\`\`\`javascript
// Simple search
mamaSuggestCommand({ query: 'authentication' })
// Finds: auth_strategy, jwt_implementation, session_management, etc.

// Search with more results
mamaSuggestCommand({
  query: 'How should I structure my database?',
  limit: 10
})

// Search prioritizing recency
mamaSuggestCommand({
  query: 'test strategy',
  recencyWeight: 0.5  // 50% semantic, 50% recency
})

// Performance query
mamaSuggestCommand({ query: 'performance optimization methods' })
// Finds: performance_budget, mama_performance_budget, optimization_strategy, etc.
\`\`\`

### Understanding Results

Each result includes:

- **Topic**: Decision topic name
- **Similarity %**: How well the decision matches your query (0-100%)
- **Decision**: What was decided
- **Reasoning**: Why this decision was made (truncated preview)
- **Created**: Timestamp (relative time)
- **Confidence**: How confident the original decision was
- **Outcome**: Current status (pending/success/failure)

### Similarity Score Guide

- **90-100%**: Exact or near-exact match
- **70-89%**: Highly relevant, strong semantic overlap
- **50-69%**: Moderately relevant, some conceptual overlap
- **30-49%**: Weakly relevant, tangential connection
- **0-29%**: Likely irrelevant

### Tips

1. **Natural language works best**
   - ✅ Good: "How do I prevent hooks from running too long?"
   - ✅ Good: "authentication strategy"
   - ❌ Avoid: "auth JWT OAuth" (keyword stuffing)

2. **Multilingual support**
   - English and Korean queries work equally well
   - Semantic similarity works across languages

3. **Adjust recency weight based on your need**
   - Recent context (today's work): Use 0.5
   - Historical lessons (project patterns): Use 0.1-0.2
   - Default 0.3 works well for most cases

4. **If no results found**
   - Try broader terms
   - Check if any decisions exist: \`/mama-list\`
   - Verify MAMA is in Tier 1: \`/mama-configure --show\`

### Tier Requirements

- **Tier 1**: Full semantic search with embeddings ✅
- **Tier 2**: Keyword fallback only (degraded accuracy)
- **Tier 3**: Search disabled

Check tier status: \`/mama-configure --show\`

### Related Commands

- \`/mama-recall <topic>\` - Recall exact topic (if you know topic name)
- \`/mama-list [limit]\` - Browse recent decisions
- \`/mama-save\` - Save a new decision

`.trim();
}

module.exports = {
  mamaSuggestCommand,
  formatSuggestionsMessage,
  formatNoResultsMessage,
  formatErrorMessage,
  formatUsageHelp,
};
