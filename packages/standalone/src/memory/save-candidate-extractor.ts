import { createHash } from 'crypto';
import type { SaveCandidate, SaveCandidateKind } from './save-candidate-types.js';

const DECISION_PATTERNS = [
  /\bwe decided\b/i,
  /\b(?:we|i|let's|lets|should|decid(?:e|ed)\s+to)\s+use\s+[A-Za-z0-9_-]+\b/i,
  /\b(?:we|i)\s+(?:will|are going to)\s+use\s+[A-Za-z0-9_-]+\b/i,
  /\b(?:we|i)\s+(?:decided|choose|chose)\s+[A-Za-z0-9_-]+\s+as\b/i,
  /\b(?:default|standard)\s+(?:db|database|choice|option)\b/i,
  /앞으로.*(?:쓰자|사용하자|기억해)/,
  /(?:기억해|기억해 둬|기억해줘).*(?:결정|규칙|기본)/,
  /(?:이 프로젝트|우리|앞으로).*(?:쓰자|사용하자|가자).*(?:db|database|프로젝트|기본)/i,
  /결정(?:했|하)/,
];

const PREFERENCE_PATTERNS = [
  /\b(?:we|i)\s+prefer\s+[a-z0-9'"][^\n]{0,40}/i,
  /\bpreference\b/i,
  /\bfavorite\b/i,
  /\bfavourite\b/i,
  /\b(?:we|i)\s+(?:really\s+)?(?:like|love)\s+[a-z0-9]/i,
  /(?:나는|우리는).*(?:선호해|선호한다|좋아해)/,
  /(?:추천|다음에도).*(?:기억해|참고해).*(?:선호|좋아)/,
];

const CHANGE_PATTERNS = [
  /\b(?:now|from now on)\b.+\b(?:use|prefer|switch|choose)\b/i,
  /\b(?:switched|switching)\s+to\s+[A-Za-z0-9_-]+\b/i,
  /\b(?:changed|moving)\s+from\s+[A-Za-z0-9_-]+\s+to\s+[A-Za-z0-9_-]+\b/i,
  /예전.*(?:지금|이제)/,
  /이제.*(?:바꿀게|사용할게|할게|가자).*(?:postgresql|sqlite|db|database|기본)/i,
  /이제.*(?:postgresql|sqlite|db|database|기본).*(?:바꿀게|사용할게|할게|가자)/i,
  /처음.*(?:지금|이제)/,
];

const FACT_PATTERNS = [
  /\bwhere\s+we\s+keep\b/i,
  /\bhow many\s+(?:items|hours|projects|people)\b/i,
  /\bwe\s+keep\s+[a-z0-9'"\s_-]+\s+under\s+(?:my|the)\b/i,
  /\b(?:for|over)\s+(?:more than\s+)?\d+\s+(?:days|weeks|months|years)\b/i,
];

const TOPIC_HINTS: Partial<Record<SaveCandidateKind, Array<{ match: RegExp; topic: string }>>> = {
  decision: [
    { match: /\bpostgresql\b/i, topic: 'database_choice' },
    { match: /\bsqlite\b/i, topic: 'database_choice' },
  ],
  preference: [
    { match: /\bsony\b/i, topic: 'photography_preference' },
    { match: /\bhomegrown\b/i, topic: 'ingredient_preference' },
  ],
  change: [{ match: /\b(?:postgresql|sqlite)\b/i, topic: 'database_choice' }],
};

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
  if (CHANGE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'change';
  }
  if (DECISION_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'decision';
  }
  if (PREFERENCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'preference';
  }
  if (FACT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'fact';
  }
  return null;
}

function inferTopicHint(text: string, kind: SaveCandidateKind): string | undefined {
  const rules = TOPIC_HINTS[kind] ?? [];
  for (const rule of rules) {
    if (rule.match.test(text)) {
      return rule.topic;
    }
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
