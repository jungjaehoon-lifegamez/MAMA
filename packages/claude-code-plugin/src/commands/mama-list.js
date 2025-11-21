/**
 * /mama-list Command
 *
 * Story M3.1: MAMA Commands Suite
 * List recent decisions in chronological order
 *
 * Usage:
 *   mamaListCommand({ limit })
 *
 * @module commands/mama-list
 */

const mama = require('../core/mama-api');
const { info, error: logError } = require('../core/debug-logger');

/**
 * List recent decisions
 *
 * @param {Object} args - Command arguments
 * @param {number} [args.limit=20] - Maximum results to return (capped at 100)
 * @returns {Promise<Object>} Command result
 */
async function mamaListCommand(args = {}) {
  try {
    // Parse limit with cap
    let limit = args.limit !== undefined ? parseInt(args.limit, 10) : 20;

    // Cap at 100 for performance
    if (limit > 100) {
      info(`[mama-list] Limit ${limit} exceeds maximum, capping at 100`);
      limit = 100;
    }

    if (limit < 1) {
      limit = 1;
    }

    // Call mama.list() API
    info(`[mama-list] Listing ${limit} recent decisions`);

    const result = await mama.list({ limit });

    if (!result || !result.list || result.list.length === 0) {
      info('[mama-list] No decisions found');

      return {
        success: true,
        list: [],
        message: formatEmptyMessage(),
      };
    }

    info(`[mama-list] Found ${result.list.length} decision(s)`);

    return {
      success: true,
      list: result.list,
      message: formatListMessage(result.list, limit, result.markdown),
    };
  } catch (err) {
    logError(`[mama-list] ❌ Failed to list decisions: ${err.message}`);

    return {
      success: false,
      error: err.message,
      message: formatErrorMessage(err),
    };
  }
}

/**
 * Format list message
 *
 * @param {Array} list - Decision list
 * @param {number} limit - Requested limit
 * @param {string} markdown - Formatted markdown (from mama.list)
 * @returns {string} Formatted message
 */
function formatListMessage(list, limit, markdown) {
  // Use markdown from mama.list if available
  if (markdown) {
    return markdown;
  }

  // Fallback: format manually
  let message = `## 📋 Recent Decisions (Last ${limit})\n\n`;
  message += `Total: ${list.length} decision(s)\n\n`;
  message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

  list.forEach((decision, index) => {
    const type = decision.user_involvement === 'approved' ? '👤 User' : '🤖 Assistant';
    const preview = (decision.decision || 'No decision text').substring(0, 60);
    const confidence = Math.round((decision.confidence || 0.5) * 100);
    const outcome = decision.outcome || 'pending';

    // Format outcome with emoji
    const outcomeEmoji = {
      pending: '⏳',
      success: '✅',
      failure: '❌',
      partial: '⚠️',
      superseded: '🔄'
    }[outcome] || '⏳';

    message += `${index + 1}. **[${decision.created_at || 'Unknown'}]** ${type}\n`;
    message += `   📚 **${decision.topic || 'Unknown topic'}**\n`;
    message += `   💡 ${preview}${preview.length >= 60 ? '...' : ''}\n`;
    message += `   📊 ${confidence}% confidence | ${outcomeEmoji} ${outcome}\n`;
    message += `   🔍 Recall: \`/mama-recall ${decision.topic}\`\n\n`;
  });

  message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
  message += `💡 Tip: Use \`mama.recall('topic')\` for full details\n`;

  return message.trim();
}

/**
 * Format empty message
 *
 * @returns {string} Formatted message
 */
function formatEmptyMessage() {
  return `
## 📋 No Decisions Found

MAMA memory is empty - no decisions saved yet.

### Get Started

Save your first decision:

\`\`\`javascript
mamaSaveCommand({
  topic: 'my_first_decision',
  decision: 'This is my first MAMA decision',
  reasoning: 'Learning how to use MAMA memory system'
})
\`\`\`

### Examples of Useful Decisions to Save

1. **Architecture decisions**
   \`\`\`
   Topic: project_database_choice
   Decision: Use SQLite for local development
   Reasoning: Lightweight, zero-config, sufficient for prototype
   \`\`\`

2. **Bug fixes and lessons learned**
   \`\`\`
   Topic: vitest_import_error
   Decision: Use ES modules for test files, CommonJS for production
   Reasoning: Vitest only supports ES modules, hooks need CommonJS
   \`\`\`

3. **Configuration choices**
   \`\`\`
   Topic: similarity_threshold
   Decision: Use 75% threshold for user prompts, 70% for file context
   Reasoning: User prompts need precision, file context prefers recall
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
  return `
## ❌ Error Listing Decisions

${err.message}

**Tip:** Limit parameter is optional and defaults to 20.

Example:
\`\`\`javascript
mamaListCommand({ limit: 50 })  // List 50 recent decisions
mamaListCommand()  // List 20 recent decisions (default)
\`\`\`

See usage help: \`/mama-list --help\`
`.trim();
}

/**
 * Format usage help
 *
 * @returns {string} Help text
 */
function formatUsageHelp() {
  return `
## /mama-list - List Recent Decisions

List recent decisions in reverse chronological order (most recent first).

### Usage

\`\`\`javascript
mamaListCommand({
  limit: 20  // optional, default: 20, max: 100
})
\`\`\`

### Parameters

- **limit** (number, optional): Maximum number of decisions to return
  - Default: 20
  - Maximum: 100 (automatically capped)
  - Minimum: 1

### Examples

\`\`\`javascript
// List last 20 decisions (default)
mamaListCommand()

// List last 50 decisions
mamaListCommand({ limit: 50 })

// List all recent decisions (up to 100)
mamaListCommand({ limit: 100 })
\`\`\`

### Output Format

Each decision shows:

1. **Index** - Position in list (1, 2, 3, ...)
2. **Timestamp** - When decision was created (relative time)
3. **Type** - 👤 User decision or 🤖 Assistant insight
4. **Topic** - Decision topic name
5. **Preview** - First 60 characters of decision text
6. **Confidence** - Confidence score (0-100%)
7. **Outcome** - Status with emoji:
   - ⏳ pending
   - ✅ success
   - ❌ failure
   - ⚠️ partial
   - 🔄 superseded
8. **Recall command** - Quick link to full details

### Example Output

\`\`\`
📋 Recent Decisions (Last 20)

Total: 12 decision(s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. [0 mins ago] 🤖 Assistant
   📚 mama_single_session_implementation
   💡 Epic M2 implemented entirely in single session - all 5 stori...
   📊 90% confidence | ✅ success
   🔍 Recall: \`/mama-recall mama_single_session_implementation\`

2. [0 mins ago] 🤖 Assistant
   📚 mama_recency_weighting
   💡 Use Gaussian decay (e^(-days/30)) for recency boost with 0.7...
   📊 80% confidence | ✅ success
   🔍 Recall: \`/mama-recall mama_recency_weighting\`

...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 Tip: Use \`mama.recall('topic')\` for full details
\`\`\`

### Use Cases

1. **Browse recent work**
   - See what decisions were made today/this week
   - Quick overview of project context

2. **Find decision to recall**
   - Scan list for interesting topics
   - Use topic name with \`/mama-recall\`

3. **Verify decision was saved**
   - After \`/mama-save\`, check with \`/mama-list\`
   - Confirm decision appears in list

4. **Project onboarding**
   - New team member reviews recent decisions
   - Understand project history and context

### Tips

1. **Limit based on your need**
   - Quick glance: limit 10-20
   - Deep review: limit 50-100
   - Default (20) works for most cases

2. **Combine with search**
   - Use \`/mama-list\` to browse
   - Use \`/mama-suggest\` to search by topic

3. **Review regularly**
   - Start of day: check yesterday's decisions
   - End of sprint: review all sprint decisions

### Performance

- Fast operation: No LLM calls, no embeddings
- Returns in < 200ms
- Sorted by created_at descending (most recent first)

### Related Commands

- \`/mama-recall <topic>\` - Full history for specific topic
- \`/mama-suggest <query>\` - Semantic search
- \`/mama-save\` - Save a new decision

`.trim();
}

module.exports = {
  mamaListCommand,
  formatListMessage,
  formatEmptyMessage,
  formatErrorMessage,
  formatUsageHelp,
};
