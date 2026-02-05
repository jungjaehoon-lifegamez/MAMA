#!/usr/bin/env node
/**
 * Smart PreToolUse Hook - Searches MAMA before read/edit to avoid hallucination
 */

const path = require('path');
const fs = require('fs');

// Resolve core path for mcp-client
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
require('module').globalPaths.push(CORE_PATH);

const { searchDecisions } = require(path.join(CORE_PATH, 'mcp-client'));
const { sanitizeForPrompt } = require(path.join(CORE_PATH, 'prompt-sanitizer'));

const SEARCH_LIMIT = 5;
const SEARCH_TIMEOUT_MS = 20000;
const SESSION_STATE_FILE = path.join(PLUGIN_ROOT, '.hook-session-state.json');

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

function isContractResult(result) {
  const topic = (result && result.topic) || '';
  return typeof topic === 'string' && topic.startsWith('contract_');
}

function extractExpectReturns(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const expectsMatch = clean.match(/expects\s*\{([^}]+)\}/i);
  const returnsMatch = clean.match(/returns\s*([^]+?)(?:$| on \d{3}| or \d{3}|,? or \d{3})/i);
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

function buildReasoningSummary(queryTokens, results, filePath) {
  if (!results || results.length === 0) {
    return [
      'Reasoning Summary:',
      '- No contracts found, cannot ground fields.',
      `- File context: ${filePath || 'unknown'}`,
    ].join('\n');
  }

  const tokensUsed = queryTokens.length > 0 ? queryTokens.join(', ') : 'none';
  const lines = ['Reasoning Summary:'];
  lines.push(`- Matched contracts using tokens: ${tokensUsed}`);

  const first = results[0];
  const { expects, returns } = extractExpectReturns(first.decision || '');
  if (expects !== 'unknown') {
    const fields = extractFieldsFromExpect(expects).map(normalizeField);
    lines.push(`- Expected request fields (normalized): ${fields.join(', ') || 'none'}`);
  } else {
    lines.push('- Expected request fields: unknown (not present in contract)');
  }

  if (returns !== 'unknown') {
    const preview = sanitizeForPrompt(returns.replace(/\s+/g, ' ').trim().slice(0, 120));
    lines.push(`- Expected response shape: ${preview}`);
  } else {
    lines.push('- Expected response shape: unknown (not present in contract)');
  }

  lines.push(`- File context: ${filePath || 'unknown'}`);
  return lines.join('\n');
}

async function main() {
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

  const filePath = input.tool_input?.file_path || input.file_path || process.env.FILE_PATH || '';
  const pattern = input.tool_input?.pattern || input.pattern || process.env.GREP_PATTERN || '';

  // Skip non-code files (docs, config, etc.) - reduces noise
  if (!shouldProcessFile(filePath)) {
    // Silent allow - no contract check needed for non-code files
    const response = { decision: 'allow', reason: '' };
    console.log(JSON.stringify(response));
    return;
  }

  // Extract search query from file path
  const fileName = filePath.split('/').pop() || '';
  const searchQuery = pattern || fileName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');

  let searchSummary = '';
  let hasContracts = false;
  let reasoningSummary = '';
  try {
    const searchRes = await searchDecisions(searchQuery, SEARCH_LIMIT, {
      timeout: SEARCH_TIMEOUT_MS,
    });
    if (searchRes && Array.isArray(searchRes.results)) {
      const queryTokens = tokenize(searchQuery);
      formatResults.tokens = queryTokens;
      const formatted = formatResults(searchRes.results);
      searchSummary = formatted.text;
      hasContracts = formatted.hasContracts;
      reasoningSummary = buildReasoningSummary(queryTokens, formatted.top, filePath);
    } else {
      searchSummary = 'Search returned no parsable results.';
      reasoningSummary = 'Reasoning Summary:\n- Search returned no parsable results.';
    }
  } catch (err) {
    searchSummary = `Search failed: ${err.message}`;
    reasoningSummary = `Reasoning Summary:\n- Search failed: ${err.message}`;
  }

  const contractWarning = hasContracts
    ? ''
    : '\n⛔ **BLOCKER: No contract found. Do NOT guess fields.**\n' +
      'If this is a new endpoint, you MUST first create and save a contract grounded in a real spec/design (not guesses).\n' +
      'Use mcp__plugin_mama_mama__save with topic like `contract_<method>_<path>` and include exact request/response.\n' +
      '\n**Template (fill in real values only):**\n' +
      '```javascript\n' +
      'mcp__plugin_mama_mama__save({\n' +
      "  type: 'decision',\n" +
      "  topic: 'contract_post_api_example',\n" +
      "  decision: 'POST /api/example expects {field1: string, field2: number}, returns 201: {success: true, id: string}',\n" +
      "  reasoning: 'Derived from approved API spec/design (link or reference).',\n" +
      '  confidence: 0.9\n' +
      '});\n' +
      '```\n';

  const session = shouldShowLong('pre');
  const showLong = session.showLong;

  const intro = showLong
    ? `\n🚨 **You MUST search MAMA before opening or editing this file.**\n` +
      `Why: Prevents schema hallucination and keeps frontend/backend contracts consistent.\n\n`
    : `\nMAMA search executed (short view).\nUse contracts below; do not guess fields.\n\n`;

  const response = {
    decision: 'allow',
    reason: '',
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      systemMessage: `⚠️ MAMA CRITICAL: Search before reading (${searchQuery || 'unknown'})`,
      additionalContext:
        intro +
        `**Search executed. Results:**\n` +
        `${searchSummary}\n` +
        `\n${reasoningSummary}\n` +
        `${contractWarning}\n` +
        `File: ${filePath || 'unknown'}`,
    },
  };

  markSeen(session.state, 'pre');

  // Contract가 없으면 조용히 allow (파일 내용 표시되도록)
  if (!hasContracts) {
    const silentResponse = { decision: 'allow', reason: '' };
    console.log(JSON.stringify(silentResponse));
    process.exit(0);
  }

  // Contract가 있을 때만 컨텍스트 주입
  console.log(JSON.stringify(response));
  process.exit(0);
}

main().catch((err) => {
  // Error handler - still allow operation, just log the error
  console.log(
    JSON.stringify({
      decision: 'allow',
      reason: '',
    })
  );
  // Log error to stderr for debugging (won't affect hook result)
  console.error(`[MAMA PreToolUse Error] ${err.message}`);
  process.exit(0);
});
