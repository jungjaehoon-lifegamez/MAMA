/**
 * /mama-recall Command
 *
 * Story M3.1: MAMA Commands Suite
 * Recall full decision history for a specific topic
 *
 * Usage:
 *   mamaRecallCommand({ topic })
 *
 * @module commands/mama-recall
 */

const mama = require('../core/mama-api');
const { info, error: logError } = require('../core/debug-logger');
const { sanitizeForPrompt } = require('../core/prompt-sanitizer');

/**
 * Recall decision history for a topic
 *
 * @param {Object} args - Command arguments
 * @param {string} args.topic - Decision topic to recall (required)
 * @returns {Promise<Object>} Command result
 */
async function mamaRecallCommand(args = {}) {
  try {
    // Validate required fields
    if (!args.topic) {
      return {
        success: false,
        message: formatUsageHelp(),
      };
    }

    // Call mama.recall() API
    info(`[mama-recall] Recalling decisions for topic: ${args.topic}`);

    const result = await mama.recall(args.topic);

    // Map supersedes_chain to history for backward compatibility
    const history = result.supersedes_chain || [];

    if (!history || history.length === 0) {
      info(`[mama-recall] No decisions found for topic: ${args.topic}`);

      return {
        success: true,
        history: [],
        message: formatNotFoundMessage(args.topic),
      };
    }

    info(`[mama-recall] Found ${history.length} decision(s) for topic: ${args.topic}`);

    return {
      success: true,
      history: history,
      message: formatHistoryMessage(args.topic, history, result.markdown),
    };
  } catch (err) {
    logError(`[mama-recall] ❌ Failed to recall decisions: ${err.message}`);

    return {
      success: false,
      error: err.message,
      message: formatErrorMessage(err),
    };
  }
}

/**
 * Format history message
 *
 * @param {string} topic - Topic
 * @param {Array} history - Decision history
 * @param {string} markdown - Formatted markdown (from mama.recall)
 * @returns {string} Formatted message
 */
function formatHistoryMessage(topic, history, markdown) {
  // Use markdown from mama.recall if available
  if (markdown) {
    return markdown;
  }

  // Fallback: format manually
  let message = `## 📋 Decision History: ${sanitizeForPrompt(topic)}\n\n`;
  message += `Found ${history.length} decision(s)\n\n`;
  message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

  history.forEach((decision, index) => {
    message += `### ${index + 1}. ${sanitizeForPrompt(decision.decision || 'No decision text')}\n\n`;
    message += `**Reasoning:** ${sanitizeForPrompt(decision.reasoning || 'No reasoning provided')}\n\n`;
    message += `**Created:** ${decision.created_at || 'Unknown'}\n`;
    message += `**Confidence:** ${decision.confidence || 0.5}\n`;
    message += `**Outcome:** ${decision.outcome || 'pending'}\n`;

    if (decision.failure_reason) {
      message += `**Failure Reason:** ${sanitizeForPrompt(decision.failure_reason)}\n`;
    }

    if (decision.limitation) {
      message += `**Limitations:** ${sanitizeForPrompt(decision.limitation)}\n`;
    }

    message += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  });

  return message.trim();
}

/**
 * Format not found message
 *
 * @param {string} topic - Topic
 * @returns {string} Formatted message
 */
function formatNotFoundMessage(topic) {
  return `
## 🔍 No Decisions Found

No decisions found for topic: \`${topic}\`

### Suggestions

1. Check spelling - topic names are case-sensitive
2. Try semantic search instead:
   \`\`\`
   /mama-suggest ${topic}
   \`\`\`

3. List all recent decisions:
   \`\`\`
   /mama-list 20
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
  return `
## ❌ Error Recalling Decisions

${err.message}

**Tip:** Topic parameter is required.

Example:
\`\`\`
mamaRecallCommand({ topic: 'mama_architecture' })
\`\`\`

See usage help: \`/mama-recall --help\`
`.trim();
}

/**
 * Format usage help
 *
 * @returns {string} Help text
 */
function formatUsageHelp() {
  return `
## /mama-recall - Recall Decision History

Recall full decision history for a specific topic.

### Usage

\`\`\`javascript
mamaRecallCommand({
  topic: 'decision_topic'  // required
})
\`\`\`

### Parameters

- **topic** (string, required): Decision topic to recall
  - Must match exactly (case-sensitive)
  - Examples: 'auth_strategy', 'mama_architecture', 'mama_similarity_thresholds'

### Examples

\`\`\`javascript
// Recall all decisions for a topic
mamaRecallCommand({ topic: 'mama_architecture' })

// Result includes:
// - Full decision history in chronological order
// - Timestamps, confidence scores, outcomes
// - Reasoning for each decision
// - Decision evolution (if topic reused for updates)
\`\`\`

### Understanding Decision History

When you reuse the same topic for multiple decisions, MAMA creates a **decision evolution graph**:

\`\`\`
Topic: mama_architecture
├─ Decision 1 (3 days ago): "Use SQLite for plugin"
│  ├─ Outcome: superseded
│  └─ Reasoning: "Lightweight, no external dependencies"
│
└─ Decision 2 (1 day ago): "Use SQLite + sqlite-vec for embeddings"
   ├─ Outcome: success
   └─ Reasoning: "Need vector similarity search, sqlite-vec provides this"
   └─ Supersedes: Decision 1
\`\`\`

### Output Format

The command returns:

1. **Markdown formatted history**
   - Each decision with full details
   - Timestamps (relative time, e.g., "2 days ago")
   - Confidence and outcome status
   - Reasoning and limitations

2. **Decision evolution chain**
   - Shows how decisions evolved over time
   - Indicates which decisions supersede others

3. **Metadata**
   - Number of decisions found
   - Total topic history

### Tips

1. **Exact topic match required**
   - Topics are case-sensitive
   - 'auth_strategy' ≠ 'Auth_Strategy'

2. **Use semantic search if unsure**
   - If you don't remember exact topic name, use \`/mama-suggest\`
   - Example: \`/mama-suggest authentication\` finds 'auth_strategy'

3. **Decision evolution**
   - Reusing same topic creates evolution graph
   - Great for tracking how decisions change over time

### Error Messages

- \`No decisions found\`: Topic doesn't exist or typo in topic name
- \`Topic parameter is required\`: Missing topic argument

### Related Commands

- \`/mama-suggest <query>\` - Semantic search when you don't know exact topic
- \`/mama-list [limit]\` - Browse recent decisions
- \`/mama-save\` - Save a new decision

`.trim();
}

module.exports = {
  mamaRecallCommand,
  formatHistoryMessage,
  formatNotFoundMessage,
  formatErrorMessage,
  formatUsageHelp,
};
