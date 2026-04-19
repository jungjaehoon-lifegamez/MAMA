export type InferredCaseRole = 'requester' | 'implementer' | 'reviewer' | 'observer' | 'affected';

interface InferTimelineEventRoleInput {
  userText: string;
  assistantText?: string;
  eventType?: string;
  actorHints?: string[];
}

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function joinText(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part?.trim())).join('\n');
}

function mentionsActor(text: string, actorHints: string[]): boolean {
  return actorHints.some((hint) => {
    const trimmed = hint.trim();
    return trimmed.length > 0 && text.toLowerCase().includes(trimmed.toLowerCase());
  });
}

const REQUESTER_PATTERNS = [
  /\b(ask|asks|asked|request|requests|requested|please|can you|could you|would you|help me)\b/i,
  /요청|해줘|해주세요|부탁|해주시|해 줄래|해 주실/i, // Korean: keyword patterns
];

const IMPLEMENTER_PATTERNS = [
  /\b(i|we)\s+(will\s+handle|can\s+handle|implemented|fixed|built|handled|completed|shipped|worked\s+on|am\s+working\s+on)\b/i,
  /\b(i'll|we'll)\s+handle\b/i,
  /\b(implemented|fixed|built|handled|completed|shipped)\b/i,
  /제가\s*(작업|수정|구현|처리|담당)|작업했습니다|수정했습니다|구현했습니다|담당합니다/i, // Korean: keyword patterns
];

const ACTOR_IMPLEMENTER_PATTERNS = [
  /\b(will\s+handle|implemented|fixed|built|handled|completed|shipped|worked\s+on|owns\s+the\s+work)\b/i,
  /작업|수정|구현|처리|담당/i, // Korean: keyword patterns
];

const REVIEWER_PATTERNS = [
  /\b(reviewed|reviewing|review|approved|approve|approval)\b/i,
  /검토|승인|리뷰/i, // Korean: keyword patterns
];

const AFFECTED_PATTERNS = [
  /\b(blocked|waiting|held\s+up|impacted|affected|deferred|on\s+hold)\b/i,
  /막힘|막혔|보류|대기|영향/i, // Korean: keyword patterns
];

const OBSERVER_PATTERNS = [
  /\b(fyi|for your information|status-only|status only|heads up|observing)\b/i,
  /참고|공유만|상태\s*공유|관찰/i, // Korean: keyword patterns
];

const AMBIGUOUS_OWNER_BLOCKER_PATTERNS = [/\b(owner|blocker)\b/i, /오너|소유자|블로커/i]; // Korean: keyword patterns

export function inferTimelineEventRole(
  input: InferTimelineEventRoleInput
): InferredCaseRole | null {
  const userText = input.userText.trim();
  const assistantText = input.assistantText?.trim() ?? '';
  const eventType = input.eventType?.trim() ?? '';
  const actorHints = input.actorHints ?? [];
  const combinedText = joinText([userText, assistantText, eventType, actorHints.join(' ')]);

  if (!combinedText) {
    return null;
  }

  const roles = new Set<InferredCaseRole>();

  if (hasPattern(userText, REQUESTER_PATTERNS)) {
    roles.add('requester');
  }

  const implementerText = joinText([assistantText, eventType]);
  if (hasPattern(implementerText, IMPLEMENTER_PATTERNS)) {
    roles.add('implementer');
  }
  if (
    mentionsActor(userText, actorHints) &&
    hasPattern(userText, ACTOR_IMPLEMENTER_PATTERNS) &&
    !hasPattern(userText, REQUESTER_PATTERNS)
  ) {
    roles.add('implementer');
  }

  if (hasPattern(joinText([assistantText, eventType]), REVIEWER_PATTERNS)) {
    roles.add('reviewer');
  }
  if (mentionsActor(userText, actorHints) && hasPattern(userText, REVIEWER_PATTERNS)) {
    roles.add('reviewer');
  }

  if (hasPattern(combinedText, AFFECTED_PATTERNS)) {
    roles.add('affected');
  }

  if (hasPattern(combinedText, OBSERVER_PATTERNS)) {
    roles.add('observer');
  }

  if (roles.size === 0 && hasPattern(combinedText, AMBIGUOUS_OWNER_BLOCKER_PATTERNS)) {
    return null;
  }

  if (roles.size !== 1) {
    return null;
  }

  return [...roles][0] ?? null;
}
