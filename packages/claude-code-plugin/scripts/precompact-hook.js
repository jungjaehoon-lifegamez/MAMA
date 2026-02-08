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

function extractUnsavedDecisions(transcript) {
  const lines = transcript.trim().split('\n');
  const decisions = [];
  const savedTopics = new Set();

  for (const line of lines) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    const text = msg.content || msg.text || '';

    if (text.includes('mama_save') || text.includes('Decision saved')) {
      const topicMatch = text.match(/topic["':\s]+(\w+)/);
      if (topicMatch) {
        savedTopics.add(topicMatch[1]);
      }
    }

    const decisionPatterns = [
      /(?:decided|decision|chose|we'll use|going with|선택|결정)[:：]?\s*(.{10,200})/gi,
      /(?:approach|architecture|strategy|설계|방식)[:：]\s*(.{10,200})/gi,
    ];

    for (const pattern of decisionPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const candidate = match[1].trim();
        if (candidate.length >= 10 && !savedTopics.has(candidate.slice(0, 30))) {
          decisions.push(candidate);
        }
      }
    }
  }

  const uniqueDecisions = [...new Set(decisions)];
  return uniqueDecisions.slice(-5);
}

module.exports = { getEnabledFeatures, extractUnsavedDecisions };

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

  const transcriptPath = parsed.transcript_path || '';
  if (!transcriptPath) {
    process.exit(0);
  }

  const fs = require('fs');
  let transcript = '';
  try {
    transcript = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    process.exit(0);
  }

  const unsaved = extractUnsavedDecisions(transcript);

  if (unsaved.length === 0) {
    process.exit(0);
  }

  const summary = unsaved.map((d, i) => `${i + 1}. ${d}`).join('\n');

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreCompact',
      additionalContext: `[MAMA PreCompact Warning]\nContext is about to be compressed. ${unsaved.length} potential unsaved decision(s) detected:\n${summary}\n\nIMPORTANT: Use mama_save to persist any important decisions before they are lost to compaction.`,
    },
  };

  console.log(JSON.stringify(output));
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}
