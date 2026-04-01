#!/usr/bin/env node
/**
 * PreToolUse Hook — Decision Context Injection + Read Tracking
 *
 * Before file Read:
 * 1. Show related decisions from MAMA (first read per file)
 * 2. Notify memory agent that agent is reading this file (lightweight context)
 *
 * The read-tracking helps memory agent understand WHY subsequent edits happen.
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
// memory-agent-client available but PreToolUse is read-only (no ingest)

const SIMILARITY_THRESHOLD = 0.6;
const SEARCH_LIMIT = 3;
const READ_TOOLS = new Set(['Read']);

function buildSearchQuery(filePath) {
  if (!filePath) {
    return '';
  }
  const fileName = path.basename(filePath, path.extname(filePath));
  const tokens = fileName.split(/[-_]/).filter((t) => t.length >= 2);
  tokens.push(fileName);
  return [...new Set(tokens)].join(' ');
}

function formatDecision(item) {
  const topic = item.topic || 'unknown';
  const decision = item.decision || '';
  const outcome = item.outcome || 'pending';
  const similarity = item.similarity ? Math.round(item.similarity * 100) : 0;
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

  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }

  let input = {};
  try {
    input = JSON.parse(data);
  } catch {
    /* stdin may be empty */
  }

  const toolName = input.tool_name || process.env.TOOL_NAME || '';
  if (!READ_TOOLS.has(toolName)) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path || process.env.FILE_PATH || '';
  if (!shouldProcessFile(filePath)) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  // Only process first read per file per session
  if (!isFirstEdit(filePath)) {
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  // Test mode: skip embeddings
  if (process.env.MAMA_FORCE_TIER_3 === 'true') {
    markFileEdited(filePath);
    console.error(JSON.stringify({ decision: 'allow', reason: '' }));
    process.exit(0);
  }

  // Note: Read events are too frequent for memory agent ingestion.
  // Context is captured via PostToolUse (Edit/Write) and UserPromptSubmit instead.

  try {
    await initDB();
    const searchQuery = buildSearchQuery(filePath);
    const embedding = await generateEmbedding(searchQuery);

    if (!embedding) {
      markFileEdited(filePath);
      console.error(JSON.stringify({ decision: 'allow', reason: '' }));
      process.exit(0);
    }

    const results = await vectorSearch(embedding, SEARCH_LIMIT * 2, SIMILARITY_THRESHOLD);

    if (!results || results.length === 0) {
      markFileEdited(filePath);
      console.error(JSON.stringify({ decision: 'allow', reason: '' }));
      process.exit(0);
    }

    const relevant = results
      .filter((r) => r.similarity >= SIMILARITY_THRESHOLD)
      .slice(0, SEARCH_LIMIT);

    if (relevant.length === 0) {
      markFileEdited(filePath);
      console.error(JSON.stringify({ decision: 'allow', reason: '' }));
      process.exit(0);
    }

    const fileName = path.basename(filePath);
    const formatted = relevant.map(formatDecision).join('\n\n');
    const message = `🧠 **Related Decisions** for \`${fileName}\`\n\n${formatted}\n\nUse \`/mama:search <query>\` for more context.`;

    markFileEdited(filePath);
    console.error(message);
    process.exit(2);
  } catch {
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
