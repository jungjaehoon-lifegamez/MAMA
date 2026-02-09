#!/usr/bin/env node
/**
 * Stop Hook - Auto-Continuation Detection
 *
 * Ported from standalone's stop-continuation-handler.ts.
 * Detects incomplete responses and suggests continuation.
 *
 * Detection heuristics:
 * 1. Explicit continuation patterns (English + Korean)
 * 2. Truncation: response >= 1800 chars without terminal punctuation
 * 3. Completion markers in last 3 lines: DONE, FINISHED, TASK_COMPLETE
 *
 * Safety: max 3 retries per session, recursion guard via stop_hook_active flag.
 *
 * stdin: { session_id, transcript_path }
 * stdout: { decision: "block", reason: "..." } or exit(0)
 */

const path = require('path');
const fs = require('fs');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));

// Patterns that suggest a response is incomplete
const INCOMPLETE_PATTERNS = [
  /I'll continue/i,
  /계속하겠/,
  /계속할게/,
  /to be continued/i,
  /let me continue/i,
  /이어서/,
  /다음으로/,
];

// Completion markers (checked in last 3 lines, case-insensitive)
const COMPLETION_MARKERS = ['done', 'finished', '✅', 'task_complete'];

// Minimum length to trigger truncation heuristic
const TRUNCATION_LENGTH_THRESHOLD = 1800;

// Terminal punctuation that indicates a sentence ended normally
const TERMINAL_PUNCTUATION = '.!?。！？…';

// Lines from the end of response to check for completion markers
const COMPLETION_CHECK_LINES = 3;

// Maximum continuation retries per session
const MAX_RETRIES = 3;

// Context length for continuation prompt
const CONTINUATION_CONTEXT_LENGTH = 200;

// Session state file for tracking retry counts
const STATE_FILE = path.join(PLUGIN_ROOT, '.stop-hook-state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {
    // ignore
  }
  return { retries: 0, sessionId: null };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch {
    // ignore
  }
}

function hasCompletionMarker(response) {
  const lines = response.split('\n');
  const lastLines = lines.slice(-COMPLETION_CHECK_LINES).join('\n').toLowerCase();
  return COMPLETION_MARKERS.some((marker) => lastLines.includes(marker));
}

function isIncomplete(response) {
  // Check explicit continuation patterns
  for (const pattern of INCOMPLETE_PATTERNS) {
    if (pattern.test(response)) {
      return true;
    }
  }

  // Check truncation heuristic
  if (response.length >= TRUNCATION_LENGTH_THRESHOLD) {
    const trimmed = response.trimEnd();
    const lastChar = trimmed[trimmed.length - 1];
    if (lastChar && !TERMINAL_PUNCTUATION.includes(lastChar)) {
      return true;
    }
  }

  return false;
}

function buildContinuationPrompt(response) {
  const tail =
    response.length > CONTINUATION_CONTEXT_LENGTH
      ? response.slice(-CONTINUATION_CONTEXT_LENGTH)
      : response;

  return (
    `Continue from where you left off. Your previous response ended with:\n` +
    `---\n` +
    `${tail}\n` +
    `---\n` +
    `Continue the task. When done, end your response with "DONE" or "FINISHED" or "TASK_COMPLETE".`
  );
}

function getLastAssistantMessage(transcriptPath) {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');

    // Walk backwards to find last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.role === 'assistant') {
          // Extract text content
          if (typeof msg.content === 'string') {
            return msg.content;
          }
          if (Array.isArray(msg.content)) {
            const textParts = msg.content.filter((p) => p.type === 'text').map((p) => p.text);
            return textParts.join('\n');
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return '';
}

module.exports = {
  handler: main,
  main,
  isIncomplete,
  hasCompletionMarker,
  buildContinuationPrompt,
  INCOMPLETE_PATTERNS,
  COMPLETION_MARKERS,
};

async function main() {
  const features = getEnabledFeatures();
  if (!features.has('memory')) {
    process.exit(0);
  }

  // Recursion guard
  if (process.env.MAMA_STOP_HOOK_ACTIVE === '1') {
    process.exit(0);
  }

  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const sessionId = parsed.session_id || process.env.CLAUDE_SESSION_ID || 'default';
  const transcriptPath = parsed.transcript_path || '';

  if (!transcriptPath) {
    process.exit(0);
  }

  // Load state and check session
  const state = loadState();
  if (state.sessionId !== sessionId) {
    state.sessionId = sessionId;
    state.retries = 0;
  }

  // Max retries safety valve
  if (state.retries >= MAX_RETRIES) {
    saveState(state);
    process.exit(0);
  }

  // Get last assistant message from transcript
  const lastResponse = getLastAssistantMessage(transcriptPath);
  if (!lastResponse) {
    process.exit(0);
  }

  // Check completion markers first - if complete, reset and exit
  if (hasCompletionMarker(lastResponse)) {
    state.retries = 0;
    saveState(state);
    process.exit(0);
  }

  // Check if response is incomplete
  if (!isIncomplete(lastResponse)) {
    state.retries = 0;
    saveState(state);
    process.exit(0);
  }

  // Response looks incomplete - suggest continuation
  state.retries += 1;
  saveState(state);

  const continuationPrompt = buildContinuationPrompt(lastResponse);

  const output = {
    decision: 'block',
    reason: continuationPrompt,
  };

  console.log(JSON.stringify(output));
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}
