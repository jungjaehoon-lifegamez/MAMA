#!/usr/bin/env node
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

function extractDecisionPatterns(text) {
  const patterns = [];

  const decisionRegex = /(?:decided|decision|chose|선택|결정)[:：]\s*(.+)/gi;
  let match;
  while ((match = decisionRegex.exec(text)) !== null) {
    patterns.push(match[1].trim().slice(0, 200));
  }

  const architectureRegex = /(?:architecture|approach|strategy|설계|방식)[:：]\s*(.+)/gi;
  while ((match = architectureRegex.exec(text)) !== null) {
    patterns.push(match[1].trim().slice(0, 200));
  }

  return patterns;
}

module.exports = { getEnabledFeatures, extractDecisionPatterns };

async function main() {
  const features = getEnabledFeatures();
  if (!features.has('memory')) {
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

  const agentType = parsed.agent_type || 'unknown';
  const transcriptPath = parsed.transcript_path || '';

  if (!transcriptPath) {
    process.exit(0);
  }

  const fs = require('fs');
  let lastMessages = '';
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');
    const recentLines = lines.slice(-5);
    lastMessages = recentLines
      .map((line) => {
        try {
          const msg = JSON.parse(line);
          return msg.content || msg.text || '';
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n');
  } catch {
    process.exit(0);
  }

  if (!lastMessages) {
    process.exit(0);
  }

  const decisions = extractDecisionPatterns(lastMessages);

  if (decisions.length === 0) {
    process.exit(0);
  }

  const summary = decisions.map((d, i) => `${i + 1}. ${d}`).join('\n');

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SubagentStop',
      additionalContext: `[Subagent ${agentType} completed]\nDetected decisions:\n${summary}\n\nConsider saving these to MAMA if they represent important architectural choices.`,
    },
  };

  console.log(JSON.stringify(output));
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}
