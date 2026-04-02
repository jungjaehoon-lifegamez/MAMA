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
  // ── Broad 1st-person action (catches most user statements) ──
  /\bI\s+(just\s+)?\w{2,}ed\b/i, // I + past tense verb (walked, attended, graduated...)
  /\bI\s+(just\s+)?\w{2,}ght\b/i, // I + irregular past (bought, thought, brought...)
  /\bI\s+went\b/i, // I went (for/to/on)
  /\bI\s+ran\b/i, // I ran
  /\bI\s+made\b/i, // I made
  /\bI\s+got\b/i, // I got
  /\bI\s+did\b/i, // I did
  /\bI\s+spent\b/i, // I spent
  /\bI\s+saw\b/i, // I saw

  // ── Plans & intentions ──
  /\bI\s+(plan|hope|want|need)\b/i,
  /\bI'?m\s+(hoping|planning|thinking|considering|looking)\b/i,
  /\bI'?d\s+(like|love|want)\b/i,

  // ── Current state ──
  /\bI\s+(am|'m)\s+\w+ing\b/i, // I am/I'm + verb-ing (reading, working, living...)
  /\bI\s+(am|'m)\s+(a|an|the|currently)\b/i,
  /\bI\s+(work|live|have|consider)\b/i,

  // ── Past habits / ongoing ──
  /\bI\s+used\s+to\b/i,
  /\bI'?ve\s+been\b/i, // I've been doing/slacking/training...
  /\bI\s+was\s+in\s+[A-Z]/,

  // ── Decisions & preferences ──
  /\bI\s+(prefer|always use|switched|changed|decided|chose)\b/i,
  /\bI\s+(much prefer|really like|don't like|hate)\b/i,

  // ── We/our (team/company/family) ──
  /\bwe\s+(just\s+)?\w{2,}ed\b/i, // we + past tense
  /\bwe\s+(decided|chose|moved|switched)\b/i,
  /\bour\s+\w*\s*(team|record|score|league|anniversary|wedding|startup|company)\b/i,
  /\bwe'?re\s+\d+-\d+\b/i,

  // ── Possessive facts ──
  /\bmy\s+(startup|company|team|wife|husband|dog|cat|puppy|pet|car|house|record|degree)\b/i,

  // ── Specific quantities (high-value signals) ──
  /\b\d+%\s*\w+\b/,
  /\$\d+[KMB]?\b/i,
  /\b\d+\s+(hours?|minutes?|months?|years?|days?|weeks?)\b/i,

  // ── Korean patterns ──
  /결정했|선택했|시작했|변경했|전환했|이사했|입양했/,
  /선호해|좋아해|싫어해|항상 사용/,
  /계획|예정|하려고|할거|생각중/,
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

import type { FactModality } from './types.js';

export interface ExtractedFact {
  text: string;
  kind: MemoryKind;
  label: string;
  entityKey: string;
  modality: FactModality;
  entities: string[];
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
 *
 * Priority: entities (activity/proper nouns) > quoted strings > word-based fallback.
 * When entities are available, use the primary entity as key so that facts about
 * the same subject (e.g., "yoga") share a topic and trigger evolution rules.
 */
export function generateEntityKey(fact: string, entities?: string[]): string {
  // Priority 1: Use extracted entities (most stable for evolution tracking)
  if (entities?.length) {
    // Filter out generic entities like days of the week, months
    const generic = new Set([
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
      'session',
      'may',
      'june',
      'july',
      'january',
      'february',
      'march',
      'april',
      'august',
      'september',
      'october',
      'november',
      'december',
      'new',
    ]);
    const meaningful = entities.filter((e) => !generic.has(e));
    if (meaningful.length > 0) {
      return meaningful[0].replace(/\s+/g, '_').slice(0, 70);
    }
  }

  // Priority 2: Quoted strings
  const quoted = fact.match(/"([^"]+)"/)?.[1];
  if (quoted) {
    return quoted.toLowerCase().replace(/\s+/g, '_').slice(0, 70);
  }

  // Priority 3: Proper nouns
  const proper = fact
    .match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*/g)
    ?.filter((w) => !['User', 'By', 'The', 'In', 'On', 'For', 'And', 'But'].includes(w));
  if (proper?.length) {
    return proper[0].toLowerCase().replace(/\s+/g, '_').slice(0, 70);
  }

  // Priority 4: Significant words fallback
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
 * Classify the modality (tense/intent) of a fact sentence.
 * This determines HOW the fact relates to reality:
 * - completed: user actually did this (past tense action)
 * - plan: user intends to do this (future-oriented)
 * - past_habit: user used to do this regularly
 * - state: current attribute or status
 * - preference: user's taste or choice
 */
export function classifyModality(sentence: string): FactModality {
  // Preference first (overlaps with others)
  if (/\b(prefer|always use|much prefer|really like|don't like|hate|favorite)\b/i.test(sentence)) {
    return 'preference';
  }
  if (/선호|좋아해|싫어해|항상 사용/i.test(sentence)) {
    return 'preference';
  }

  // Plan/intention
  if (
    /\b(plan|plans|planning|hoping|hope|want|wants|going to|thinking of|considering|would like|looking forward)\b/i.test(
      sentence
    )
  ) {
    return 'plan';
  }

  // Past habit
  if (/\b(used to|have been|had been|'ve been)\b/i.test(sentence)) {
    return 'past_habit';
  }
  if (/\bUser've been\b/i.test(sentence)) {
    return 'past_habit';
  }

  // Completed action (past tense verbs)
  if (
    /\b(went|attended|bought|purchased|started|finished|completed|graduated|ran|made|baked|visited|adopted|raised|moved|switched|changed|volunteered|tried|spent|watched|saw|received|got|participated|assisted|joined|signed|enrolled|registered|donated|organized|hosted|performed|presented|delivered|submitted|returned|redeemed|ordered|assembled|installed|cooked|wore|drove|flew|hiked|swam|cycled|walked|played|won|lost|earned|sold|paid|rented)\b/i.test(
      sentence
    )
  ) {
    return 'completed';
  }

  // State/current (present tense being/having)
  if (/\b(am|is|are|have|has|currently|consider|considers|live|work|works)\b/i.test(sentence)) {
    return 'state';
  }

  return 'state'; // default
}

/**
 * Extract key entities (proper nouns, quoted strings, significant nouns) from a sentence.
 * Used for entity-based edge creation between facts that share entities.
 */
export function extractEntities(sentence: string): string[] {
  const entities: string[] = [];

  // Quoted strings
  const quoted = sentence.match(/"([^"]+)"/g) || sentence.match(/'([^']+)'/g) || [];
  for (const q of quoted) {
    entities.push(q.replace(/['"]/g, '').toLowerCase());
  }

  // Proper nouns (capitalized words, excluding sentence starters and common words)
  const skip = new Set([
    'User',
    'I',
    'My',
    'We',
    'The',
    'By',
    'In',
    'On',
    'For',
    'And',
    'But',
    'Do',
    'If',
    'So',
    'Or',
    'Also',
    'Currently',
    'Especially',
    'Recently',
  ]);
  const proper = sentence.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*/g) || [];
  for (const p of proper) {
    if (!skip.has(p)) {
      entities.push(p.toLowerCase());
    }
  }

  // Key nouns after "my" (possessive)
  const possessive = sentence.match(/\bmy\s+(\w+)/gi) || [];
  for (const p of possessive) {
    entities.push(p.replace(/^my\s+/i, '').toLowerCase());
  }

  // Activity/domain nouns (common subjects worth tracking)
  const activities =
    sentence.match(
      /\b(yoga|jog|jogging|running|swimming|cycling|hiking|cooking|baking|painting|sculpting|piano|guitar|violin|weddings?|marathon|volleyball|basketball|soccer|tennis|chess|meditation|smoker|camera|degree)\b/gi
    ) || [];
  for (const a of activities) {
    entities.push(a.toLowerCase());
  }

  return [...new Set(entities)];
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
    const modality = classifyModality(sentence);
    const entities = extractEntities(sentence);
    const entityKey = generateEntityKey(sentence, entities);

    facts.push({
      text: dated,
      kind,
      label,
      entityKey,
      modality,
      entities,
    });
  }

  return facts;
}
