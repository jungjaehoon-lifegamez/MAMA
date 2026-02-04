#!/usr/bin/env node
/**
 * PostToolUse Hook for MAMA Plugin
 *
 * Story M2.3: PostToolUse Auto-save Hook
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
// Lazy load to avoid embedding model initialization before tier check
// const { vectorSearch } = require(path.join(CORE_PATH, 'memory-store'));
const { loadConfig } = require(path.join(CORE_PATH, 'config-loader'));

// MAMA v2: Contract extraction and auto-save
const { extractContracts, formatContractForMama } = require(
  path.join(CORE_PATH, 'contract-extractor')
);
const { batchSaveContracts } = require(path.join(CORE_PATH, 'mcp-client'));

// Configuration
const SIMILARITY_THRESHOLD = 0.75; // AC: Above threshold for auto-save suggestion
const MAX_RUNTIME_MS = 3000; // Increased for embedding model loading
const AUDIT_LOG_FILE = path.join(PLUGIN_ROOT, '.posttooluse-audit.log');

// Tools that trigger auto-save consideration
const EDIT_TOOLS = ['write_file', 'apply_patch', 'Edit', 'Write', 'test', 'build'];

/**
 * Get tier information from config
 *
 * @returns {Object} Tier info {tier, vectorSearchEnabled, reason}
 */
function getTierInfo() {
  // Fast path for testing: completely skip MAMA (fastest)
  if (process.env.MAMA_FORCE_TIER_3 === 'true') {
    return {
      tier: 3,
      vectorSearchEnabled: false,
      reason: 'Tier 3 forced for testing (embeddings disabled)',
    };
  }

  // Fast path for testing: skip embedding model loading
  if (process.env.MAMA_FORCE_TIER_2 === 'true') {
    return {
      tier: 2,
      vectorSearchEnabled: false,
      reason: 'Tier 2 forced for testing (fast mode)',
    };
  }

  try {
    const config = loadConfig();

    if (config.modelName && config.vectorSearchEnabled !== false) {
      return {
        tier: 1,
        vectorSearchEnabled: true,
        reason: 'Full MAMA features available',
      };
    } else if (!config.modelName) {
      return {
        tier: 2,
        vectorSearchEnabled: false,
        reason: 'Embeddings unavailable',
      };
    } else {
      return {
        tier: 3,
        vectorSearchEnabled: false,
        reason: 'MAMA disabled',
      };
    }
  } catch (error) {
    warn(`[Hook] Failed to load config, assuming Tier 2: ${error.message}`);
    return {
      tier: 2,
      vectorSearchEnabled: false,
      reason: 'Config load failed',
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
    const topic = basename.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

    if (topic && topic.length > 3) {
      return topic;
    }
  }

  // Extract from conversation (look for key phrases)
  if (conversationContext) {
    const patterns = [
      /(?:implement|add|create|fix|update)\s+([a-z0-9_-]+)/i,
      /(?:for|regarding|about)\s+([a-z0-9_\s]+)/i,
      /decision.*?:\s*([a-z0-9_\s]+)/i,
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
    /(?:to|for)\s+(?:solve|fix|address|handle)\s+([^.!?]+[.!?])/i,
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
 * Format contract auto-save results
 * MAMA v2: Show what contracts were automatically saved
 *
 * @param {Object} contractResults - Batch save results
 * @returns {string} Formatted contract report
 */
function formatContractResults(contractResults) {
  if (!contractResults || contractResults.saved.length === 0) {
    return '';
  }

  let output = '\n\n---\n';
  output += '🔌 **MAMA v2: Contracts Auto-Saved**\n\n';

  // Show saved contracts
  if (contractResults.saved.length > 0) {
    output += `✅ **Saved ${contractResults.saved.length} contract(s):**\n`;
    contractResults.saved.forEach((item, idx) => {
      const c = item.contract;
      if (c.topic) {
        output += `${idx + 1}. \`${c.topic}\`: ${c.decision.substring(0, 80)}...\n`;
      }
    });
    output += '\n';
  }

  // Show skipped contracts
  if (contractResults.skipped.length > 0) {
    output += `⚠️  **Skipped ${contractResults.skipped.length} low-confidence contract(s)**\n\n`;
  }

  // Show errors
  if (contractResults.errors.length > 0) {
    output += `❌ **Failed to save ${contractResults.errors.length} contract(s)**\n`;
    contractResults.errors.forEach((item, idx) => {
      output += `${idx + 1}. ${item.error}\n`;
    });
    output += '\n';
  }

  output += '💡 *These contracts are now available for frontend/backend consistency checks.*\n';
  output += '🔍 *Use `/mama:search contract_` to view saved contracts.*\n';
  output += '---\n';

  return output;
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
  output += "- [d] Dismiss - Don't save (this is logged)\n\n";

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
      tool: process.env.TOOL_NAME || 'unknown',
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
    // Lazy load embeddings and vector search (only on Tier 1)
    const { generateEmbedding } = require(path.join(CORE_PATH, 'embeddings'));
    const { vectorSearch } = require(path.join(CORE_PATH, 'memory-store'));

    const embedding = await generateEmbedding(decision);
    const results = await vectorSearch(embedding, 5, SIMILARITY_THRESHOLD);

    return {
      hasSimilar: results.length > 0,
      decisions: results,
    };
  } catch (error) {
    logError(`[Hook] Similarity check failed: ${error.message}`);
    return {
      hasSimilar: false,
      decisions: [],
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
  const addedLines = lines.filter((l) => l.startsWith('+')).slice(0, 3);

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
 * Read input from stdin
 */
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Failed to parse stdin JSON: ${error.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
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

    // 2. Get tool information from stdin
    let toolName, filePath, diffContent, conversationContext;
    try {
      const inputData = await readStdin();
      toolName = inputData.toolName || inputData.tool || process.env.TOOL_NAME || '';
      filePath =
        inputData.filePath ||
        inputData.file_path ||
        inputData.FILE_PATH ||
        process.env.FILE_PATH ||
        '';
      diffContent =
        inputData.diffContent ||
        inputData.diff ||
        inputData.content ||
        process.env.DIFF_CONTENT ||
        '';
      conversationContext =
        inputData.conversationContext ||
        inputData.context ||
        process.env.CONVERSATION_CONTEXT ||
        '';
    } catch (error) {
      // Fallback to environment variables
      toolName = process.env.TOOL_NAME || '';
      filePath = process.env.FILE_PATH || '';
      diffContent = process.env.DIFF_CONTENT || '';
      conversationContext = process.env.CONVERSATION_CONTEXT || '';
    }

    if (!toolName || !EDIT_TOOLS.some((tool) => toolName.includes(tool))) {
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

    // 5. Validate context
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

    // 6.5. MAMA v2: Extract and auto-save contracts
    let contractResults = null;
    if (process.env.MAMA_V2_CONTRACTS !== 'false' && diffContent) {
      try {
        info('[Hook] Extracting contracts from code...');
        const extracted = extractContracts(diffContent, filePath);
        const allContracts = [
          ...extracted.apiEndpoints,
          ...extracted.functionSignatures,
          ...extracted.typeDefinitions,
        ];

        if (allContracts.length > 0) {
          info(`[Hook] Found ${allContracts.length} contracts, formatting for MAMA...`);
          const formattedContracts = allContracts
            .map(formatContractForMama)
            .filter((c) => c !== null);

          if (formattedContracts.length > 0) {
            info(`[Hook] Saving ${formattedContracts.length} contracts to MAMA...`);
            contractResults = await batchSaveContracts(formattedContracts);
            info(
              `[Hook] Contracts saved: ${contractResults.saved.length}, skipped: ${contractResults.skipped.length}, errors: ${contractResults.errors.length}`
            );
          }
        }
      } catch (error) {
        warn(`[Hook] Contract extraction failed: ${error.message}`);
        // Don't fail the entire hook if contract extraction fails
      }
    }

    // 7. Check for similar existing decisions
    let similarCheck = { hasSimilar: false, decisions: [] };

    try {
      similarCheck = await Promise.race([
        checkSimilarDecision(decision),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), MAX_RUNTIME_MS)),
      ]);
    } catch (error) {
      warn(`[Hook] Similarity check timed out or failed: ${error.message}`);
    }

    const latencyMs = Date.now() - startTime;

    // 8. Output auto-save suggestion and contract results
    // AC: When diff resembles existing decision, suggest auto-save
    let additionalContext = '';

    // Add contract results if available
    if (contractResults && contractResults.saved.length > 0) {
      additionalContext += formatContractResults(contractResults);
    }

    // Add auto-save suggestion
    additionalContext += formatAutoSaveSuggestion(
      topic,
      decision,
      reasoning,
      similarCheck.decisions
    );

    // Correct Claude Code JSON format with hookSpecificOutput
    const systemMessage =
      contractResults && contractResults.saved.length > 0
        ? `🔌 MAMA v2: ${contractResults.saved.length} contract(s) saved | 💾 Suggestion: ${topic} (${latencyMs}ms)`
        : `💾 MAMA suggests saving: ${topic} (${latencyMs}ms)`;

    const response = {
      decision: null,
      reason: '',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        systemMessage,
        additionalContext,
      },
    };
    console.log(JSON.stringify(response));

    // Log suggestion (will be logged again when user responds)
    const contractInfo = contractResults ? `, ${contractResults.saved.length} contracts saved` : '';
    info(
      `[Hook] Auto-save suggested (${latencyMs}ms, ${similarCheck.decisions.length} similar${contractInfo})`
    );

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
  main().catch((error) => {
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
  formatContractResults,
  generateDecisionSummary,
  logAudit,
  checkSimilarDecision,
};
