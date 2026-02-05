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
// Contract extraction for direct saving
const { extractContracts } = require(path.join(CORE_PATH, 'contract-extractor'));
// Note: searchDecisionsAndContracts and formatContractForMama available for future use

// Configuration
const SIMILARITY_THRESHOLD = 0.75; // AC: Above threshold for auto-save suggestion
const MAX_RUNTIME_MS = 3000; // Increased for embedding model loading
const AUDIT_LOG_FILE = path.join(PLUGIN_ROOT, '.posttooluse-audit.log');
const CONTRACT_RATE_LIMIT_MS = Number(process.env.MAMA_CONTRACT_RATE_LIMIT_MS || 15000);
const CONTRACT_RATE_LIMIT_FILE = path.join(PLUGIN_ROOT, '.posttooluse-contract-rate.json');
const SESSION_STATE_FILE = path.join(PLUGIN_ROOT, '.hook-session-state.json');

// Tools that trigger auto-save consideration
const EDIT_TOOLS = ['write_file', 'apply_patch', 'Edit', 'Write', 'test', 'build'];

// Files/paths that don't need contract tracking (expanded Feb 2025)
const LOW_PRIORITY_PATTERNS = [
  /\/docs?\//i, // docs/ or doc/
  /\/examples?\//i, // examples/ or example/
  /\/demo\//i, // demo/
  /\/stories\//i, // storybook stories
  /\/storybook\//i, // storybook config
  /\/test[s]?\//i, // test/ or tests/
  /\.test\.[jt]sx?$/i, // .test.js, .test.ts, etc.
  /\.spec\.[jt]sx?$/i, // .spec.js, .spec.ts, etc.
  /node_modules\//i, // dependencies
  /\.md$/i, // markdown docs
  /\.txt$/i, // text files
  /\.ya?ml$/i, // YAML config
  /\.json$/i, // JSON config
  /\.toml$/i, // TOML config
  /\.gitignore$/i, // git ignore
  /\.env/i, // environment files
  /LICENSE/i, // license files
  /README/i, // readme files
  /CHANGELOG/i, // changelog files
  /\.lock$/i, // lock files
  /\.log$/i, // log files
];

function isLowPriorityPath(filePath) {
  if (!filePath) {
    return false;
  }

  for (const pattern of LOW_PRIORITY_PATTERNS) {
    if (pattern.test(filePath)) {
      return true;
    }
  }

  return false;
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

function getSessionId() {
  return (
    process.env.MAMA_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    process.env.SESSION_ID ||
    new Date().toISOString().slice(0, 10)
  );
}

function loadSessionState() {
  try {
    if (fs.existsSync(SESSION_STATE_FILE)) {
      const raw = fs.readFileSync(SESSION_STATE_FILE, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (_err) {
    // Ignore state read errors
  }
  return {};
}

function saveSessionState(state) {
  try {
    fs.writeFileSync(SESSION_STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (_err) {
    // Ignore state write errors
  }
}

function shouldShowLong(hookName) {
  const sessionId = getSessionId();
  const state = loadSessionState();
  if (state.sessionId !== sessionId) {
    state.sessionId = sessionId;
    state.seen = {};
  }
  const seen = state.seen || {};
  const showLong = !seen[hookName];
  return { showLong, state };
}

function markSeen(state, hookName) {
  if (!state.seen) {
    state.seen = {};
  }
  state.seen[hookName] = true;
  saveSessionState(state);
}

function formatContractsCompact(contracts, filePath) {
  if (!contracts || contracts.length === 0) {
    // Fallback message when no contracts detected
    return `\n\n---\n⚠️ **Code change detected**\n\n**File:** \`${filePath}\`\n\nNo API contracts auto-detected. If this file has API calls, save contracts manually.\n`;
  }
  const apiContracts = contracts.filter((c) => c.type === 'api_endpoint');
  if (apiContracts.length === 0) {
    return `\n\n---\n⚠️ **Code change detected**\n\n**File:** \`${filePath}\`\n\n${contracts.length} non-API contracts found. Check if API contracts need to be saved.\n`;
  }

  // Sanitize all user-controlled data to prevent prompt injection
  const safeFilePath = sanitizeForPrompt(filePath || 'unknown');
  const firstContract = apiContracts[0] || {};
  const safeMethod = sanitizeForPrompt(firstContract.method?.toLowerCase() || 'api');
  const safePath = sanitizeForPrompt(
    (firstContract.path || '/api/endpoint').replace(/[/:]/g, '_').replace(/^_/, '')
  );
  const safeMethodUpper = sanitizeForPrompt(firstContract.method || 'METHOD');
  const safePathDisplay = sanitizeForPrompt(firstContract.path || '/path');

  let output = '\n\n---\n';
  output += '🚨 **MANDATORY: Save API Contract NOW**\n\n';
  output += `**File:** \`${safeFilePath}\`\n`;
  output += `**Endpoints:** ${apiContracts.length}\n\n`;
  apiContracts.slice(0, 3).forEach((c, i) => {
    output += `${i + 1}. ${sanitizeForPrompt(c.method || 'UNKNOWN')} ${sanitizeForPrompt(c.path || '/unknown')}\n`;
  });
  output += '\n⛔ **YOU MUST call mcp__plugin_mama_mama__save before continuing.**\n';
  output += 'Extract request/response from code above. Do NOT skip this step.\n\n';
  output += '```javascript\n';
  output += 'mcp__plugin_mama_mama__save({\n';
  output += `  type: "decision",\n`;
  output += `  topic: "contract_${safeMethod}_${safePath}",\n`;
  output += `  decision: "${safeMethodUpper} ${safePathDisplay} expects {...}, returns {...}",\n`;
  output += '  reasoning: "Context: ... Evidence: req.body/res.json fields. Unknowns: none.",\n';
  output += '  confidence: 0.9\n';
  output += '});\n';
  output += '```\n';
  return output;
}

function formatContractTemplateCompact(filePath, toolName) {
  let output = '\n\n---\n';
  output += '⚠️ **Code change detected (Short)**\n\n';
  output += `**File:** \`${filePath}\`\n`;
  output += `**Tool:** ${toolName}\n\n`;
  output +=
    'No contracts auto-extracted. If this is a new endpoint, create a contract before coding.\n';
  return output;
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
/**
 * Format extracted contracts for Main Claude to save
 */
function formatExtractedContracts(contracts, filePath) {
  if (!contracts || contracts.length === 0) {
    return '';
  }

  // Filter BEFORE formatting: Only API endpoints with snippets
  const apiContracts = contracts.filter(
    (c) => c.type === 'api_endpoint' && c.snippet && c.snippet.trim().length > 50 // Skip tiny snippets
  );

  if (apiContracts.length === 0) {
    return ''; // No useful contracts to show
  }

  let output = '\n\n---\n';
  output += '✅ **MAMA v2: API Contracts Detected**\n\n';
  output += `**File:** \`${filePath}\`\n`;
  output += `**Found:** ${apiContracts.length} API endpoint(s)\n\n`;

  // WHY: Explain the purpose clearly
  output += '## 🎯 Why Save These?\n\n';
  output += 'Save exact schemas now so future sessions reuse the same fields (prevents drift).\n\n';

  // WHAT: Show snippets for Claude to analyze
  output += '## 📝 Code Snippets:\n\n';
  apiContracts.forEach((contract, idx) => {
    // Sanitize method and path to prevent prompt injection
    const safeMethod = sanitizeForPrompt(contract.method || 'UNKNOWN');
    const safePath = sanitizeForPrompt(contract.path || '/unknown');
    output += `### ${idx + 1}. ${safeMethod} ${safePath}\n\n`;
    output += '```javascript\n';
    const snippet = contract.snippet.trim();
    // Sanitize snippet to prevent markdown breakout and prompt injection
    output += sanitizeForPrompt(snippet.substring(0, 500));
    if (snippet.length > 500) {
      output += '\n// ... (truncated)';
    }
    output += '\n```\n\n';
  });

  // HOW: Clear step-by-step instruction
  output += '---\n';
  output += '## ⚡ Your Task:\n\n';
  output += 'For each snippet above:\n';
  output += '1. **Extract request schema**: `req.body` / destructuring\n';
  output += '2. **Extract response schema**: `res.json({ ... })`\n';
  output += '3. **Save to MAMA** using MCP tool:\n';
  output += '   ```javascript\n';
  output += '   mcp__plugin_mama_mama__save({\n';
  output += "     type: 'decision',\n";
  output += "     topic: 'contract_post_api_orders_create',  // Use actual method + path\n";
  output +=
    "     decision: 'POST /api/orders/create expects {customerId, items, shippingAddress}, returns {success, orderId, total}',\n";
  output +=
    "     reasoning: 'Context: Added order create endpoint. Evidence: req.body has {customerId, items, shippingAddress}; res.json returns {success, orderId, total}. Why it matters: prevents FE/BE schema drift. Unknowns: none.',\n";
  output += '     confidence: 0.95\n';
  output += '   });\n';
  output += '   ```\n\n';
  output += '**Time budget**: < 3 seconds total\n';
  output += '**Start now**: Analyze and save.\n\n';
  output += '## 🧠 Reasoning (Required)\n\n';
  output += 'Ground in code evidence. If unsure, mark `unknown`.\n\n';
  output += '**Reasoning Template (fill with real evidence):**\n';
  output += '```\n';
  output += 'Context: <what part of code changed>\n';
  output += 'Evidence: <exact fields from req.body / res.json>\n';
  output += 'Why it matters: <prevents schema drift / keeps FE-BE aligned>\n';
  output += "Unknowns: <explicitly list unknowns or 'none'>\n";
  output += '```\n';

  return output;
}

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

  // Simplified output - no verbose Task template (Feb 2025)
  // Just remind Claude to check for contracts, don't overwhelm with instructions
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
    let inputData = {};
    try {
      inputData = await readStdin();

      // DEBUG: Log raw stdin for debugging (only if MAMA_DEBUG enabled)
      if (process.env.MAMA_DEBUG === 'true') {
        const debugLogFile = path.join(PLUGIN_ROOT, '.posttooluse-stdin-debug.log');
        try {
          fs.appendFileSync(
            debugLogFile,
            `\n[${new Date().toISOString()}] stdin: ${JSON.stringify(inputData).slice(0, 2000)}\n`
          );
        } catch (debugErr) {
          // Swallow filesystem errors - debug logging should never interrupt main flow
          console.error(`[MAMA DEBUG] Failed to write debug log: ${debugErr.message}`);
        }
      }
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
      // Parse content based on tool type
      // Edit: tool_input has old_string/new_string, tool_response has originalFile
      // Write: tool_input has content
      diffContent =
        (inputData.tool_response && inputData.tool_response.originalFile) || // Edit: full file
        (inputData.tool_input && inputData.tool_input.new_string) || // Edit: new content
        (inputData.tool_input && inputData.tool_input.content) || // Write: content
        (inputData.tool_response && inputData.tool_response.content) || // Write: response
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

    // DEBUG: Check what we received
    if (process.env.MAMA_DEBUG) {
      console.error(`[DEBUG] toolName: ${toolName}`);
      console.error(`[DEBUG] filePath: ${filePath}`);
      console.error(`[DEBUG] diffContent length: ${diffContent?.length || 0}`);
      console.error(
        `[DEBUG] tool_input keys: ${Object.keys(inputData.tool_input || {}).join(', ')}`
      );
    }

    // Fix: For Edit/Write tools, ALWAYS read entire file for contract extraction
    // (Edit only sends old_string/new_string, Write sends content but may be incomplete)
    if ((toolName === 'Edit' || toolName === 'Write') && filePath) {
      try {
        if (fs.existsSync(filePath)) {
          diffContent = fs.readFileSync(filePath, 'utf8');
          info(`[Hook] Read full file for ${toolName} tool (${diffContent.length} bytes)`);
        }
      } catch (readErr) {
        warn(`[Hook] Failed to read file for ${toolName}: ${readErr.message}`);
      }
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

    const session = shouldShowLong('post');
    const showLong = session.showLong;

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
      // MAMA v2: Try auto-extraction first (fast path)
      try {
        const extracted = extractContracts(diffContent, filePath);
        // Flatten all contract types into single array
        const allContracts = [
          ...(extracted.apiEndpoints || []),
          ...(extracted.functionSignatures || []),
          ...(extracted.typeDefinitions || []),
          ...(extracted.sqlSchemas || []),
          ...(extracted.graphqlSchemas || []),
        ];
        if (allContracts.length > 0) {
          info(`[Hook] Auto-extracted ${allContracts.length} contracts`);
          const formatted = showLong
            ? formatExtractedContracts(allContracts, filePath)
            : formatContractsCompact(allContracts, filePath);
          // Fallback if formatted output is empty (e.g., no API endpoints)
          if (formatted && formatted.trim()) {
            additionalContext += formatted;
          } else {
            info('[Hook] Extracted contracts produced empty output, using template');
            additionalContext += showLong
              ? formatContractTemplate(filePath, diffContent, toolName)
              : formatContractTemplateCompact(filePath, toolName);
          }
        } else {
          // Fallback to Haiku template if extraction found nothing
          info('[Hook] No contracts auto-extracted, using Haiku template');
          additionalContext += showLong
            ? formatContractTemplate(filePath, diffContent, toolName)
            : formatContractTemplateCompact(filePath, toolName);
        }
      } catch (err) {
        warn(`[Hook] Auto-extraction failed: ${err.message}, using Haiku template`);
        additionalContext += showLong
          ? formatContractTemplate(filePath, diffContent, toolName)
          : formatContractTemplateCompact(filePath, toolName);
      }
    }
    // Add auto-save suggestion
    if (showLong) {
      additionalContext += formatAutoSaveSuggestion(
        topic,
        decision,
        reasoning,
        similarCheck.decisions
      );
    }

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

    // PostToolUse uses exit(2) + stderr to ensure Claude sees contract analysis
    // Write/Edit results are just "success" messages, so overwriting is OK
    // (Unlike PreToolUse which preserves file content with exit(0))
    console.error(JSON.stringify(response));

    // Log suggestion
    const contractInfo = hasCodeChange ? ', contract analysis required' : '';
    info(
      `[Hook] Auto-save suggested (${latencyMs}ms, ${similarCheck.decisions.length} similar${contractInfo})`
    );

    markSeen(session.state, 'post');
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
