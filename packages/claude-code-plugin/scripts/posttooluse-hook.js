#!/usr/bin/env node
/**
 * PostToolUse Hook for MAMA Plugin
 *
 * Redesigned Feb 2026:
 * - Lightweight reminder for future Claude sessions
 * - No pattern detection - Claude decides what's worth saving
 * - Purpose-driven hint, not intrusive prompt
 */

const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
require('module').globalPaths.push(CORE_PATH);
const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));
const { shouldProcessFile } = require('./hook-file-filter');
const { isFirstEdit, markFileEdited } = require('./session-state');

// Tools that trigger the reminder
const CODE_TOOLS = new Set(['Edit', 'Write']);

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
    const features = getEnabledFeatures();
    if (!features.has('contracts')) {
      process.exit(0);
    }

    const input = await readStdin();

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

    // Only show reminder on first edit of this file per session
    if (!isFirstEdit(filePath)) {
      process.exit(0);
    }

    // Mark file as edited
    markFileEdited(filePath);

    // Use exit(2) + stderr for visibility to Claude (per hook protocol)
    console.error(`
💡 **Reminder**: If this change contains decisions future Claude sessions should know:
   \`/mama:decision topic="<module>_<what>" decision="<why this approach>"\`
   Include file paths in reasoning for better matching on Read.
`);
    process.exit(2);
  } catch {
    process.exit(0);
  }
}

main().catch(() => {
  process.exit(0);
});
