export type QuestionType =
  | 'correction'
  | 'artifact'
  | 'timeline'
  | 'status'
  | 'decision_reason'
  | 'how_to'
  | 'unknown';

export const QUESTION_TYPES: readonly QuestionType[] = [
  'correction',
  'artifact',
  'timeline',
  'status',
  'decision_reason',
  'how_to',
  'unknown',
];

// Korean: patterns for classifyQuestionType() multilingual query routing.
const CORRECTION_PATTERN =
  /\b(fix|revert|correct|correction|supersede|superseded|revise|revision|수정|되돌|정정|교정)\b/i; // Korean: keywords
const ARTIFACT_PATTERN =
  /\b(file|doc|docs|document|image|video|pdf|drive|obsidian|attachment|artifact|파일|문서|이미지|영상|첨부|드라이브|옵시디언)\b/i; // Korean: keywords
const TIMELINE_PATTERN =
  /\b(when|history|before|after|around|timeline|chronology|언제|이력|히스토리|전|후|즈음)\b|\bon\s+\d{4}(?:-\d{1,2})?(?:-\d{1,2})?\b|\b\d{4}-\d{1,2}-\d{1,2}\b/i; // Korean: keywords
const STATUS_PATTERN =
  /\b(status|state|current|currently|now|latest|progress|blocked|done|상태|현재|최신|진행|진척)\b/i; // Korean: keywords
const DECISION_REASON_PATTERN = /\b(why|reason|because|rationale|근거|이유|왜|때문)\b/i; // Korean: keywords
const HOW_TO_PATTERN =
  /\b(how\s+to|how\s+do|setup|set\s+up|configure|configuration|install|설정|구성|어떻게)\b/i; // Korean: keywords

export function classifyQuestionType(query: string): QuestionType {
  const normalized = query.trim();
  if (CORRECTION_PATTERN.test(normalized)) return 'correction';
  if (ARTIFACT_PATTERN.test(normalized)) return 'artifact';
  if (TIMELINE_PATTERN.test(normalized)) return 'timeline';
  if (STATUS_PATTERN.test(normalized)) return 'status';
  if (DECISION_REASON_PATTERN.test(normalized)) return 'decision_reason';
  if (HOW_TO_PATTERN.test(normalized)) return 'how_to';
  return 'unknown';
}

export function isQuestionType(value: string): value is QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value);
}
