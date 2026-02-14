#!/usr/bin/env node
/**
 * PreToolUse Hook for MAMA Plugin
 *
 * Redesigned Feb 2025:
 * - High threshold (0.85) for relevance
 * - First-edit-only: Show contracts only on first edit per session
 * - Module context matching for better relevance
 * - Silent pass when no contracts found (no noise)
 *
 * FLOW:
 * 1. Edit/Write detected → check if first edit in session
 * 2. First edit: Search MAMA for relevant contract_* entries
 * 3. Found relevant: Show as reference, mark shown
 * 4. Not found or repeat edit: Silent pass
 */

const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
require('module').globalPaths.push(CORE_PATH);

const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));
const { vectorSearch, initDB } = require('@jungjaehoon/mama-core/memory-store');
const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
const { isFirstEdit, markFileEdited, markContractsShown } = require('./session-state');
const { shouldProcessFile } = require('./hook-file-filter');

// Threshold for relevance (lowered from 0.85 to show more decisions)
const SIMILARITY_THRESHOLD = 0.75;
const SEARCH_LIMIT = 3;

// Tools that need contract check
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * Extract module tokens from file path for context matching
 * e.g., "packages/mama-core/src/db-manager.ts" → ["mama-core", "db", "manager"]
 */
function extractModuleTokens(filePath) {
  if (!filePath) {
    return [];
  }

  const normalized = filePath.toLowerCase().replace(/\\/g, '/');
  const parts = normalized.split('/');
  const tokens = new Set();

  // Extract meaningful tokens from path segments
  for (const part of parts) {
    // Skip common non-meaningful segments
    if (['src', 'lib', 'dist', 'build', 'node_modules', 'packages'].includes(part)) {
      continue;
    }

    // Split by common separators
    const subParts = part.replace(/\.[^.]+$/, '').split(/[-_]/);
    for (const sub of subParts) {
      if (sub.length >= 2) {
        tokens.add(sub);
      }
    }
  }

  return Array.from(tokens);
}

/**
 * Check if contract topic has overlap with file module tokens
 */
function hasModuleOverlap(contractTopic, moduleTokens) {
  if (!contractTopic || moduleTokens.length === 0) {
    return false;
  } // Allow if no tokens

  const topicLower = contractTopic.toLowerCase();
  return moduleTokens.some((token) => topicLower.includes(token));
}

/**
 * Format decision for display
 */
function formatDecision(item) {
  const topic = item.topic || 'unknown';
  const decision = item.decision || '';
  const outcome = item.outcome || 'pending';
  const similarity = item.similarity ? Math.round(item.similarity * 100) : 0;

  // Truncate decision to ~80 chars for teaser
  const shortDecision = decision.length > 80 ? decision.slice(0, 77) + '...' : decision;
  const outcomeIcon = outcome === 'SUCCESS' ? '✅' : outcome === 'FAILED' ? '❌' : '⏳';

  return `${outcomeIcon} **${topic}** (${similarity}%)\n   ${shortDecision}`;
}

async function main() {
  const features = getEnabledFeatures();
  if (!features.has('contracts')) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  // Read stdin
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }

  let input = {};
  try {
    input = JSON.parse(data);
  } catch {
    // No input
  }

  // Support both stdin and environment variables for backward compatibility
  const toolName = input.tool_name || process.env.TOOL_NAME || '';

  // Only process write tools
  if (!WRITE_TOOLS.has(toolName)) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path || process.env.FILE_PATH || '';

  // Skip non-code files
  if (!shouldProcessFile(filePath)) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  // Only show contracts on FIRST edit of this file in session
  if (!isFirstEdit(filePath)) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  // Extract module tokens for context matching
  const moduleTokens = extractModuleTokens(filePath);
  const fileName = path.basename(filePath, path.extname(filePath));

  try {
    await initDB();

    // Build search query from file context
    const searchQuery = [...moduleTokens, fileName].join(' ');
    const embedding = await generateEmbedding(searchQuery);

    if (!embedding) {
      console.error(JSON.stringify({ decision: 'allow', reason: '' }));
      process.exit(0);
    }

    // Search for contracts
    const results = await vectorSearch(embedding, SEARCH_LIMIT * 2, SIMILARITY_THRESHOLD);

    if (!results || results.length === 0) {
      // No contracts found - mark file as processed and silent pass
      markFileEdited(filePath);
      console.error(JSON.stringify({ decision: 'allow', reason: '' }));
      process.exit(0);
    }

    // Filter: all decisions above threshold with module overlap
    const relevant = results.filter((r) => {
      if (r.similarity < SIMILARITY_THRESHOLD) {
        return false;
      }
      // Check module overlap for relevance
      return hasModuleOverlap(r.topic, moduleTokens);
    });

    if (relevant.length === 0) {
      // No relevant decisions - mark file as processed and silent pass
      markFileEdited(filePath);
      console.error(JSON.stringify({ decision: 'allow', reason: '' }));
      process.exit(0);
    }

    // Format output - show past decisions related to this code
    const formatted = relevant.slice(0, SEARCH_LIMIT).map(formatDecision).join('\n\n');
    const message = `\n🧠 **Related Decisions** (${fileName})\n\n${formatted}\n`;

    // Mark file as processed and that decisions were shown
    markFileEdited(filePath);
    markContractsShown(filePath);

    const response = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Related decisions provided',
        additionalContext: message,
      },
    };
    console.log(JSON.stringify(response));
    process.exit(0);
  } catch (err) {
    // Error - silent pass
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  });
}

module.exports = { handler: main, main };
