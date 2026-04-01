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
const { isMamaOsRunning, postToMemoryAgent } = require('./memory-agent-client');

// How many recent message pairs to send to memory agent
const MAX_RECENT_PAIRS = 5;

function flushAndExit(json, code = 0) {
  const data = typeof json === 'string' ? json : JSON.stringify(json);
  if (process.stdout.write(data + '\n')) {
    process.exit(code);
  } else {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 200);
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timeout = setTimeout(() => resolve({}), 2000);
    process.stdin.on('data', (chunk) => {
      clearTimeout(timeout);
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(timeout);
      resolve({});
    });
  });
}

/**
 * Read recent conversation from transcript JSONL file.
 * Extracts user + assistant text messages (skips thinking, tool_use, system).
 */
function readRecentTranscript(transcriptPath, maxPairs) {
  if (!transcriptPath) {
    return [];
  }

  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }

  const messages = [];
  const lines = content.trim().split('\n');

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = entry.type;
    if (type === 'user') {
      // User message: content is plain string or in message.content
      const text = typeof entry.content === 'string' ? entry.content : entry.message?.content || '';
      if (text && text.length > 2) {
        messages.push({ role: 'user', content: text.slice(0, 2000) });
      }
    } else if (type === 'assistant') {
      // Assistant message: content is array of blocks, extract text blocks only
      const blocks = Array.isArray(entry.content) ? entry.content : entry.message?.content || [];
      const textParts = [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        }
      }
      const text = textParts.join('\n');
      if (text && text.length > 5) {
        messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      }
    }
    // Skip: system, thinking, tool_use, tool_result, file-history-snapshot
  }

  // Return last N pairs
  const limit = maxPairs * 2;
  return messages.slice(-limit);
}

async function main() {
  const features = getEnabledFeatures();
  if (features.size === 0) {
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

  // Flush any pending PostToolUse batch from previous turn
  const BATCH_FILE = '/tmp/mama-posttooluse-batch.json';
  try {
    const batch = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));
    fs.unlinkSync(BATCH_FILE);
    if (batch.entries && batch.entries.length > 0) {
      const combined = batch.entries.join('\n---\n');
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

  flushAndExit(response);
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
