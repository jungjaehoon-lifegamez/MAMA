#!/usr/bin/env node
/**
 * PreCompact Hook — Auto-save Unsaved Decisions + Compaction Prompt
 *
 * Before context compression:
 * 1. Extract decision candidates from transcript
 * 2. Filter already-saved ones via MAMA DB
 * 3. Auto-ingest unsaved decisions to memory agent
 * 4. Output 7-section compaction prompt
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

const DECISION_PATTERNS = [
  /(?:decided|decision|chose|we'll use|going with|선택|결정)[:：]?\s*(.{10,200})/gi,
  /(?:approach|architecture|strategy|설계|방식)[:：]\s*(.{10,200})/gi,
];

const MAX_DECISIONS_TO_DETECT = 5;

function extractDecisionCandidates(transcript) {
  const lines = transcript.trim().split('\n');
  const candidates = [];
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

    for (const pattern of DECISION_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const candidate = match[1].trim();
        if (candidate.length >= 10) {
          let isAlreadySaved = false;
          for (const savedTopic of savedTopics) {
            const escaped = savedTopic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`\\b${escaped}\\b`, 'i').test(candidate)) {
              isAlreadySaved = true;
              break;
            }
          }
          if (!isAlreadySaved) {
            candidates.push(candidate);
          }
        }
      }
    }
  }

  return [...new Set(candidates)].slice(-MAX_DECISIONS_TO_DETECT);
}

async function getSavedTopicsFromDB() {
  const topics = new Set();
  try {
    const { vectorSearch, initDB } = require('@jungjaehoon/mama-core/memory-store');
    await initDB();
    const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
    const embedding = await generateEmbedding('recent decisions architecture');
    if (embedding) {
      const results = await vectorSearch(embedding, 20, 0.3);
      if (results && Array.isArray(results)) {
        for (const item of results) {
          if (item.topic) {
            topics.add(item.topic.toLowerCase());
          }
        }
      }
    }
  } catch {
    // DB not available — transcript-only analysis
  }
  return topics;
}

function filterUnsaved(candidates, savedTopics) {
  return candidates.filter((candidate) => {
    const lc = candidate.toLowerCase();
    for (const saved of savedTopics) {
      const escaped = saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(lc)) {
        return false;
      }
      const escapedCand = lc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escapedCand}\\b`, 'i').test(saved)) {
        return false;
      }
    }
    return true;
  });
}

function buildWarningMessage(unsavedDecisions) {
  if (unsavedDecisions.length === 0) {
    return '';
  }
  const summary = unsavedDecisions.map((d, i) => `${i + 1}. ${d}`).join('\n');
  return (
    `[MAMA PreCompact Warning]\n` +
    `Context is about to be compressed. ` +
    `${unsavedDecisions.length} potential unsaved decision(s) detected:\n` +
    `${summary}\n\n` +
    `IMPORTANT: Use mama_save to persist any important decisions before they are lost to compaction.`
  );
}

function buildCompactionPrompt(transcript, unsavedDecisions, agentAvailable = false) {
  const sections = [
    '## 1. User Requests\nSummarize the original user requests and requirements.\n',
    '## 2. Final Goal\nWhat does "done" look like?\n',
    '## 3. Work Completed\nList all tasks, code changes, and accomplishments.\n',
    '## 4. Remaining Tasks\nList outstanding work items.\n',
    '## 5. Active Working Context\nCurrent files, git branch, key variables, active state.\n',
    '## 6. Explicit Constraints\nRules, conventions, architectural decisions stated.\n',
    '## 7. Agent Verification State\nBuild/test/lint status, error states, verification results.\n',
  ];

  let prompt = '# Compaction Summary\n\nPreserve the following in 7 sections:\n\n';
  prompt += sections.join('\n');

  if (unsavedDecisions.length > 0) {
    const label = agentAvailable
      ? '## Unsaved Decisions (auto-ingested to memory agent)'
      : '## Unsaved Decisions';
    prompt += `\n---\n\n${label}\n\n`;
    unsavedDecisions.forEach((d, i) => {
      prompt += `${i + 1}. ${d}\n`;
    });
    prompt += '\nUse mama_save to persist any critical decisions with full reasoning.\n';
  }

  const lineCount = transcript.split('\n').length;
  prompt += `\n---\n\n_~${lineCount} lines before compaction._\n`;
  return prompt;
}

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

  let transcript = '';
  try {
    transcript = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    process.exit(0);
  }

  // Extract and filter unsaved decision candidates
  const candidates = extractDecisionCandidates(transcript);
  const savedTopics = candidates.length > 0 ? await getSavedTopicsFromDB() : new Set();
  const unsaved = candidates.length > 0 ? filterUnsaved(candidates, savedTopics) : [];

  // Auto-ingest to memory agent: send recent conversation + unsaved decisions
  // Also flush any pending PostToolUse batch (S4: prevents loss on short sessions)
  const running = await isMamaOsRunning();
  if (running) {
    const projectPath = process.env.CLAUDE_PROJECT_PATH || process.cwd();
    const posts = [];

    // Flush pending PostToolUse batch before compaction
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
        posts.push(
          postToMemoryAgent(
            [{ role: 'assistant', content: entries.join('\n---\n') }],
            projectPath,
            'posttooluse-batch'
          )
        );
      }
    } catch {
      /* no pending batch */
    }

    // Send recent conversation exchanges for full-context extraction
    const recentMessages = parseTranscriptMessages(transcript, 10);
    if (recentMessages.length > 0) {
      posts.push(postToMemoryAgent(recentMessages, projectPath, 'precompact-transcript'));
    }

    // Also send unsaved decisions explicitly as high-priority items
    if (unsaved.length > 0) {
      const decisionContent = unsaved.map((d, i) => `${i + 1}. ${d}`).join('\n');
      posts.push(
        postToMemoryAgent(
          [
            {
              role: 'assistant',
              content: `[PreCompact] Unsaved decisions detected before context compaction:\n${decisionContent}`,
            },
          ],
          projectPath,
          'precompact-decisions'
        )
      );
    }

    // Wait for all posts to flush before exiting
    await Promise.all(posts);
  }

  // Output compaction prompt with safe flush
  const compactionPrompt = buildCompactionPrompt(transcript, unsaved, running);
  const output = JSON.stringify({ continue: true, systemMessage: compactionPrompt });
  if (process.stdout.write(output + '\n')) {
    process.exit(0);
  } else {
    process.stdout.once('drain', () => process.exit(0));
    setTimeout(() => process.exit(0), 200);
  }
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}

module.exports = {
  handler: main,
  main,
  getEnabledFeatures,
  extractDecisionCandidates,
  filterUnsaved,
  buildCompactionPrompt,
  buildWarningMessage,
};
