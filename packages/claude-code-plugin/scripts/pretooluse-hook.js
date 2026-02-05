#!/usr/bin/env node
/**
 * Smart PreToolUse Hook - Contract-First Development Enforcement
 *
 * DESIGN PRINCIPLE:
 * - Read/Grep: ALLOW freely (need to read code to learn interfaces)
 * - Edit/Write: CHECK for contracts (prevent hallucinated interfaces)
 *
 * FLOW:
 * 1. Edit/Write detected → extract tokens from file path
 * 2. Search MAMA for contract_* entries
 * 3. Found: Show contracts as reference
 * 4. Not found: Strong warning to read source first
 */

const path = require('path');

// Resolve core path for mcp-client
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
require('module').globalPaths.push(CORE_PATH);

const { vectorSearch, initDB } = require(path.join(CORE_PATH, 'memory-store'));
const { generateEmbedding } = require(path.join(CORE_PATH, 'embeddings'));
const { sanitizeForPrompt } = require(path.join(CORE_PATH, 'prompt-sanitizer'));
const { shouldShowLong, markSeen } = require(path.join(CORE_PATH, 'session-utils'));

const SEARCH_LIMIT = 5;
const SIMILARITY_THRESHOLD = 0.6; // Lowered for better contract discovery

// Tools that WRITE code - need contract check
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// Tools that READ code - allow freely
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

// Code file extensions that should trigger contract search
const CODE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.scala',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.m',
]);

// Files/paths to always skip (docs, config, etc.)
const SKIP_PATTERNS = [
  /\.md$/i, // Markdown docs
  /\.txt$/i, // Text files
  /\.json$/i, // Config files
  /\.ya?ml$/i, // YAML config
  /\.toml$/i, // TOML config
  /\.ini$/i, // INI config
  /\.env/i, // Environment files
  /\.gitignore$/i, // Git ignore
  /\.dockerignore$/i, // Docker ignore
  /LICENSE/i, // License files
  /README/i, // README files
  /CHANGELOG/i, // Changelog files
  /\/docs?\//i, // docs/ or doc/ directories
  /\/examples?\//i, // examples/ or example/ directories
  /\/test[s]?\//i, // test/ or tests/ directories
  /\.test\./i, // Test files (.test.js, .test.ts)
  /\.spec\./i, // Spec files (.spec.js, .spec.ts)
  /node_modules\//i, // Node modules
  /\.lock$/i, // Lock files
];

/**
 * Check if file should trigger contract search
 * Only code files that are likely to contain API contracts
 */
function shouldProcessFile(filePath) {
  if (!filePath) {
    return false;
  }

  // Check skip patterns first
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(filePath)) {
      return false;
    }
  }

  // Check if it's a code file
  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

function isContractResult(result) {
  const topic = (result && result.topic) || '';
  return typeof topic === 'string' && topic.startsWith('contract_');
}

function extractExpectReturns(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const expectsMatch = clean.match(/expects\s*\{([^}]+)\}/i);
  const returnsMatch = clean.match(/returns\s*([\s\S]+?)(?:$| on \d{3}| or \d{3}|,? or \d{3})/i);
  const expects = expectsMatch ? `{${expectsMatch[1].trim()}}` : 'unknown';
  const returns = returnsMatch ? returnsMatch[1].trim() : 'unknown';
  return { expects, returns };
}

function extractFieldsFromExpect(expectsText) {
  const match = (expectsText || '').match(/\{([^}]+)\}/);
  if (!match) {
    return [];
  }
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeField(field) {
  return field.replace(/\?$/, '').trim().toLowerCase();
}

function isInformativeContract(result) {
  const { expects, returns } = extractExpectReturns(result.decision || '');
  return expects !== 'unknown' || returns !== 'unknown';
}

function compactContractLine(result, idx) {
  const topic = sanitizeForPrompt(result.topic || result.id || 'unknown');
  const score = typeof result.final_score === 'number' ? result.final_score.toFixed(2) : 'n/a';
  const { expects, returns } = extractExpectReturns(result.decision || '');
  const expectsSafe = sanitizeForPrompt(expects);
  const returnsSafe = sanitizeForPrompt(returns);
  const expectsText = expectsSafe !== 'unknown' ? `expects ${expectsSafe}` : '';
  const returnsText = returnsSafe !== 'unknown' ? `returns ${returnsSafe}` : '';
  const parts = [expectsText, returnsText].filter(Boolean).join(', ');
  return `${idx + 1}. ${topic} (score: ${score}) ${parts}`.trim();
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9_:/-]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function isLikelyMatch(result, tokens) {
  const hay = ((result.topic || '') + ' ' + (result.decision || '')).toLowerCase();
  if (tokens.length === 0) {
    return true;
  }
  return tokens.some((t) => hay.includes(t));
}

function formatResults(results) {
  if (!results || results.length === 0) {
    return { text: 'No matching MAMA decisions/contracts found.', hasContracts: false, top: [] };
  }

  const contracts = results.filter(isContractResult);
  if (contracts.length === 0) {
    return { text: 'No matching contracts found in MAMA.', hasContracts: false, top: [] };
  }

  const matches = contracts.filter((r) => isLikelyMatch(r, formatResults.tokens || []));
  const base = matches.length > 0 ? matches : contracts;
  const filtered = base.filter(isInformativeContract);
  if (filtered.length === 0) {
    return { text: 'No informative contracts found in MAMA.', hasContracts: false, top: [] };
  }

  const lines = ['Contracts:'];
  filtered.slice(0, SEARCH_LIMIT).forEach((r, idx) => {
    lines.push(compactContractLine(r, idx));
  });
  return { text: lines.join('\n'), hasContracts: true, top: filtered.slice(0, SEARCH_LIMIT) };
}

function buildReasoningSummary(queryTokens, results, safeFilePath) {
  if (!results || results.length === 0) {
    return [
      'Reasoning Summary:',
      '- No contracts found, cannot ground fields.',
      `- File context: ${safeFilePath || 'unknown'}`,
    ].join('\n');
  }

  const tokensUsed = queryTokens.length > 0 ? sanitizeForPrompt(queryTokens.join(', ')) : 'none';
  const lines = ['Reasoning Summary:'];
  lines.push(`- Matched contracts using tokens: ${tokensUsed}`);

  const first = results[0];
  const { expects, returns } = extractExpectReturns(first.decision || '');
  if (expects !== 'unknown') {
    const fields = extractFieldsFromExpect(expects).map(normalizeField);
    // Sanitize each field to prevent prompt injection from stored contracts
    lines.push(
      `- Expected request fields (normalized): ${fields.map((f) => sanitizeForPrompt(f)).join(', ') || 'none'}`
    );
  } else {
    lines.push('- Expected request fields: unknown (not present in contract)');
  }

  if (returns !== 'unknown') {
    const preview = sanitizeForPrompt(returns.replace(/\s+/g, ' ').trim().slice(0, 120));
    lines.push(`- Expected response shape: ${preview}`);
  } else {
    lines.push('- Expected response shape: unknown (not present in contract)');
  }

  lines.push(`- File context: ${safeFilePath || 'unknown'}`);
  return lines.join('\n');
}

async function main() {
  // Debug: Log hook invocation only when MAMA_DEBUG is set
  if (process.env.MAMA_DEBUG === 'true') {
    const fs = require('fs');
    const os = require('os');
    const debugLogPath = path.join(PLUGIN_ROOT || os.tmpdir(), '.pretooluse-debug.log');
    fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] PreToolUse hook called\n`);
  }

  // Check opt-out flag (consistent with posttooluse-hook.js)
  if (process.env.MAMA_DISABLE_HOOKS === 'true') {
    console.error(JSON.stringify({ decision: 'allow', reason: 'MAMA hooks disabled' }));
    return process.exit(0);
  }

  const stdin = process.stdin;
  let data = '';

  for await (const chunk of stdin) {
    data += chunk;
  }

  let input = {};
  try {
    input = JSON.parse(data);
  } catch (e) {
    // No input, use env vars
  }

  // Get tool name to determine behavior
  const toolName = input.tool_name || process.env.TOOL_NAME || '';

  // READ TOOLS: Allow freely without contract check
  // We WANT Claude to read code to learn interfaces
  if (READ_TOOLS.has(toolName)) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  // WRITE TOOLS: Check for contracts before allowing
  if (!WRITE_TOOLS.has(toolName)) {
    // Unknown tool - allow silently
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  // --- From here: Edit/Write/NotebookEdit only ---

  // Sanitize filePath immediately to prevent prompt injection
  const rawFilePath = input.tool_input?.file_path || input.file_path || process.env.FILE_PATH || '';
  const filePath = rawFilePath; // Keep raw for file operations
  const safeFilePath = sanitizeForPrompt(rawFilePath); // Use this for output messages

  // Skip non-code files (docs, config, etc.) - reduces noise
  if (!shouldProcessFile(filePath)) {
    // Silent allow - no contract check needed for non-code files
    const response = { decision: 'allow', reason: '' };
    console.error(JSON.stringify(response));
    process.exit(0);
  }

  // Extract search query from file path
  const fileName = filePath.split('/').pop() || '';
  // Future: analyze new_string content to find interface calls
  // const _newContent = input.tool_input?.new_string || input.tool_input?.content || '';
  const searchQuery = fileName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');

  let searchSummary = '';
  let hasContracts = false;
  let reasoningSummary = '';
  try {
    // Initialize DB and generate embedding
    await initDB();
    const queryEmbedding = await generateEmbedding(searchQuery);

    if (!queryEmbedding) {
      searchSummary = 'Embedding generation failed.';
      reasoningSummary = 'Reasoning Summary:\n- Embedding generation failed.';
    } else {
      // Direct vectorSearch (no MCP spawn)
      const results = await vectorSearch(queryEmbedding, SEARCH_LIMIT, SIMILARITY_THRESHOLD);

      if (results && Array.isArray(results) && results.length > 0) {
        const queryTokens = tokenize(searchQuery);
        formatResults.tokens = queryTokens;
        const formatted = formatResults(results);
        searchSummary = formatted.text;
        hasContracts = formatted.hasContracts;
        reasoningSummary = buildReasoningSummary(queryTokens, formatted.top, safeFilePath);
      } else {
        searchSummary = 'No matching contracts found.';
        reasoningSummary = 'Reasoning Summary:\n- No matching contracts found.';
      }
    }
  } catch (err) {
    searchSummary = `Search failed: ${err.message}`;
    reasoningSummary = `Reasoning Summary:\n- Search failed: ${err.message}`;
  }

  const session = shouldShowLong('pre');
  const showLong = session.showLong;

  // Build message based on whether contracts were found
  let messageContent;

  if (hasContracts) {
    // Contracts found - show them as reference
    const intro = showLong
      ? `\n📋 **MAMA Contract Reference** (Edit: ${safeFilePath})\n` +
        `Use these contracts. Do NOT guess fields.\n\n`
      : `\n📋 Contracts for ${fileName}:\n`;

    messageContent = intro + `${searchSummary}\n\n` + `${reasoningSummary}`;
  } else {
    // No contracts - strong warning
    const warning =
      `\n⚠️ **No Contract Found** (Edit: ${safeFilePath})\n\n` +
      `Before writing code that calls external interfaces:\n` +
      `1. READ the source file first to understand the interface\n` +
      `2. SAVE the contract using:\n\n` +
      '```javascript\n' +
      'mcp__plugin_mama_mama__save({\n' +
      "  type: 'decision',\n" +
      "  topic: 'contract_ClassName_methodName',\n" +
      "  decision: 'ClassName.methodName(param: Type) → ReturnType',\n" +
      "  reasoning: 'Source: filepath:linenum. Evidence: read from source.',\n" +
      '  confidence: 0.9\n' +
      '});\n' +
      '```\n\n' +
      `3. THEN write your code using the saved contract\n\n` +
      `This prevents hallucinated interfaces.`;

    messageContent = warning;
  }

  markSeen(session.state, 'pre');

  // PreToolUse: exit(0) + stdout JSON with hookSpecificOutput to show message and allow tool
  // exit(2) blocks the tool, exit(0) allows it
  const response = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Contract reference provided',
      additionalContext: messageContent,
    },
  };
  console.log(JSON.stringify(response));
  process.exit(0);
}

// CLI execution
if (require.main === module) {
  main().catch((err) => {
    // Error handler - still allow operation, just log the error
    console.error(
      JSON.stringify({
        decision: 'allow',
        reason: `PreToolUse error: ${err.message}`,
      })
    );
    process.exit(0);
  });
}

// Export handler for hook spec compliance
module.exports = { handler: main, main };
