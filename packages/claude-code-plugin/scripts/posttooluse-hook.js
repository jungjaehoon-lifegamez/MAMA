#!/usr/bin/env node
/**
 * PostToolUse Hook for MAMA Plugin
 *
 * Redesigned Feb 2025:
 * - Detects contract-like patterns in code changes
 * - Only prompts when significant patterns found
 * - No auto-save, LLM decides what to save
 *
 * Contract patterns detected:
 * - Interface/type definitions
 * - Function signatures with explicit types
 * - API endpoint definitions
 * - expects/returns patterns
 */

const path = require('path');

// Tools that trigger pattern detection
const CODE_TOOLS = new Set(['Edit', 'Write']);

// Code file extensions
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
]);

// Files to skip (config, docs, tests)
const SKIP_PATTERNS = [
  /\.md$/i,
  /\.txt$/i,
  /\.json$/i,
  /\.ya?ml$/i,
  /\.toml$/i,
  /\.ini$/i,
  /\.env/i,
  /\.lock$/i,
  /\.gitignore$/i,
  /LICENSE/i,
  /README/i,
  /\/test[s]?\//i,
  /\.test\./i,
  /\.spec\./i,
  /\/docs?\//i,
  /\/examples?\//i,
];

// Contract-like patterns in code
const CONTRACT_PATTERNS = [
  // TypeScript/JavaScript
  { pattern: /^export\s+(interface|type)\s+\w+/m, name: 'interface/type' },
  { pattern: /^export\s+(async\s+)?function\s+\w+\s*\([^)]*\)\s*:/m, name: 'typed function' },
  { pattern: /^export\s+const\s+\w+\s*:\s*\w+/m, name: 'typed export' },

  // API patterns
  { pattern: /@(api|endpoint|route|get|post|put|delete|patch)/im, name: 'API decorator' },
  { pattern: /\.(get|post|put|delete|patch)\s*\(\s*['"`]/m, name: 'route handler' },

  // Contract documentation
  { pattern: /expects\s*[:=]\s*\{/i, name: 'expects clause' },
  { pattern: /returns\s*[:=]\s*\{/i, name: 'returns clause' },
  { pattern: /@param\s+\{\w+\}/m, name: 'JSDoc param' },
  { pattern: /@returns?\s+\{\w+\}/m, name: 'JSDoc return' },

  // Python
  { pattern: /^def\s+\w+\s*\([^)]*\)\s*->/m, name: 'typed Python function' },
  { pattern: /^class\s+\w+\s*\([^)]*\)\s*:/m, name: 'Python class' },

  // Go
  { pattern: /^type\s+\w+\s+(struct|interface)\s*\{/m, name: 'Go type' },
  { pattern: /^func\s+\([^)]+\)\s+\w+\s*\([^)]*\)\s*\(?[^{]*/m, name: 'Go method' },
];

function shouldProcessFile(filePath) {
  if (!filePath) {
    return false;
  }

  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(filePath)) {
      return false;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

/**
 * Detect contract-like patterns in code
 * Returns array of detected pattern names
 */
function detectContractPatterns(code) {
  if (!code || typeof code !== 'string') {
    return [];
  }

  const detected = [];
  for (const { pattern, name } of CONTRACT_PATTERNS) {
    if (pattern.test(code)) {
      detected.push(name);
    }
  }
  return detected;
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

async function main() {
  try {
    const input = await readStdin();

    // Support both stdin and environment variables for backward compatibility
    const toolName = input.tool_name || input.toolName || process.env.TOOL_NAME || '';
    const toolInput = input.tool_input || {};
    const filePath = toolInput.file_path || input.filePath || process.env.FILE_PATH || '';

    // Only process code editing tools
    if (!CODE_TOOLS.has(toolName)) {
      process.exit(0);
    }

    // Only process code files
    if (!shouldProcessFile(filePath)) {
      process.exit(0);
    }

    // Get the code being written/edited (stdin only - env vars don't carry content)
    const newCode = toolInput.new_string || toolInput.content || process.env.DIFF_CONTENT || '';

    // Detect contract patterns
    const patterns = detectContractPatterns(newCode);

    if (patterns.length === 0) {
      // No contract patterns - silent pass
      process.exit(0);
    }

    // Found contract patterns - prompt for review
    const patternList = patterns.slice(0, 3).join(', ');
    const fileName = path.basename(filePath);

    const response = {
      decision: 'allow',
      message: `\n💡 **Contract patterns detected** in ${fileName}: ${patternList}\n   Consider saving with \`/mama:decision\` if this is an important interface.\n`,
    };

    console.error(JSON.stringify(response));
    process.exit(2);
  } catch {
    process.exit(0);
  }
}

main();
