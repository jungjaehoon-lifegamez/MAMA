#!/usr/bin/env node
/**
 * PreCompact Hook - Decision Preservation Before Context Compaction
 *
 * Enhanced version: queries MAMA DB directly to compare transcript decisions
 * against saved decisions, filtering out already-saved ones.
 * Generates a 7-section compaction prompt (ported from standalone pre-compact-handler.ts).
 *
 * stdin: { transcript_path }
 * stdout: { continue: true, systemMessage: "..." }
 */

const path = require('path');
const fs = require('fs');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));

const DECISION_PATTERNS = [
  /(?:decided|decision|chose|we'll use|going with|선택|결정)[:：]?\s*(.{10,200})/gi,
  /(?:approach|architecture|strategy|설계|방식)[:：]\s*(.{10,200})/gi,
];

const MAX_DECISIONS_TO_DETECT = 5;

/**
 * Extract decision candidates from transcript text
 */
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

    // Track topics that were explicitly saved via mama_save
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
          // Skip if saved topic word appears in candidate
          let isAlreadySaved = false;
          for (const savedTopic of savedTopics) {
            const topicRegex = new RegExp(`\\b${savedTopic}\\b`, 'i');
            if (topicRegex.test(candidate)) {
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

  const unique = [...new Set(candidates)];
  return unique.slice(-MAX_DECISIONS_TO_DETECT);
}

/**
 * Query MAMA DB for saved decision topics to filter against
 */
async function getSavedTopicsFromDB() {
  const topics = new Set();

  try {
    const { vectorSearch, initDB } = require('@jungjaehoon/mama-core/memory-store');
    await initDB();

    // Get recent decisions (no embedding needed, just list recent)
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
    // DB not available, fall back to transcript-only analysis
  }

  return topics;
}

/**
 * Filter candidates against saved topics from DB
 */
function filterUnsaved(candidates, savedTopics) {
  return candidates.filter((candidate) => {
    const lowerCandidate = candidate.toLowerCase();
    for (const savedTopic of savedTopics) {
      if (lowerCandidate.includes(savedTopic) || savedTopic.includes(lowerCandidate)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Build the 7-section compaction prompt
 * Sections: User Requests, Final Goal, Work Completed, Remaining Tasks,
 *           Active Working Context, Explicit Constraints, Agent Verification State
 */
function buildCompactionPrompt(transcript, unsavedDecisions) {
  const sections = [];

  sections.push('## 1. User Requests');
  sections.push('Summarize the original user requests and requirements from this conversation.\n');

  sections.push('## 2. Final Goal');
  sections.push('State the ultimate objective being worked toward. What does "done" look like?\n');

  sections.push('## 3. Work Completed');
  sections.push('List all tasks, code changes, and accomplishments completed so far.\n');

  sections.push('## 4. Remaining Tasks');
  sections.push('List outstanding work items that still need to be done.\n');

  sections.push('## 5. Active Working Context');
  sections.push('Current files being edited, git branch, key variables, and active state.\n');

  sections.push('## 6. Explicit Constraints');
  sections.push(
    'Rules, conventions, architectural decisions, or limitations stated during the conversation.\n'
  );

  sections.push('## 7. Agent Verification State');
  sections.push('Current build/test/lint status, any error states, and verification results.\n');

  let prompt = '# Compaction Summary\n\n';
  prompt +=
    'Before compressing context, preserve the following information in these 7 sections:\n\n';
  prompt += sections.join('\n');

  if (unsavedDecisions.length > 0) {
    prompt += '\n---\n\n';
    prompt += '## Unsaved Decisions\n\n';
    prompt += 'The following decisions were detected but NOT saved to MAMA memory.\n';
    prompt += 'Consider saving them with mama_save before compaction:\n\n';
    unsavedDecisions.forEach((d, i) => {
      prompt += `${i + 1}. ${d}\n`;
    });
  }

  const lineCount = transcript.split('\n').length;
  prompt += `\n---\n\n_Conversation context: ~${lineCount} lines before compaction._\n`;

  return prompt;
}

/**
 * Build warning message for unsaved decisions
 */
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

module.exports = {
  handler: main,
  main,
  getEnabledFeatures,
  extractDecisionCandidates,
  filterUnsaved,
  buildCompactionPrompt,
  buildWarningMessage,
};

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

  // Extract candidates from transcript
  const candidates = extractDecisionCandidates(transcript);

  if (candidates.length === 0) {
    // Even without unsaved decisions, output the 7-section compaction prompt
    // Note: hookSpecificOutput only supports PreToolUse, UserPromptSubmit, PostToolUse
    // Use systemMessage for PreCompact hooks
    const compactionPrompt = buildCompactionPrompt(transcript, []);
    const output = {
      continue: true,
      systemMessage: compactionPrompt,
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  // Query MAMA DB for saved topics and filter
  const savedTopics = await getSavedTopicsFromDB();
  const unsaved = filterUnsaved(candidates, savedTopics);

  // Build combined output: warning + compaction prompt
  // Note: hookSpecificOutput only supports PreToolUse, UserPromptSubmit, PostToolUse
  // Use systemMessage for PreCompact hooks
  const warningMessage = buildWarningMessage(unsaved);
  const compactionPrompt = buildCompactionPrompt(transcript, unsaved);

  const systemMessage = warningMessage
    ? `${warningMessage}\n\n---\n\n${compactionPrompt}`
    : compactionPrompt;

  const output = {
    continue: true,
    systemMessage,
  };

  console.log(JSON.stringify(output));
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}
