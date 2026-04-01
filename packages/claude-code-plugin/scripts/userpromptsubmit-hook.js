#!/usr/bin/env node
/**
 * UserPromptSubmit Hook — Memory Agent Ingestion (v2)
 *
 * Reads the session transcript to capture full conversation context,
 * not just the current prompt. Sends recent exchanges to memory agent.
 *
 * stdin: { prompt, transcript_path, session_id, cwd, ... }
 * stdout: { continue: true }
 */

const path = require('path');
const fs = require('fs');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));
const {
  isMamaOsRunning,
  postToMemoryAgent,
  parseTranscriptMessages,
} = require('./memory-agent-client');

// How many recent message pairs to send to memory agent
const MAX_RECENT_PAIRS = 5;

function flushAndExit(json, code = 0, delayMs = 0) {
  const data = typeof json === 'string' ? json : JSON.stringify(json);
  const exit = () => setTimeout(() => process.exit(code), delayMs);
  if (process.stdout.write(data + '\n')) {
    exit();
  } else {
    process.stdout.once('drain', exit);
    setTimeout(() => process.exit(code), delayMs + 200);
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;
    const done = (result) => {
      if (resolved) {
        return;
      }
      resolved = true;
      process.stdin.removeAllListeners();
      resolve(result);
    };
    // Absolute deadline — not reset on data chunks
    const timeout = setTimeout(() => done({}), 500);
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      try {
        done(data ? JSON.parse(data) : {});
      } catch {
        done({});
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(timeout);
      done({});
    });
  });
}

/**
 * Read recent conversation from transcript JSONL file.
 * Delegates to shared parseTranscriptMessages for consistent parsing.
 */
function readRecentTranscript(transcriptPath, maxPairs) {
  if (!transcriptPath) {
    return [];
  }
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    return parseTranscriptMessages(content, maxPairs);
  } catch {
    return [];
  }
}

async function main() {
  const features = getEnabledFeatures();
  if (!features.has('memory')) {
    flushAndExit({ continue: true });
    return;
  }

  const input = await readStdin();
  const userPrompt = input.prompt || input.user_prompt || '';
  const response = { continue: true };

  if (!userPrompt) {
    flushAndExit(response);
    return;
  }

  const running = await isMamaOsRunning();
  if (!running) {
    flushAndExit(response);
    return;
  }

  const projectPath = input.cwd || process.env.CLAUDE_PROJECT_PATH || process.cwd();
  const transcriptPath = input.transcript_path || '';

  // Flush any pending PostToolUse batch from previous turn (session-isolated)
  const os = require('os');
  const ppid = process.ppid || process.pid;
  const batchFile = path.join(os.tmpdir(), `mama-posttooluse-batch-${ppid}.jsonl`);
  try {
    const batchContent = fs.readFileSync(batchFile, 'utf8');
    fs.unlinkSync(batchFile);
    const entries = batchContent
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l).entry;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (entries.length > 0) {
      const combined = entries.join('\n---\n');
      postToMemoryAgent(
        [{ role: 'assistant', content: combined }],
        projectPath,
        'posttooluse-batch'
      );
    }
  } catch {
    /* no pending batch */
  }

  // Read recent conversation from transcript (full context!)
  const recentMessages = readRecentTranscript(transcriptPath, MAX_RECENT_PAIRS);

  if (recentMessages.length > 0) {
    // Send transcript-based context (includes assistant responses)
    postToMemoryAgent(recentMessages, projectPath, 'userpromptsubmit-transcript');
  } else {
    // Fallback: send just the current prompt
    postToMemoryAgent([{ role: 'user', content: userPrompt }], projectPath, 'userpromptsubmit');
  }

  // Delay exit to allow HTTP requests to flush
  flushAndExit(response, 0, 150);
}

process.on('SIGTERM', () => flushAndExit({ continue: true }));
process.on('SIGINT', () => flushAndExit({ continue: true }));
process.on('uncaughtException', () => flushAndExit({ continue: true }));
process.on('unhandledRejection', () => flushAndExit({ continue: true }));

if (require.main === module) {
  main().catch(() => {
    flushAndExit({ continue: true });
  });
}

module.exports = { main, readRecentTranscript };
