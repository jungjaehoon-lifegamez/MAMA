#!/usr/bin/env node
/**
 * UserPromptSubmit Hook for MAMA Plugin
 *
 * Lightweight keyword detector. Detects ultrawork/search/analyze mode
 * keywords in user prompts and injects behavior mode instructions.
 *
 * @module userpromptsubmit-hook
 */

const path = require('path');
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const _CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');

function getEnabledFeatures() {
  const isDaemon = process.env.MAMA_DAEMON === '1';
  const disableAll = process.env.MAMA_DISABLE_HOOKS === 'true';
  const featuresEnv = process.env.MAMA_HOOK_FEATURES;
  if (disableAll) {
    return new Set();
  }
  if (!isDaemon) {
    return new Set(['memory', 'keywords', 'rules', 'agents', 'contracts']);
  }
  if (!featuresEnv) {
    return new Set();
  }
  return new Set(featuresEnv.split(',').map((f) => f.trim().toLowerCase()));
}

const KEYWORD_DETECTORS = [
  {
    type: 'ultrawork',
    patterns: [/\bultrawork\b/i, /\bulw\b/i, /\[ultrawork\]/i, /\[ulw\]/i, /\[ulw-loop\]/i],
    message: `[ultrawork-mode]
ULTRAWORK MODE ACTIVATED. Maximum precision required.
- Absolute certainty before every action
- Exploration is MANDATORY, not optional
- Research before implementing
- Verify everything, assume nothing
- Quality over speed, always
</ultrawork-mode>`,
  },
  {
    type: 'search',
    patterns: [
      /\bsearch[- ]mode\b/i,
      /\[search[- ]?mode\]/i,
      /\bfind\b.*\b(all|every|across)\b/i,
      /\bexplore\b.*\b(codebase|project|repo)\b/i,
    ],
    message: `[search-mode]
SEARCH MODE. Gather context before acting:
- Fire 1-2 explore agents for codebase patterns
- Fire librarian agents if external libraries involved
- Use Grep, AST-grep, LSP for targeted searches
- SYNTHESIZE findings before proceeding.
</search-mode>`,
  },
  {
    type: 'analyze',
    patterns: [
      /\banalyze[- ]mode\b/i,
      /\[analyze[- ]?mode\]/i,
      /\binvestigate\b/i,
      /\bresearch\b.*\b(deep|thorough)\b/i,
      /\bdebug\b.*\b(deep|thorough)\b/i,
    ],
    message: `[analyze-mode]
ANALYSIS MODE. Gather context before diving deep:

CONTEXT GATHERING (parallel):
- 1-2 explore agents (codebase patterns, implementations)
- 1-2 librarian agents (if external library involved)
- Direct tools: Grep, AST-grep, LSP for targeted searches

IF COMPLEX - DO NOT STRUGGLE ALONE. Consult specialists:
- **Oracle**: Conventional problems (architecture, debugging, complex logic)
- **Artistry**: Non-conventional problems (different approach needed)

SYNTHESIZE findings before proceeding.
</analyze-mode>`,
  },
];

function detectKeywords(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  // Remove code blocks to prevent false positives
  const cleanText = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
  const detected = [];
  for (const detector of KEYWORD_DETECTORS) {
    for (const pattern of detector.patterns) {
      if (pattern.test(cleanText)) {
        detected.push(detector);
        break;
      }
    }
  }
  return detected;
}

// Export for testing
module.exports = { detectKeywords, KEYWORD_DETECTORS, getEnabledFeatures };

async function main() {
  const features = getEnabledFeatures();
  if (!features.has('keywords')) {
    process.exit(0);
  }

  // Read JSON input from stdin
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let prompt = '';
  try {
    const parsed = JSON.parse(input);
    prompt = parsed.prompt || '';
  } catch {
    // If not JSON, treat entire input as prompt text
    prompt = input.trim();
  }

  if (!prompt) {
    process.exit(0);
  }

  const detected = detectKeywords(prompt);
  if (detected.length === 0) {
    process.exit(0);
  }

  const messages = detected.map((d) => d.message);
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: messages.join('\n\n---\n\n'),
    },
  };

  console.log(JSON.stringify(output));
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}
