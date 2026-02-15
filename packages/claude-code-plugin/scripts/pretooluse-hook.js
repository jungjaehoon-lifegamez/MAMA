#!/usr/bin/env node
/**
 * PreToolUse Hook for MAMA Plugin
 *
 * Redesigned Feb 2026:
 * - Triggers on Read (before file is viewed)
 * - Shows related decisions on first read per session
 * - Helps Claude understand context before making changes
 * - Silent pass when no decisions found (no noise)
 *
 * FLOW:
 * 1. Read detected → check if first read in session
 * 2. First read: Search MAMA for related decisions
 * 3. Found relevant: Show as context
 * 4. Not found or repeat read: Silent pass
 */

const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
require('module').globalPaths.push(CORE_PATH);

const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));
const { vectorSearch, initDB } = require('@jungjaehoon/mama-core/memory-store');
const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
const { isFirstEdit, markFileEdited } = require('./session-state');
const { shouldProcessFile } = require('./hook-file-filter');

// Threshold for relevance (documented: 60% in SKILL.md)
const SIMILARITY_THRESHOLD = 0.6;
const SEARCH_LIMIT = 3;

// Tools that trigger decision lookup
const READ_TOOLS = new Set(['Read']);

/**
 * Build search query from file path
 * Focus on filename tokens only - path segments add noise to embeddings
 */
function buildSearchQuery(filePath) {
  if (!filePath) {
    return '';
  }

  // Extract filename without extension
  const fileName = path.basename(filePath, path.extname(filePath));

  // Split by common separators (kebab-case, snake_case)
  const tokens = fileName.split(/[-_]/).filter((t) => t.length >= 2);

  // Add full filename for exact matches
  tokens.push(fileName);

  return [...new Set(tokens)].join(' ');
}

/**
 * Format decision for display
 */
function formatDecision(item) {
  const topic = item.topic || 'unknown';
  const decision = item.decision || '';
  const outcome = item.outcome || 'pending';
  const similarity = item.similarity ? Math.round(item.similarity * 100) : 0;

  // Truncate decision to ~100 chars for teaser
  const shortDecision = decision.length > 100 ? decision.slice(0, 97) + '...' : decision;
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

  const toolName = input.tool_name || process.env.TOOL_NAME || '';

  // Only process Read tool
  if (!READ_TOOLS.has(toolName)) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path || process.env.FILE_PATH || '';

  // Skip non-code files
  if (!shouldProcessFile(filePath)) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  // Only show decisions on FIRST read of this file in session
  if (!isFirstEdit(filePath)) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  try {
    await initDB();

    // Build search query from file path
    const searchQuery = buildSearchQuery(filePath);
    const embedding = await generateEmbedding(searchQuery);

    if (!embedding) {
      markFileEdited(filePath);
      console.error(JSON.stringify({ decision: 'allow', reason: '' }));
      process.exit(0);
    }

    // Search for related decisions
    const results = await vectorSearch(embedding, SEARCH_LIMIT * 2, SIMILARITY_THRESHOLD);

    if (!results || results.length === 0) {
      // No decisions found - mark file as processed and silent pass
      markFileEdited(filePath);
      console.error(JSON.stringify({ decision: 'allow', reason: '' }));
      process.exit(0);
    }

    // Take top results above threshold
    const relevant = results
      .filter((r) => r.similarity >= SIMILARITY_THRESHOLD)
      .slice(0, SEARCH_LIMIT);

    if (relevant.length === 0) {
      markFileEdited(filePath);
      console.error(JSON.stringify({ decision: 'allow', reason: '' }));
      process.exit(0);
    }

    // Format output
    const fileName = path.basename(filePath);
    const formatted = relevant.map(formatDecision).join('\n\n');
    const message = `🧠 **Related Decisions** for \`${fileName}\`

${formatted}

Use \`/mama:search <query>\` for more context.`;

    // Mark file as processed
    markFileEdited(filePath);

    // PreToolUse doesn't support additionalContext
    // Use exit(2) to pass context via stderr (shown as "blocking" message)
    console.error(message);
    process.exit(2);
  } catch (err) {
    // Error - silent pass
    markFileEdited(filePath);
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
