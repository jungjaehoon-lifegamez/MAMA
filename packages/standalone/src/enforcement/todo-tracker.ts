/**
 * TodoTracker - Task Completion Detection & Reminder Generation
 *
 * Detects whether an agent's response indicates task completion by scanning
 * for completion markers (Korean + English + symbols). Parses EXPECTED OUTCOME
 * sections to identify pending items and generates reminders for incomplete tasks.
 *
 * @module enforcement/todo-tracker
 * @see docs/spike-prep-enforcement-layer-2026-02-08.md
 */

/**
 * Result of checking task completion
 */
export interface TodoTrackerResult {
  /** Whether all tasks appear completed */
  allComplete: boolean;
  /** Completion markers found in the response */
  completionMarkers: string[];
  /** Pending items detected (from EXPECTED OUTCOME parsing) */
  pendingItems: string[];
  /** Generated reminder text (empty if all complete) */
  reminder: string;
}

/**
 * Configuration for the TodoTracker
 */
export interface TodoTrackerConfig {
  /** Whether tracking is enabled */
  enabled: boolean;
  /** Whether to generate inter-turn reminders for incomplete tasks */
  generateReminders: boolean;
}

// ---------------------------------------------------------------------------
// Completion Marker Definitions
// ---------------------------------------------------------------------------

/** A single completion marker with its regex and human-readable label */
interface CompletionMarker {
  regex: RegExp;
  label: string;
}

const ENGLISH_MARKERS: CompletionMarker[] = [
  { regex: /\bDONE\b/, label: 'DONE' },
  { regex: /\bTASK_COMPLETE\b/, label: 'TASK_COMPLETE' },
  { regex: /\bfinished\b/i, label: 'finished' },
  { regex: /\bcompleted\b/i, label: 'completed' },
  { regex: /\ball\s+done\b/i, label: 'all done' },
];

const KOREAN_MARKERS: CompletionMarker[] = [
  { regex: /완료/, label: '완료' },
  { regex: /끝/, label: '끝' },
  { regex: /다 했습니다/, label: '다 했습니다' },
  { regex: /작업 완료/, label: '작업 완료' },
];

const SYMBOL_MARKERS: CompletionMarker[] = [
  { regex: /✓/, label: '✓' },
  { regex: /✅/, label: '✅' },
  { regex: /☑/, label: '☑' },
  { regex: /\[x\]/i, label: '[x]' },
];

const ALL_MARKERS: CompletionMarker[] = [...ENGLISH_MARKERS, ...KOREAN_MARKERS, ...SYMBOL_MARKERS];

// ---------------------------------------------------------------------------
// Expected Outcome Parsing
// ---------------------------------------------------------------------------

/**
 * Regex patterns to detect the start of an EXPECTED OUTCOME section.
 * Supports: `EXPECTED OUTCOME:`, `## Expected Outcome`, `**EXPECTED OUTCOME**`
 */
const EXPECTED_OUTCOME_HEADERS: RegExp[] = [
  /^EXPECTED\s+OUTCOME\s*:/im,
  /^##\s+Expected\s+Outcome/im,
  /^\*\*EXPECTED\s+OUTCOME\*\*/im,
];

/**
 * Regex to match bullet points: `- item`, `* item`, `1. item`
 */
const BULLET_REGEX = /^\s*(?:[-*]|\d+\.)\s+(.+)$/;

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: TodoTrackerConfig = {
  enabled: true,
  generateReminders: true,
};

// ---------------------------------------------------------------------------
// TodoTracker
// ---------------------------------------------------------------------------

/**
 * Detects task completion signals in agent responses and generates
 * reminders for incomplete tasks.
 *
 * Scans for completion markers (Korean, English, symbols, markdown checkboxes)
 * and cross-references against an optional EXPECTED OUTCOME section to
 * identify pending items.
 *
 * @example
 * ```typescript
 * const tracker = new TodoTracker({ generateReminders: true });
 * const result = tracker.checkCompletion(response, expectedOutcome);
 * if (!result.allComplete) {
 *   // use result.reminder to nudge agent
 * }
 * ```
 */
export class TodoTracker {
  private readonly config: TodoTrackerConfig;

  constructor(config?: Partial<TodoTrackerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check whether a response indicates task completion.
   *
   * @param response - The full response text to check
   * @param expectedOutcome - Optional EXPECTED OUTCOME text to parse for pending items
   * @returns TodoTrackerResult with completion status, markers, pending items, and reminder
   */
  checkCompletion(response: string, expectedOutcome?: string): TodoTrackerResult {
    if (!this.config.enabled) {
      return { allComplete: true, completionMarkers: [], pendingItems: [], reminder: '' };
    }

    const completionMarkers = this.detectCompletionMarkers(response);
    const pendingItems = expectedOutcome ? this.findPendingItems(response, expectedOutcome) : [];

    const allComplete = pendingItems.length === 0 && completionMarkers.length > 0;

    const reminder =
      !allComplete && pendingItems.length > 0 && this.config.generateReminders
        ? this.buildReminder(pendingItems)
        : '';

    return { allComplete, completionMarkers, pendingItems, reminder };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Detect all completion markers present in a response.
   * Returns deduplicated labels.
   */
  private detectCompletionMarkers(response: string): string[] {
    const found = new Set<string>();

    for (const marker of ALL_MARKERS) {
      const fresh = new RegExp(marker.regex.source, marker.regex.flags);
      if (fresh.test(response)) {
        found.add(marker.label);
      }
    }

    return [...found];
  }

  /**
   * Parse an expected outcome section and find items not addressed in the response.
   *
   * Extracts bullet items from the expectedOutcome text, then checks each
   * item against the response for completion signals (marker presence or
   * substantial keyword overlap).
   */
  private findPendingItems(response: string, expectedOutcome: string): string[] {
    const items = this.parseExpectedOutcomeItems(expectedOutcome);

    if (items.length === 0) {
      return [];
    }

    const pending: string[] = [];
    const lowerResponse = response.toLowerCase();

    for (const item of items) {
      if (!this.isItemAddressed(lowerResponse, item)) {
        pending.push(item);
      }
    }

    return pending;
  }

  /**
   * Parse bullet points from an EXPECTED OUTCOME section.
   *
   * If the text contains a recognized header, only bullets after that header
   * are extracted. Otherwise, all bullet lines are extracted.
   */
  private parseExpectedOutcomeItems(text: string): string[] {
    let section = text;

    // Find the header and extract content after it
    for (const headerPattern of EXPECTED_OUTCOME_HEADERS) {
      const match = headerPattern.exec(text);
      if (match) {
        section = text.slice(match.index + match[0].length);
        break;
      }
    }

    const lines = section.split('\n');
    const items: string[] = [];

    for (const line of lines) {
      const bulletMatch = BULLET_REGEX.exec(line);
      if (bulletMatch) {
        const content = bulletMatch[1].trim();
        if (content.length > 0) {
          items.push(content);
        }
      }
    }

    return items;
  }

  /**
   * Check if an expected outcome item is addressed in the response.
   *
   * An item is considered addressed if:
   * 1. A significant keyword from the item appears in the response, OR
   * 2. The response contains a completion marker near relevant context
   */
  private isItemAddressed(lowerResponse: string, item: string): boolean {
    // Extract significant words (3+ chars, skip common words)
    const words = item
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .filter((w) => !COMMON_WORDS.has(w));

    if (words.length === 0) {
      return true; // Trivial item, consider addressed
    }

    // Item is addressed if at least half the significant words appear in the response
    const threshold = Math.max(1, Math.ceil(words.length / 2));
    let matchCount = 0;

    for (const word of words) {
      if (lowerResponse.includes(word)) {
        matchCount++;
      }
    }

    return matchCount >= threshold;
  }

  /**
   * Build a reminder string listing incomplete items.
   */
  private buildReminder(pendingItems: string[]): string {
    const itemList = pendingItems.join('], [');
    return `⚠️ Incomplete tasks detected: [${itemList}]. Please complete before marking done.`;
  }
}

// ---------------------------------------------------------------------------
// Common words to skip when matching expected outcome items
// ---------------------------------------------------------------------------

const COMMON_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'not',
  'but',
  'all',
  'can',
  'will',
  'should',
  'must',
  'may',
  'also',
]);
