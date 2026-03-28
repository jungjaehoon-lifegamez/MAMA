import { createHash } from 'crypto';
import type { SaveCandidate, SaveCandidateKind } from './save-candidate-types.js';

const DECISION_PATTERNS = [
  /\bwe decided\b/i,
  /\buse\s+[A-Za-z0-9_-]+\b/i,
  /\bdefault\b/i,
  /앞으로/,
  /기억해/,
  /쓰자/,
  /결정/,
];

const PREFERENCE_PATTERNS = [
  /\bprefer\b/i,
  /\bpreference\b/i,
  /\bfavorite\b/i,
  /\bfavourite\b/i,
  /\blike\b/i,
  /\blove\b/i,
  /선호/,
  /좋아/,
];

const CHANGE_PATTERNS = [
  /\bnow\b/i,
  /\binitially\b/i,
  /\bsince\b/i,
  /\bbefore\b/i,
  /\bafter\b/i,
  /예전/,
  /이제/,
  /처음/,
];

const FACT_PATTERNS = [/\bunder\b/i, /\bover a year\b/i, /\bwhere\b/i, /\bhow many\b/i];

const IGNORE_PATTERNS = [/^\s*(thanks|thank you|고마워|감사|좋네|오케이|okay|ok)\s*[.!?]*\s*$/i];

export interface SaveCandidateExtractionInput {
  userText: string;
  botResponse: string;
  channelKey: string;
  source: string;
  channelId: string;
  userId?: string;
  projectId?: string;
  createdAt?: number;
}

function detectKind(text: string): SaveCandidateKind | null {
  if (PREFERENCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'preference';
  }
  if (DECISION_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'decision';
  }
  if (CHANGE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'change';
  }
  if (FACT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'fact';
  }
  return null;
}

function inferTopicHint(text: string, kind: SaveCandidateKind): string | undefined {
  const normalized = text.toLowerCase();
  if (kind === 'decision' && normalized.includes('postgresql')) {
    return 'database_choice';
  }
  if (kind === 'decision' && normalized.includes('sqlite')) {
    return 'database_choice';
  }
  if (kind === 'preference' && normalized.includes('sony')) {
    return 'photography_preference';
  }
  if (kind === 'preference' && normalized.includes('homegrown')) {
    return 'ingredient_preference';
  }
  return undefined;
}

function buildCandidateId(channelKey: string, text: string, createdAt: number): string {
  const hash = createHash('sha1')
    .update(`${channelKey}:${text}:${createdAt}`)
    .digest('hex')
    .slice(0, 12);
  return `candidate_${hash}`;
}

export function extractSaveCandidates(input: SaveCandidateExtractionInput): SaveCandidate[] {
  const text = input.userText.trim();
  if (!text) {
    return [];
  }
  if (IGNORE_PATTERNS.some((pattern) => pattern.test(text))) {
    return [];
  }

  const kind = detectKind(text);
  if (!kind) {
    return [];
  }

  const createdAt = input.createdAt ?? Date.now();
  const topicHint = inferTopicHint(text, kind);
  const confidence =
    kind === 'decision' ? 0.95 : kind === 'preference' ? 0.9 : kind === 'change' ? 0.85 : 0.75;

  return [
    {
      id: buildCandidateId(input.channelKey, text, createdAt),
      kind,
      confidence,
      topicHint,
      summary: text,
      evidence: [text, input.botResponse.trim()].filter(Boolean),
      channelKey: input.channelKey,
      source: input.source,
      channelId: input.channelId,
      userId: input.userId,
      projectId: input.projectId,
      createdAt,
    },
  ];
}
