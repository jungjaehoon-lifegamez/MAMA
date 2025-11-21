/**
 * /mama-save Command
 *
 * Story M3.1: MAMA Commands Suite
 * Save a decision or insight to MAMA's long-term memory
 *
 * Usage:
 *   mamaSaveCommand({ topic, decision, reasoning, confidence, type, outcome })
 *
 * @module commands/mama-save
 */

const mama = require('../core/mama-api');
const { info, error: logError } = require('../core/debug-logger');

/**
 * Save a decision to MAMA memory
 *
 * @param {Object} args - Command arguments
 * @param {string} args.topic - Decision topic (required)
 * @param {string} args.decision - Decision made (required)
 * @param {string} args.reasoning - Why this decision was made (required)
 * @param {number} [args.confidence=0.5] - Confidence score 0.0-1.0
 * @param {string} [args.type='user_decision'] - 'user_decision' or 'assistant_insight'
 * @param {string} [args.outcome='pending'] - 'pending', 'success', 'failure', 'partial', 'superseded'
 * @param {string} [args.failure_reason] - Why decision failed (optional)
 * @param {string} [args.limitation] - Known limitations (optional)
 * @returns {Promise<Object>} Command result
 */
async function mamaSaveCommand(args = {}) {
  try {
    // Validate required fields
    if (!args.topic || !args.decision || !args.reasoning) {
      return {
        success: false,
        message: formatUsageHelp(),
      };
    }

    // Call mama.save() API
    info('[mama-save] Saving decision to MAMA...');

    const decisionId = await mama.save({
      topic: args.topic,
      decision: args.decision,
      reasoning: args.reasoning,
      confidence: args.confidence !== undefined ? parseFloat(args.confidence) : 0.5,
      type: args.type || 'user_decision',
      outcome: args.outcome || 'pending',
      failure_reason: args.failure_reason || null,
      limitation: args.limitation || null,
    });

    info(`[mama-save] ✅ Decision saved successfully: ${decisionId}`);

    return {
      success: true,
      decision_id: decisionId,
      topic: args.topic,
      message: formatSuccessMessage(decisionId, args.topic),
    };
  } catch (err) {
    logError(`[mama-save] ❌ Failed to save decision: ${err.message}`);

    return {
      success: false,
      error: err.message,
      message: formatErrorMessage(err),
    };
  }
}

/**
 * Format success message
 *
 * @param {string} decisionId - Decision ID
 * @param {string} topic - Topic
 * @returns {string} Formatted message
 */
function formatSuccessMessage(decisionId, topic) {
  return `
## ✅ Decision Saved Successfully

**Decision ID:** \`${decisionId}\`
**Topic:** \`${topic}\`

You can recall this decision later with:
\`\`\`
/mama-recall ${topic}\`\`\`

Or search for related decisions:
\`\`\`
/mama-suggest ${topic}
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
  let message = `## ❌ Error Saving Decision\n\n${err.message}\n\n`;

  if (err.message.includes('requires topic')) {
    message += '**Tip:** Topic is required. Example: `auth_strategy`\n';
  } else if (err.message.includes('requires decision')) {
    message += '**Tip:** Decision is required. Example: `Use JWT with refresh tokens`\n';
  } else if (err.message.includes('requires reasoning')) {
    message += '**Tip:** Reasoning is required. Explain why this decision was made.\n';
  } else if (err.message.includes('confidence must be')) {
    message += '**Tip:** Confidence must be a number between 0.0 and 1.0. Example: `0.9`\n';
  }

  message += '\nSee usage help: `/mama-save --help`';

  return message.trim();
}

/**
 * Format usage help
 *
 * @returns {string} Help text
 */
function formatUsageHelp() {
  return `
## /mama-save - Save a Decision

Save a decision or insight to MAMA's long-term memory.

### Usage

\`\`\`javascript
mamaSaveCommand({
  topic: 'decision_topic',
  decision: 'What was decided',
  reasoning: 'Why this decision was made',
  confidence: 0.9,  // optional, 0.0-1.0, default: 0.5
  type: 'user_decision',  // optional, 'user_decision' or 'assistant_insight'
  outcome: 'pending'  // optional, 'pending', 'success', 'failure', 'partial', 'superseded'
})
\`\`\`

### Required Parameters

- **topic** (string): Short identifier (e.g., 'auth_strategy', 'mama_architecture')
  - Use lowercase with underscores
  - Reuse same topic for related decisions to create evolution graph

- **decision** (string): What was decided (e.g., 'Use JWT with refresh tokens')
  - Max 2000 characters
  - Clear, actionable statement

- **reasoning** (string): Why this decision was made
  - Required - never leave empty
  - Explain context, alternatives considered, and rationale
  - Max 5000 characters

### Optional Parameters

- **confidence** (number): Confidence score 0.0-1.0
  - 0.9 = high confidence
  - 0.8 = medium confidence
  - 0.5 = experimental (default)

- **type** (string): Decision origin
  - 'user_decision' = user explicitly decided (default)
  - 'assistant_insight' = Claude's suggestion

- **outcome** (string): Decision status
  - 'pending' = new decision (default)
  - 'success' = confirmed working
  - 'failure' = approach failed
  - 'partial' = mixed results
  - 'superseded' = replaced by newer decision

- **failure_reason** (string): Why decision failed (use with outcome='failure')

- **limitation** (string): Known limitations or constraints

### Examples

\`\`\`javascript
// Simple save
mamaSaveCommand({
  topic: 'mama_performance_budget',
  decision: 'Use 500ms timeout for all hooks',
  reasoning: 'MAMA-PRD.md specifies 500ms p95 latency target to avoid blocking workflow'
})

// With confidence and outcome
mamaSaveCommand({
  topic: 'mama_similarity_thresholds',
  decision: 'UserPromptSubmit 75%, PreToolUse 70%, PostToolUse 75%',
  reasoning: 'Experience-based tuning during Epic M2 - different hooks need different precision/recall trade-offs',
  confidence: 0.8,
  outcome: 'success'
})

// Failed decision (lesson learned)
mamaSaveCommand({
  topic: 'mama_test_expectations',
  decision: 'Write tests before implementation',
  reasoning: 'TDD prevents implementation drift',
  confidence: 0.7,
  outcome: 'failure',
  failure_reason: 'Requirements changed during implementation, tests became obsolete'
})
\`\`\`

### Tips

1. **Reuse topics** for related decisions to create evolution graph
   - ✅ Good: 'mama_architecture' (reuse for all MAMA architecture decisions)
   - ❌ Bad: 'mama_architecture_20251118', 'mama_mcp_integration'

2. **Write detailed reasoning** - future you will thank you
   - Explain what problem you were solving
   - List alternatives you considered
   - State why you chose this approach

3. **Set realistic confidence** - helps prioritize when recalling
   - Don't always use 0.9 - be honest about uncertainty

4. **Update outcomes** as you learn
   - Start with 'pending'
   - Update to 'success' when validated
   - Update to 'failure' with lessons learned

### Error Messages

- \`requires topic\`: Topic parameter is missing
- \`requires decision\`: Decision parameter is missing
- \`requires reasoning\`: Reasoning parameter is missing
- \`confidence must be\`: Confidence must be 0.0-1.0
- \`type must be\`: Type must be 'user_decision' or 'assistant_insight'
- \`outcome must be\`: Outcome must be valid status

`.trim();
}

module.exports = {
  mamaSaveCommand,
  formatSuccessMessage,
  formatErrorMessage,
  formatUsageHelp,
};
