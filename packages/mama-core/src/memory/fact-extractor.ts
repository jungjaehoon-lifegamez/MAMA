/**
 * Fact Extractor — regex-based extraction of factual statements from text.
 *
 * Design principle: ONLY extract what is explicitly stated. NEVER infer.
 * Regex ensures hallucination-free extraction. LLM is used ONLY for
 * classification (kind + topic), never for content generation.
 *
 * Pipeline:
 *   1. Split text into sentences
 *   2. Regex: detect fact-bearing sentences
 *   3. Normalize: "I" → "User", date injection
 *   4. Entity key: generate stable key for supersedes tracking
 *   5. Domain label: classify domain (cooking, travel, etc.)
 */

import type { MemoryKind } from './types.js';

// ── Fact detection patterns (user statements containing personal information) ──

const FACT_PATTERNS = [
  // Actions & events
  /\bI\s+(just\s+)?(started|began|finished|completed|graduated|attended)\b/i,
  /\bI\s+(just\s+)?(got|bought|purchased|acquired|received)\s+(a|an|my|the)\b/i,
  /\bI\s+(just\s+)?(got|bought|purchased|acquired)\b/i,
  /\bI\s+recently\s+(attended|went|visited|saw|watched|volunteered|completed|finished|made|baked)\b/i,
  /\bI\s+went\s+(to|on)\b/i,
  /\bI\s+visited\b/i,
  /\bI\s+volunteered\b/i,
  /\bI\s+ran\b/i,
  // Current state
  /\bI\s+(am\s+currently|'m\s+currently)\b/i,
  /\bI\s+(am|'m)\s+(reading|watching|writing|playing|learning|training|working|living)\b/i,
  /\bI\s+(work|live|play|run|do)\b/i,
  /\bI'?ve\s+(made|baked|cooked|tried|been\s+doing|been\s+playing|been\s+training)\b/i,
  // Duration & time
  /\bI\s+spent\s+\d+\s+(day|days|week|weeks|hour|hours)\b/i,
  /\bI\s+was\s+in\s+[A-Z]/,
  // Decisions & preferences
  /\bI\s+(prefer|always use|switched|changed|decided|chose)\b/i,
  /\bI\s+(much prefer|really like|don't like|hate)\b/i,
  /\bwe\s+(just\s+)?(moved|switched|migrated|raised|launched|hired)\b/i,
  /\bwe\s+(decided|chose)\b/i,
  /\bour\s+\w*\s*(team|record|score|league|anniversary|wedding|startup|company)\b/i,
  /\bwe'?re\s+\d+-\d+\b/i,
  // Possessive facts
  /\bmy\s+(startup|company|team|wife|husband|dog|cat|puppy|pet|car|house)\b/i,
  // Assistant recommendations & suggestions
  /\bI'?d?\s+recommend\b/i,
  /\brecommend\s+(using|choosing|going\s+with|a\s+normalized)\b/i,
  /\bI\s+suggest\b/i,
  /\bfor\s+your\s+case\b/i,
  // Specific quantities worth preserving
  /\b\d+%\s*\w+\b/,
  /\$\d+[KMB]?\b/i,
  /\b\d+\s+(hours?|minutes?|months?|years?|days?|weeks?)\b/i,
  // Especially + specific detail patterns
  /\bespecially\b/i,
  /\bspecifically\b/i,
  // Korean patterns
  /결정했|선택했|시작했|변경했|전환했|이사했|입양했/,
  /선호해|좋아해|싫어해|항상 사용/,
  /추천|권장|제안/,
];

// ── Domain labels for classification ──

const DOMAIN_LABELS: Array<{ patterns: RegExp[]; label: string; kind: MemoryKind }> = [
  {
    patterns: [/\b(made|baked|cooked|brewed)\b/i],
    label: 'Cooking/baking',
    kind: 'fact',
  },
  {
    patterns: [
      /\b(started|began|finished|completed)\b.*\b(book|novel)\b/i,
      /\b(started|began|finished|completed)\b.*["'][^"']{3,}["']/i,
    ],
    label: 'Reading',
    kind: 'fact',
  },
  {
    patterns: [
      /\b(started|watching|watched|finished|binge)\b.*\b(show|series|movie|season|episode)\b/i,
    ],
    label: 'Watching',
    kind: 'fact',
  },
  {
    patterns: [
      /\b(attended|visited)\b.*\b(concert|lecture|museum|gallery|theater|festival|exhibition)\b/i,
      /\bvolunteered\b/i,
    ],
    label: 'Event',
    kind: 'fact',
  },
  {
    patterns: [/\b(bought|purchased|acquired)\b/i, /\bgot\s+(a|an|my|the)\s+\w+/i],
    label: 'Purchase',
    kind: 'fact',
  },
  {
    patterns: [/\bwe'?re\s+\d+-\d+\b/i, /\b(record|score)\b.*\d+-\d+/i],
    label: 'Sports',
    kind: 'fact',
  },
  {
    patterns: [/\b(went to|visited|was in|traveled to|moved to|trip to)\b.*\b[A-Z][a-z]{2,}\b/i],
    label: 'Travel/Move',
    kind: 'fact',
  },
  {
    patterns: [/\b(graduated|degree|diploma)\b/i],
    label: 'Education',
    kind: 'fact',
  },
  {
    patterns: [/\b(prefer|always use|like.*over|don't like|favorite)\b/i, /선호|좋아해|항상 사용/],
    label: 'Preference',
    kind: 'preference',
  },
  {
    patterns: [/\b(decided|switched|changed|migrated|chose)\b/i, /결정|전환|변경/],
    label: 'Decision',
    kind: 'decision',
  },
  {
    patterns: [/\b(raised|funded|series\s+[a-z]|seed|investor)\b/i],
    label: 'Funding',
    kind: 'fact',
  },
  {
    patterns: [/\b(wedding|anniversary|married|engaged)\b/i],
    label: 'Personal milestone',
    kind: 'fact',
  },
  {
    patterns: [/\b(marathon|race|training|workout|gym|exercise)\b/i],
    label: 'Fitness',
    kind: 'fact',
  },
  {
    patterns: [/\b(adopted|puppy|kitten|pet|dog|cat)\b/i, /입양/],
    label: 'Pet',
    kind: 'fact',
  },
];

// ── Extraction functions ──

export interface ExtractedFact {
  text: string;
  kind: MemoryKind;
  label: string;
  entityKey: string;
}

/**
 * Extract fact-bearing sentences from text using regex patterns.
 * Returns ONLY sentences that match fact patterns — no inference.
 */
export function extractFactSentences(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const results: string[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (FACT_PATTERNS.some((p) => p.test(s)) && s.length > 15) {
      // Merge following sentences that add detail or are short directives
      let merged = s;
      while (i + 1 < sentences.length) {
        const next = sentences[i + 1];
        if (!next) break;
        // Merge if: detail continuation, or short directive (<80 chars, starts with verb)
        const isDetailContinuation =
          /^(Especially|Specifically|Particularly|Currently|Also|Use|Add|Choose|Set|Try)\b/i.test(
            next
          );
        const isShortDirective = next.length < 80 && /^[A-Z][a-z]+\s/.test(next);
        if (isDetailContinuation || (isShortDirective && next.length < 60)) {
          merged += ' ' + next;
          i++;
        } else {
          break;
        }
      }
      results.push(merged);
    }
  }

  return results;
}

/**
 * Normalize a fact sentence: replace "I" with "User", trim.
 */
/**
 * Normalize a fact sentence: replace first-person pronouns with "User".
 * Only normalizes when the sentence appears to be from user's perspective
 * (not assistant recommendations).
 */
export function normalizeFact(sentence: string): string {
  // Don't normalize assistant recommendations ("I recommend", "I suggest")
  if (/\b(recommend|suggest|advise)\b/i.test(sentence)) {
    return sentence.trim();
  }
  return sentence
    .replace(/\bI\b/g, 'User')
    .replace(/\bmy\b/gi, "User's")
    .trim();
}

/**
 * Add date prefix if available.
 */
export function injectDate(fact: string, date?: string): string {
  return date ? `${date}: ${fact}` : fact;
}

/**
 * Classify a fact into domain label and kind.
 */
export function classifyFact(fact: string): { label: string; kind: MemoryKind } {
  for (const { patterns, label, kind } of DOMAIN_LABELS) {
    if (patterns.some((p) => p.test(fact))) {
      return { label, kind };
    }
  }
  return { label: 'General', kind: 'fact' };
}

/**
 * Generate stable entity key for supersedes tracking.
 */
export function generateEntityKey(fact: string): string {
  const quoted = fact.match(/"([^"]+)"/)?.[1];
  if (quoted) {
    const verb =
      fact
        .match(
          /\b(started|began|finished|completed|got|bought|purchased|attended|went|visited|switched|changed|adopted|raised)\b/i
        )?.[1]
        ?.toLowerCase() ?? 'fact';
    return `${verb}_${quoted.toLowerCase().replace(/\s+/g, '_')}`.slice(0, 70);
  }

  const proper = fact
    .match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*/g)
    ?.filter((w) => !['User', 'By', 'The', 'In', 'On', 'For', 'And', 'But'].includes(w));
  if (proper?.length) {
    const verb =
      fact
        .match(
          /\b(started|finished|attended|bought|visited|went|graduated|completed|switched|changed|adopted|raised|moved|prefer)\b/i
        )?.[1]
        ?.toLowerCase() ?? 'fact';
    return `${verb}_${proper[0].toLowerCase().replace(/\s+/g, '_')}`.slice(0, 70);
  }

  const words = fact
    .toLowerCase()
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 4 &&
        !['about', 'their', 'which', 'would', 'could', 'should', "user's"].includes(w)
    )
    .slice(0, 3);
  return words.join('_') || 'unknown';
}

/**
 * Full extraction pipeline: text → facts with classification.
 *
 * @param text - Raw text (conversation or document)
 * @param sessionDate - Optional date to inject into facts
 * @returns Array of extracted facts with kind, label, and entity key
 */
export function extractFacts(text: string, sessionDate?: string): ExtractedFact[] {
  const sentences = extractFactSentences(text);
  const facts: ExtractedFact[] = [];

  for (const sentence of sentences) {
    const normalized = normalizeFact(sentence);
    const dated = injectDate(normalized, sessionDate);
    const { label, kind } = classifyFact(sentence);
    const entityKey = generateEntityKey(sentence);

    facts.push({
      text: dated,
      kind,
      label,
      entityKey,
    });
  }

  return facts;
}
