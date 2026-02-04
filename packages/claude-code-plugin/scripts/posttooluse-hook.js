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

// MAMA v2: Contract extraction
const { sanitizeForPrompt } = require(path.join(CORE_PATH, 'prompt-sanitizer'));

// Configuration
const SIMILARITY_THRESHOLD = 0.75; // AC: Above threshold for auto-save suggestion
const MAX_RUNTIME_MS = 3000; // Increased for embedding model loading
const AUDIT_LOG_FILE = path.join(PLUGIN_ROOT, '.posttooluse-audit.log');
const CONTRACT_RATE_LIMIT_MS = Number(process.env.MAMA_CONTRACT_RATE_LIMIT_MS || 15000);
const CONTRACT_RATE_LIMIT_FILE = path.join(PLUGIN_ROOT, '.posttooluse-contract-rate.json');

// Tools that trigger auto-save consideration
const EDIT_TOOLS = ['write_file', 'apply_patch', 'Edit', 'Write', 'test', 'build'];

function isLowPriorityPath(filePath) {
  if (!filePath) {
    return false;
  }
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('/docs/') ||
    normalized.includes('/examples/') ||
    normalized.includes('/example/') ||
    normalized.includes('/demo/') ||
    normalized.includes('/stories/') ||
    normalized.includes('/storybook/')
  );
}

function checkContractRateLimit() {
  if (!Number.isFinite(CONTRACT_RATE_LIMIT_MS) || CONTRACT_RATE_LIMIT_MS <= 0) {
    return { allowed: true, waitMs: 0 };
  }

  try {
    if (fs.existsSync(CONTRACT_RATE_LIMIT_FILE)) {
      const raw = fs.readFileSync(CONTRACT_RATE_LIMIT_FILE, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      const last = Number(parsed.last_ts || 0);
      const now = Date.now();
      const elapsed = now - last;
      if (last && elapsed < CONTRACT_RATE_LIMIT_MS) {
        return { allowed: false, waitMs: CONTRACT_RATE_LIMIT_MS - elapsed };
      }
    }
  } catch (error) {
    warn(`[Hook] Contract rate-limit read failed: ${error.message}`);
  }

  try {
    fs.writeFileSync(CONTRACT_RATE_LIMIT_FILE, JSON.stringify({ last_ts: Date.now() }), 'utf8');
  } catch (error) {
    warn(`[Hook] Contract rate-limit write failed: ${error.message}`);
  }

  return { allowed: true, waitMs: 0 };
}

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
 * Format contract analysis template for Haiku
 * MAMA v2: Simple template - let Haiku analyze the diff directly
 *
 * @param {string} filePath - File being edited
 * @param {string} diffContent - Code changes
 * @param {string} toolName - Tool used (Edit, Write, etc)
 * @returns {string} Formatted template for Task tool
 */
function formatContractTemplate(filePath, diffContent, toolName) {
  if (!diffContent || diffContent.trim().length === 0) {
    return '';
  }

  // Chunk long diffs to reduce omission risk
  const maxChunkLength = 800;
  const maxTotalLength = 2000;
  const chunks = [];
  for (let i = 0; i < diffContent.length; i += maxChunkLength) {
    chunks.push(diffContent.slice(i, i + maxChunkLength));
  }
  const maxChunks = Math.max(1, Math.floor(maxTotalLength / maxChunkLength));
  const limitedChunks = chunks.slice(0, maxChunks);
  const wasTruncated = chunks.length > limitedChunks.length;

  // Sanitize filePath and toolName (user-controlled data)
  const safeFilePath = sanitizeForPrompt(filePath || 'unknown');
  const safeToolName = sanitizeForPrompt(toolName || 'unknown');
  // Sanitize diff content for safe injection
  const safeChunks = limitedChunks.map((chunk) => sanitizeForPrompt(chunk));

  let output = '\n\n---\n';
  output += '🔌 **MAMA v2: Code Change Detected**\n\n';
  output += `**File:** \`${safeFilePath}\`\n`;
  output += `**Tool:** ${safeToolName}\n`;
  output += `**Diff Size:** ${diffContent.length} characters\n\n`;

  output += '### Code Changes:\n';
  output += '```\n';
  safeChunks.forEach((chunk, index) => {
    output += `--- chunk ${index + 1}/${safeChunks.length} ---\n`;
    output += chunk;
    output += '\n';
  });
  if (wasTruncated) {
    output += '\n... (truncated: additional chunks omitted)\n';
  }
  output += '\n```\n\n';

  output += '---\n\n';
  output += '⚠️ **CRITICAL: Contract Analysis Required**\n\n';
  output += '**YOU MUST execute the Task tool below to prevent vibe coding breakage.**\n\n';
  output +=
    'Without contract extraction, future sessions will hallucinate schemas and break consistency.\n';
  output += 'This is the PRIMARY purpose of MAMA v2 - DO NOT skip this step.\n\n';
  output += '**Execute this Task tool call NOW:**\n\n';
  output += '```javascript\n';
  output += 'Task({\n';
  output += '  subagent_type: "general-purpose",\n';
  output += '  model: "haiku",  // Fast & cheap\n';
  output += '  description: "Extract and save contracts",\n';
  output += '  prompt: `\n';
  output += `    CRITICAL TASK: Extract API contracts from code changes in ${safeFilePath}\n`;
  output += '    \n';
  output += '    WHY THIS MATTERS:\n';
  output += '    - Prevents schema mismatches between frontend/backend\n';
  output += '    - Stops Claude from hallucinating field names in future sessions\n';
  output += '    - Maintains consistency across multi-session development\n';
  output += '    \n';
  output += '    CODE CHANGES TO ANALYZE:\n';
  output += safeChunks
    .map((chunk, index) => `    --- chunk ${index + 1}/${safeChunks.length} ---\n    ${chunk}`)
    .join('\n');
  output += '\n';
  output += '    \n';
  output += '    REQUIRED: Extract ALL contracts found:\n';
  output += '    \n';
  output += '    1. API ENDPOINTS:\n';
  output += '       - Method: GET/POST/PUT/DELETE\n';
  output += '       - Path: /api/users/:id\n';
  output += '       - Request schema: { email: string, password: string }\n';
  output += '       - Success response: { userId: string, token: string }\n';
  output += '       - Error responses: { error: string } with status codes\n';
  output += '    \n';
  output += '    2. FUNCTION SIGNATURES:\n';
  output += '       - Name, parameters with types, return type\n';
  output += '       - Async/sync specification\n';
  output += '    \n';
  output += '    3. TYPE DEFINITIONS:\n';
  output += '       - Interfaces, types, schemas\n';
  output += '       - Field names and types\n';
  output += '    \n';
  output += '    SKIP these (not contracts):\n';
  output += '    - Test files, mock data, examples, comments\n';
  output += '    \n';
  output += '    FOR EACH CONTRACT FOUND:\n';
  output += '    \n';
  output += '    Use /mama:decision to save with this format:\n';
  output += '    \n';
  output += '    Topic: contract_[method]_[path] (e.g., contract_post_api_users)\n';
  output += '    Decision: Complete schema with request AND response\n';
  output +=
    '    Reasoning: Explain what this contract does, what depends on it, why consistency matters\n';
  output += '    Confidence: 0.8-0.9 for clear contracts\n';
  output += '    \n';
  output += '    Example:\n';
  output +=
    '    /mama:decision contract_post_api_auth_login "POST /api/auth/login. Request: { email: string, password: string }. Response 200: { userId: string, token: string, email: string }. Response 401: { error: \\"Invalid credentials\\" }" "Authentication endpoint. Frontend must send exact email/password schema. Backend returns userId + token for session. Critical for login flow consistency." --confidence=0.9\n';
  output += '    \n';
  output += '    If NO valid contracts found (test files, config, docs):\n';
  output += '    - Reply: "contract analysis skipped - no production contracts found"\n';
  output += '    \n';
  output += '    DO NOT skip contracts that exist. This is CRITICAL for preventing bugs.\n';
  output += '  `\n';
  output += '});\n';
  output += '```\n';
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

  // Sanitize all untrusted data
  const safeTopic = sanitizeForPrompt(topic || 'unknown');
  const safeDecision = sanitizeForPrompt(decision || '');
  const safeReasoning = sanitizeForPrompt(reasoning || '');

  output += `**Topic:** ${safeTopic}\n`;
  output += `**Decision:** ${safeDecision}\n`;
  output += `**Reasoning:** ${safeReasoning}\n\n`;

  if (similarDecisions && similarDecisions.length > 0) {
    output += '**Similar existing decisions:**\n';
    similarDecisions.slice(0, 2).forEach((d, i) => {
      const safeSimDecision = sanitizeForPrompt(d.decision || '');
      output += `${i + 1}. ${safeSimDecision} (${Math.round(d.similarity * 100)}% match)\n`;
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

function logContractAnalysis(action, details = {}) {
  try {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      action,
      ...details,
    };
    const logLine = JSON.stringify(entry) + '\n';
    fs.appendFileSync(AUDIT_LOG_FILE, logLine, 'utf8');
  } catch (error) {
    warn(`[Hook] Failed to write contract audit: ${error.message}`);
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
    const { initDB } = require(path.join(CORE_PATH, 'db-manager'));
    const { generateEmbedding } = require(path.join(CORE_PATH, 'embeddings'));
    const { vectorSearch } = require(path.join(CORE_PATH, 'memory-store'));

    // Initialize DB first
    await initDB();

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

  // ALWAYS log hook execution to file for debugging
  const hookLogFile = path.join(PLUGIN_ROOT, '.hook-execution.log');
  try {
    const timestamp = new Date().toISOString();
    const logEntry =
      JSON.stringify({
        timestamp,
        hook: 'PostToolUse',
        toolName: process.env.TOOL_NAME || 'unknown',
        filePath: process.env.FILE_PATH || 'unknown',
        diffSize: process.env.DIFF_CONTENT ? process.env.DIFF_CONTENT.length : 0,
      }) + '\n';
    fs.appendFileSync(hookLogFile, logEntry, 'utf8');
  } catch (err) {
    // Ignore logging errors
  }

  // DEBUG: Confirm hook is executing (only if MAMA_DEBUG enabled)
  if (process.env.MAMA_DEBUG === 'true') {
    console.error('🔍 [MAMA DEBUG] PostToolUse hook STARTED');
    console.error(`🔍 [MAMA DEBUG] TOOL_NAME: ${process.env.TOOL_NAME}`);
    console.error(`🔍 [MAMA DEBUG] FILE_PATH: ${process.env.FILE_PATH}`);
  }

  try {
    // 1. Check opt-out flags
    if (process.env.MAMA_DISABLE_HOOKS === 'true') {
      if (process.env.MAMA_DEBUG === 'true') {
        console.error('🔍 [MAMA DEBUG] Hooks DISABLED via env var');
      }
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
      // Parse Claude Code project-level hook format
      toolName =
        inputData.tool_name || inputData.toolName || inputData.tool || process.env.TOOL_NAME || '';
      filePath =
        (inputData.tool_input && inputData.tool_input.file_path) ||
        inputData.filePath ||
        inputData.file_path ||
        inputData.FILE_PATH ||
        process.env.FILE_PATH ||
        '';
      diffContent =
        (inputData.tool_input && inputData.tool_input.content) ||
        (inputData.tool_response && inputData.tool_response.content) ||
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

    // 6.5. MAMA v2: Use Haiku for contract analysis (no regex pre-filter)
    let hasCodeChange = false;

    if (process.env.MAMA_V2_CONTRACTS !== 'false' && diffContent && diffContent.trim().length > 0) {
      // Skip test files
      const normalizedPath = filePath ? filePath.replace(/\\/g, '/') : '';
      if (
        !normalizedPath ||
        (!normalizedPath.includes('test/') &&
          !normalizedPath.includes('__tests__/') &&
          !normalizedPath.includes('.test.') &&
          !normalizedPath.includes('.spec.') &&
          !normalizedPath.includes('_test.'))
      ) {
        if (isLowPriorityPath(filePath)) {
          info('[Hook] Low-priority file detected, skipping contract analysis');
          logContractAnalysis('skipped_low_priority', {
            file: filePath || 'unknown',
            diff_size: diffContent.length,
          });
        } else {
          const rateLimit = checkContractRateLimit();
          if (!rateLimit.allowed) {
            info(`[Hook] Contract analysis rate-limited (${rateLimit.waitMs}ms remaining)`);
            logContractAnalysis('skipped_rate_limit', {
              file: filePath || 'unknown',
              diff_size: diffContent.length,
              wait_ms: rateLimit.waitMs,
            });
          } else {
            hasCodeChange = true;
            logContractAnalysis('suggested', {
              file: filePath || 'unknown',
              diff_size: diffContent.length,
            });
            info('[Hook] Code change detected; delegating contract analysis to Haiku');
          }
        }
      } else {
        info('[Hook] Test file detected, skipping contract analysis');
        logContractAnalysis('skipped_test_file', {
          file: filePath || 'unknown',
          diff_size: diffContent.length,
        });
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

    // Add contract template if code changes detected
    if (hasCodeChange) {
      additionalContext += formatContractTemplate(filePath, diffContent, toolName);
    }

    // Add auto-save suggestion
    additionalContext += formatAutoSaveSuggestion(
      topic,
      decision,
      reasoning,
      similarCheck.decisions
    );

    // Correct Claude Code JSON format with hookSpecificOutput
    const systemMessage = hasCodeChange
      ? `⚠️ MAMA v2 CRITICAL: Execute Task tool below to extract contracts and prevent future bugs | ${topic} (${latencyMs}ms)`
      : `💾 MAMA suggests saving: ${topic} (${latencyMs}ms)`;

    const response = {
      decision: 'allow',
      message: additionalContext,
    };

    // DEBUG: Confirm output (only if MAMA_DEBUG enabled)
    if (process.env.MAMA_DEBUG === 'true') {
      console.error('🔍 [MAMA DEBUG] Hook outputting response:');
      console.error(`🔍 [MAMA DEBUG] - hasCodeChange: ${hasCodeChange}`);
      console.error(`🔍 [MAMA DEBUG] - systemMessage: ${systemMessage}`);
      console.error(`🔍 [MAMA DEBUG] - additionalContext length: ${additionalContext.length}`);
    }

    // Output to stderr for exit code 2 (blocking error)
    console.error(JSON.stringify(response));

    // Log suggestion
    const contractInfo = hasCodeChange ? ', contract analysis required' : '';
    info(
      `[Hook] Auto-save suggested (${latencyMs}ms, ${similarCheck.decisions.length} similar${contractInfo})`
    );

    // Note: Actual save happens when user selects action
    // This would be handled by Claude Code's interaction system
    // For now, we just output the suggestion

    // Exit with code 2 to make output visible to Claude (not just user)
    // Per GitHub #11224: exit code 2 = blocking error = visible to Claude
    process.exit(2);
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
  formatContractTemplate,
  generateDecisionSummary,
  logAudit,
  checkSimilarDecision,
  sanitizeForPrompt,
};
