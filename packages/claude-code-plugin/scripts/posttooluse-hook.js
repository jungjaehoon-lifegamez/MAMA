#!/usr/bin/env node
/**
 * PostToolUse Hook for MAMA Plugin
 *
 * Story M2.3: PostToolUse 자동 저장 훅
 *
 * Triggers automatic decision capture after Write/Edit actions.
 * Suggests auto-save with Accept/Modify/Dismiss options.
 *
 * Environment Variables:
 * - TOOL_NAME: Tool that was invoked (write_file, apply_patch, etc.)
 * - FILE_PATH: File/directory path for the operation (optional)
 * - DIFF_CONTENT: Code diff or change description (optional)
 * - CONVERSATION_CONTEXT: Recent conversation for reasoning extraction (optional)
 * - MAMA_DISABLE_HOOKS: Set to "true" to disable hook (opt-out)
 * - MAMA_DISABLE_AUTO_SAVE: Set to "true" to disable auto-save (privacy mode)
 *
 * Output: Auto-save suggestion to stdout (or nothing if disabled/no match)
 * Exit codes: 0 (success), 1 (error)
 *
 * @module posttooluse-hook
 */

const path = require('path');
const fs = require('fs');

// Get paths relative to script location
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');

// Add core to require path
require('module').globalPaths.push(CORE_PATH);

const { info, warn, error: logError } = require(path.join(CORE_PATH, 'debug-logger'));
const { vectorSearch } = require(path.join(CORE_PATH, 'memory-store'));
const { loadConfig } = require(path.join(CORE_PATH, 'config-loader'));

// Configuration
const SIMILARITY_THRESHOLD = 0.75; // AC: Above threshold for auto-save suggestion
const MAX_RUNTIME_MS = 500;
const AUDIT_LOG_FILE = path.join(PLUGIN_ROOT, '.posttooluse-audit.log');

// Tools that trigger auto-save consideration
const EDIT_TOOLS = ['write_file', 'apply_patch', 'Edit', 'Write', 'test', 'build'];

/**
 * Get tier information from config
 *
 * @returns {Object} Tier info {tier, vectorSearchEnabled, reason}
 */
function getTierInfo() {
  try {
    const config = loadConfig();

    if (config.embeddingModel && config.vectorSearchEnabled !== false) {
      return {
        tier: 1,
        vectorSearchEnabled: true,
        reason: 'Full MAMA features available'
      };
    } else if (!config.embeddingModel) {
      return {
        tier: 2,
        vectorSearchEnabled: false,
        reason: 'Embeddings unavailable'
      };
    } else {
      return {
        tier: 3,
        vectorSearchEnabled: false,
        reason: 'MAMA disabled'
      };
    }
  } catch (error) {
    warn(`[Hook] Failed to load config, assuming Tier 2: ${error.message}`);
    return {
      tier: 2,
      vectorSearchEnabled: false,
      reason: 'Config load failed'
    };
  }
}

/**
 * Extract topic from conversation context
 * AC: Reuse query-intent heuristics for topic suggestions
 *
 * @param {string} conversationContext - Recent conversation
 * @param {string} filePath - File being edited
 * @returns {string} Suggested topic
 */
function extractTopic(conversationContext, filePath) {
  // Extract from file path first
  if (filePath) {
    const basename = path.basename(filePath, path.extname(filePath));
    // Convert snake_case or kebab-case to readable topic
    const topic = basename
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());

    if (topic && topic.length > 3) {
      return topic;
    }
  }

  // Extract from conversation (look for key phrases)
  if (conversationContext) {
    const patterns = [
      /(?:implement|add|create|fix|update)\s+([a-z0-9_-]+)/i,
      /(?:for|regarding|about)\s+([a-z0-9_\s]+)/i,
      /decision.*?:\s*([a-z0-9_\s]+)/i
    ];

    for (const pattern of patterns) {
      const match = conversationContext.match(pattern);
      if (match && match[1]) {
        return match[1].trim().substring(0, 50);
      }
    }
  }

  return 'Code Change';
}

/**
 * Extract reasoning from conversation context
 * AC: Reasoning captured from conversation context (FR24)
 *
 * @param {string} conversationContext - Recent conversation
 * @returns {string} Extracted reasoning
 */
function extractReasoning(conversationContext) {
  if (!conversationContext) {
    return 'No reasoning provided';
  }

  // Look for reasoning patterns in conversation
  const patterns = [
    /(?:because|since|reason|why)[\s:]+([^.!?]+[.!?])/i,
    /(?:this|that)\s+(?:allows|enables|fixes|improves)\s+([^.!?]+[.!?])/i,
    /(?:to|for)\s+(?:solve|fix|address|handle)\s+([^.!?]+[.!?])/i
  ];

  for (const pattern of patterns) {
    const match = conversationContext.match(pattern);
    if (match && match[1]) {
      return match[1].trim().substring(0, 200);
    }
  }

  // Fallback: Take first meaningful sentence
  const sentences = conversationContext.split(/[.!?]+/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length > 20 && trimmed.length < 200) {
      return trimmed + '.';
    }
  }

  return conversationContext.substring(0, 200);
}

/**
 * Format auto-save suggestion
 * AC: User can Accept/Modify/Dismiss
 *
 * @param {string} topic - Suggested topic
 * @param {string} decision - Decision summary
 * @param {string} reasoning - Extracted reasoning
 * @param {Array} similarDecisions - Existing similar decisions
 * @returns {string} Formatted suggestion
 */
function formatAutoSaveSuggestion(topic, decision, reasoning, similarDecisions) {
  let output = '\n\n---\n';
  output += '💾 **MAMA Auto-Save Suggestion**\n\n';

  output += `**Topic:** ${topic}\n`;
  output += `**Decision:** ${decision}\n`;
  output += `**Reasoning:** ${reasoning}\n\n`;

  if (similarDecisions && similarDecisions.length > 0) {
    output += '**Similar existing decisions:**\n';
    similarDecisions.slice(0, 2).forEach((d, i) => {
      output += `${i + 1}. ${d.decision} (${Math.round(d.similarity * 100)}% match)\n`;
    });
    output += '\n';
  }

  output += '**Actions:**\n';
  output += '- [a] Accept - Save this decision as-is\n';
  output += '- [m] Modify - Edit topic/decision before saving\n';
  output += '- [d] Dismiss - Don\'t save (this is logged)\n\n';

  output += '💡 *This suggestion is based on your recent code changes.*\n';
  output += '---\n';

  return output;
}

/**
 * Log audit entry
 * AC: Audit log entry records each auto-save attempt
 *
 * @param {string} action - accept/modify/dismiss
 * @param {string} topic - Topic
 * @param {string} decision - Decision text
 */
function logAudit(action, topic, decision) {
  try {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      action,
      topic,
      decision: decision.substring(0, 100),
      tool: process.env.TOOL_NAME || 'unknown'
    };

    const logLine = JSON.stringify(entry) + '\n';
    fs.appendFileSync(AUDIT_LOG_FILE, logLine, 'utf8');

    info(`[Hook] Audit logged: ${action} - ${topic}`);
  } catch (error) {
    warn(`[Hook] Failed to write audit log: ${error.message}`);
  }
}

/**
 * Check if similar decision exists
 * AC: Semantic similarity above threshold
 *
 * @param {string} decision - Decision text
 * @returns {Promise<Object>} {hasSimilar, decisions}
 */
async function checkSimilarDecision(decision) {
  try {
    const { generateEmbedding } = require(path.join(CORE_PATH, 'embeddings'));
    const embedding = await generateEmbedding(decision);

    const results = vectorSearch(embedding, 5, SIMILARITY_THRESHOLD);

    return {
      hasSimilar: results.length > 0,
      decisions: results
    };
  } catch (error) {
    logError(`[Hook] Similarity check failed: ${error.message}`);
    return {
      hasSimilar: false,
      decisions: []
    };
  }
}

/**
 * Generate decision summary from diff
 *
 * @param {string} diffContent - Code diff
 * @param {string} filePath - File path
 * @returns {string} Decision summary
 */
function generateDecisionSummary(diffContent, filePath) {
  if (!diffContent || diffContent.trim() === '') {
    return `Modified ${path.basename(filePath || 'file')}`;
  }

  // Extract meaningful changes from diff
  const lines = diffContent.split('\n');
  const addedLines = lines.filter(l => l.startsWith('+')).slice(0, 3);

  if (addedLines.length > 0) {
    // Try to extract function/class names
    const funcMatch = addedLines.join('\n').match(/(?:function|class|const|let)\s+(\w+)/);
    if (funcMatch) {
      return `Implemented ${funcMatch[1]} in ${path.basename(filePath || 'file')}`;
    }

    // Fallback to file-based summary
    return `Updated ${path.basename(filePath || 'file')} with ${addedLines.length} additions`;
  }

  return `Modified ${path.basename(filePath || 'file')}`;
}

/**
 * Main hook handler
 */
async function main() {
  const startTime = Date.now();

  try {
    // 1. Check opt-out flags
    if (process.env.MAMA_DISABLE_HOOKS === 'true') {
      info('[Hook] MAMA hooks disabled via MAMA_DISABLE_HOOKS');
      process.exit(0);
    }

    if (process.env.MAMA_DISABLE_AUTO_SAVE === 'true') {
      info('[Hook] Auto-save disabled via MAMA_DISABLE_AUTO_SAVE (privacy mode)');
      process.exit(0);
    }

    // 2. Get tool name
    const toolName = process.env.TOOL_NAME || '';
    if (!toolName || !EDIT_TOOLS.some(tool => toolName.includes(tool))) {
      // Silent exit - tool not applicable for auto-save
      process.exit(0);
    }

    // 3. Get tier information
    const tierInfo = getTierInfo();

    // 4. Skip on Tier 2/3 (need embeddings for similarity)
    if (tierInfo.tier !== 1) {
      warn(`[Hook] Auto-save requires Tier 1 (embeddings), current: Tier ${tierInfo.tier}`);
      process.exit(0);
    }

    // 5. Extract context
    const filePath = process.env.FILE_PATH || '';
    const diffContent = process.env.DIFF_CONTENT || '';
    const conversationContext = process.env.CONVERSATION_CONTEXT || '';

    if (!diffContent && !filePath) {
      // No content to analyze
      info('[Hook] No diff or file path provided, skipping auto-save');
      process.exit(0);
    }

    // 6. Generate decision summary
    const decision = generateDecisionSummary(diffContent, filePath);
    const topic = extractTopic(conversationContext, filePath);
    const reasoning = extractReasoning(conversationContext);

    info(`[Hook] Auto-save candidate: "${decision}"`);

    // 7. Check for similar existing decisions
    let similarCheck = { hasSimilar: false, decisions: [] };

    try {
      similarCheck = await Promise.race([
        checkSimilarDecision(decision),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), MAX_RUNTIME_MS)
        )
      ]);
    } catch (error) {
      warn(`[Hook] Similarity check timed out or failed: ${error.message}`);
    }

    const latencyMs = Date.now() - startTime;

    // 8. Output auto-save suggestion
    // AC: When diff resembles existing decision, suggest auto-save
    const suggestion = formatAutoSaveSuggestion(
      topic,
      decision,
      reasoning,
      similarCheck.decisions
    );

    console.log(suggestion);

    // Log suggestion (will be logged again when user responds)
    info(`[Hook] Auto-save suggested (${latencyMs}ms, ${similarCheck.decisions.length} similar)`);

    // Note: Actual save happens when user selects action
    // This would be handled by Claude Code's interaction system
    // For now, we just output the suggestion

    process.exit(0);

  } catch (error) {
    logError(`[Hook] Fatal error: ${error.message}`);
    console.error(`❌ MAMA PostToolUse Hook Error: ${error.message}`);
    process.exit(1);
  }
}

// Run hook
if (require.main === module) {
  main().catch(error => {
    logError(`[Hook] Unhandled error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  main,
  getTierInfo,
  extractTopic,
  extractReasoning,
  formatAutoSaveSuggestion,
  generateDecisionSummary,
  logAudit,
  checkSimilarDecision
};
