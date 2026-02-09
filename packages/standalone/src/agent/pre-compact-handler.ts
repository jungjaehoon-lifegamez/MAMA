/**
 * PreCompact Handler for MAMA OS Standalone
 *
 * Ported from claude-code-plugin/scripts/precompact-hook.js.
 * Uses executeTool callback to interact with MAMA memory (mama_search)
 * without importing mama-core directly.
 */

// ============================================================================
// Types
// ============================================================================

export interface CompactionResult {
  unsavedDecisions: string[];
  compactionPrompt: string;
  warningMessage: string;
}

export interface PreCompactHandlerConfig {
  enabled: boolean;
  maxDecisionsToDetect?: number;
}

type ExecuteToolFn = (name: string, input: Record<string, unknown>) => Promise<unknown>;

interface SearchResultItem {
  topic?: string;
  decision?: string;
}

interface SearchResponse {
  results?: SearchResultItem[];
}

// ============================================================================
// Constants
// ============================================================================

const LOG_PREFIX = '[PreCompact]';

const DEFAULT_MAX_DECISIONS = 5;

// English + Korean decision-like statement patterns
const DECISION_PATTERNS: RegExp[] = [
  /(?:decided|decision|chose|we'll use|going with|선택|결정)[:：]?\s*(.{10,200})/gi,
  /(?:approach|architecture|strategy|설계|방식)[:：]\s*(.{10,200})/gi,
];

// ============================================================================
// PreCompactHandler
// ============================================================================

export class PreCompactHandler {
  private readonly executeTool: ExecuteToolFn;
  private readonly config: Required<PreCompactHandlerConfig>;

  constructor(executeTool: ExecuteToolFn, config: PreCompactHandlerConfig) {
    this.executeTool = executeTool;
    this.config = {
      enabled: config.enabled,
      maxDecisionsToDetect: config.maxDecisionsToDetect ?? DEFAULT_MAX_DECISIONS,
    };
  }

  async process(conversationHistory: string[]): Promise<CompactionResult> {
    const emptyResult: CompactionResult = {
      unsavedDecisions: [],
      compactionPrompt: '',
      warningMessage: '',
    };

    try {
      if (!this.config.enabled || conversationHistory.length === 0) {
        return emptyResult;
      }

      const fullText = conversationHistory.join('\n');
      const candidates = this.extractDecisionCandidates(fullText);

      if (candidates.length === 0) {
        return {
          ...emptyResult,
          compactionPrompt: this.buildCompactionPrompt(fullText, []),
        };
      }

      const savedTopics = await this.getSavedTopics();
      const unsavedDecisions = this.filterUnsaved(candidates, savedTopics);
      const warningMessage = this.buildWarningMessage(unsavedDecisions);
      const compactionPrompt = this.buildCompactionPrompt(fullText, unsavedDecisions);

      return { unsavedDecisions, compactionPrompt, warningMessage };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${LOG_PREFIX} Error during process:`, message);
      return emptyResult;
    }
  }

  private extractDecisionCandidates(text: string): string[] {
    const candidates: string[] = [];

    for (const pattern of DECISION_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.exec(text);
      while (match !== null) {
        const candidate = match[1].trim();
        if (candidate.length >= 10) {
          candidates.push(candidate);
        }
        match = pattern.exec(text);
      }
    }

    const unique = [...new Set(candidates)];
    return unique.slice(-this.config.maxDecisionsToDetect);
  }

  private async getSavedTopics(): Promise<Set<string>> {
    const topics = new Set<string>();

    try {
      const response = (await this.executeTool('mama_search', {
        type: 'decision',
        limit: 20,
      })) as SearchResponse | undefined;

      if (response?.results && Array.isArray(response.results)) {
        for (const item of response.results) {
          if (item.topic) {
            topics.add(item.topic.toLowerCase());
          }
          if (item.decision) {
            topics.add(item.decision.toLowerCase());
          }
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${LOG_PREFIX} Failed to fetch saved topics:`, message);
    }

    return topics;
  }

  private filterUnsaved(candidates: string[], savedTopics: Set<string>): string[] {
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

  private buildWarningMessage(unsavedDecisions: string[]): string {
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

  /**
   * 7-section compaction prompt:
   * 1. User Requests  2. Final Goal  3. Work Completed  4. Remaining Tasks
   * 5. Active Working Context  6. Explicit Constraints  7. Agent Verification State
   */
  private buildCompactionPrompt(fullText: string, unsavedDecisions: string[]): string {
    const sections: string[] = [];

    sections.push('## 1. User Requests');
    sections.push(
      'Summarize the original user requests and requirements from this conversation.\n'
    );

    sections.push('## 2. Final Goal');
    sections.push(
      'State the ultimate objective being worked toward. What does "done" look like?\n'
    );

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

    const lineCount = fullText.split('\n').length;
    prompt += `\n---\n\n_Conversation context: ~${lineCount} lines before compaction._\n`;

    return prompt;
  }
}
