#!/usr/bin/env node
/**
 * PostToolUse Hook — Agent Action Ingestion
 *
 * After Edit/Write: sends agent's action to memory agent for decision extraction.
 * Also shows reminder on first edit per file.
 */

const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
require('module').globalPaths.push(CORE_PATH);
const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));
const { shouldProcessFile } = require('./hook-file-filter');
const { isFirstEdit, markFileEdited } = require('./session-state');
const { isMamaOsRunning, postToMemoryAgent } = require('./memory-agent-client');

const CODE_TOOLS = new Set(['Edit', 'Write']);

// Debounce: collect edits via append-only lines (one JSON line per entry).
// Session-isolated via PID of parent process (Claude Code session).
const DEBOUNCE_WINDOW_MS = 5000;

function getBatchFile() {
  const os = require('os');
  const ppid = process.ppid || process.pid;
  return path.join(os.tmpdir(), `mama-posttooluse-batch-${ppid}.jsonl`);
}

function appendToBatch(entry) {
  const fs = require('fs');
  const batchFile = getBatchFile();
  const line = JSON.stringify({ entry, ts: Date.now() }) + '\n';
  // Append-only: no read-modify-write race condition
  fs.appendFileSync(batchFile, line);
  // Count lines to determine batch size
  try {
    const content = fs.readFileSync(batchFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    // Expire old entries beyond debounce window
    const now = Date.now();
    const active = lines.filter((l) => {
      try {
        return now - JSON.parse(l).ts < DEBOUNCE_WINDOW_MS;
      } catch {
        return false;
      }
    });
    return active.length;
  } catch {
    return 1;
  }
}

function flushBatch() {
  const fs = require('fs');
  const batchFile = getBatchFile();
  try {
    const content = fs.readFileSync(batchFile, 'utf8');
    fs.unlinkSync(batchFile);
    return content
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
  } catch {
    return [];
  }
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

/**
 * Build a concise description of the agent's action for memory ingestion.
 */
function buildActionSummary(toolName, toolInput) {
  const filePath = toolInput.file_path || toolInput.filePath || '';
  const fileName = filePath ? path.basename(filePath) : 'unknown file';

  if (toolName === 'Edit') {
    const oldStr = (toolInput.old_string || '').slice(0, 200);
    const newStr = (toolInput.new_string || '').slice(0, 200);
    return `Agent edited ${fileName} (${filePath}):\n- Replaced: ${oldStr}\n- With: ${newStr}`;
  }

  if (toolName === 'Write') {
    const contentPreview = (toolInput.content || '').slice(0, 300);
    return `Agent wrote ${fileName} (${filePath}):\n${contentPreview}`;
  }

  return `Agent used ${toolName} on ${fileName}`;
}

async function main() {
  try {
    const features = getEnabledFeatures();
    if (!features.has('memory')) {
      process.exit(0);
    }

    const input = await readStdin();
    const toolName = input.tool_name || input.toolName || process.env.TOOL_NAME || '';
    const toolInput = input.tool_input || {};
    const filePath = toolInput.file_path || input.filePath || process.env.FILE_PATH || '';

    // Relay mama_save decisions to MAMA OS (Connector C pattern)
    if (toolName.includes('mama__save') && toolInput.type === 'decision') {
      const running = await isMamaOsRunning();
      if (running) {
        const projectPath = process.env.CLAUDE_PROJECT_PATH || process.cwd();
        const topic = toolInput.topic || 'unknown';
        const decision = toolInput.decision || '';
        const reasoning = toolInput.reasoning || '';
        const content = `[mama_save] topic=${topic}\ndecision: ${decision}\nreasoning: ${reasoning}`;
        await postToMemoryAgent([{ role: 'user', content }], projectPath, 'posttooluse-mama-save');
      }
      process.exit(0);
    }

    if (!CODE_TOOLS.has(toolName)) {
      process.exit(0);
    }

    if (!shouldProcessFile(filePath)) {
      process.exit(0);
    }

    // Debounce: collect edits, send as batch when window expires
    const summary = buildActionSummary(toolName, toolInput);
    const batchSize = appendToBatch(summary);

    // Flush batch: >= 3 edits triggers immediate send.
    // < 3 edits are flushed by UserPromptSubmit (next prompt) or PreCompact (session end).
    if (batchSize >= 3) {
      const running = await isMamaOsRunning();
      if (running) {
        const entries = flushBatch();
        const projectPath = process.env.CLAUDE_PROJECT_PATH || process.cwd();
        const combined = entries.join('\n---\n');
        await postToMemoryAgent(
          [{ role: 'assistant', content: combined }],
          projectPath,
          'posttooluse-batch'
        );
      }
    }

    // Show reminder only on first edit per file per session
    if (isFirstEdit(filePath)) {
      markFileEdited(filePath);
      console.error(
        `\n` +
          `💡 **Reminder**: If this change contains decisions future Claude sessions should know:\n` +
          `   \`/mama:decision topic="<module>_<what>" decision="<why this approach>"\`\n` +
          `   Include file paths in reasoning for better matching on Read.\n`
      );
      process.exit(2);
    }

    process.exit(0);
  } catch {
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
