import {
  MEMORY_KINDS,
  type ConversationMessage,
  type ExtractedMemoryUnit,
  type MemoryKind,
} from './types.js';

const VALID_KINDS = new Set<string>(MEMORY_KINDS);

export interface ExistingDecision {
  id: string;
  topic: string;
  summary: string;
}

export function buildExtractionPrompt(
  messages: ConversationMessage[],
  existingTopics?: string[],
  existingDecisions?: ExistingDecision[]
): string {
  const conversationText = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

  const hasExistingTopics = existingTopics && existingTopics.length > 0;
  const hasExistingDecisions = existingDecisions && existingDecisions.length > 0;

  const topicHint = hasExistingTopics
    ? `\nExisting topics (REUSE these when the subject matches instead of creating new ones):\n${existingTopics.map((t) => t.replace(/[`$\\]/g, '')).join(', ')}\n`
    : '';

  const decisionContext = hasExistingDecisions
    ? `\nExisting decisions in memory (link to these when related):\n${existingDecisions.map((d) => `- id:${d.id} topic:${d.topic} — ${d.summary.replace(/[`$\\]/g, '').slice(0, 100)}`).join('\n')}\n`
    : '';

  const topicRule = hasExistingTopics
    ? '- topic: lowercase_snake_case, prefer reusing an existing topic above when the subject matches'
    : '- topic: lowercase_snake_case';

  return `You are extracting structured memory units from a software development conversation.

Read the conversation and identify decisions, preferences, facts, lessons, and constraints worth remembering.
Classify each as one of: preference, fact, decision, lesson, constraint.
${topicHint}${decisionContext}
Rules:
${topicRule}
- summary: concise (<200 chars). Include specifics: tool names, file paths, library names, reasons.
  Example: "Decided to use better-sqlite3 instead of node:sqlite because FTS5 is not supported in node:sqlite"
  NOT: "Changed the database driver"
- details: quote the exact sentence(s) from the conversation that contain this information
- confidence: 0.0-1.0 based on how explicitly stated the information is
- CRITICAL: The USER's statements express intent and decisions. The ASSISTANT's statements provide context, explanation, or execution.
  • "User: PostgreSQL로 전환하자" → decision: User decided to switch to PostgreSQL
  • "Assistant: 현재 SQLite를 쓰고 있는데..." → this is CONTEXT, not a decision to keep SQLite
  • When user says "~하자", "~하기로 결정", "let's use X" → this IS the decision
  • When assistant describes current state or alternatives → this is NOT a decision
- KIND CLASSIFICATION GUIDE:
  • "preference": User's ongoing taste, habit, or style choice. Stable across sessions.
    Examples: "I prefer TypeScript over JavaScript", "항상 pnpm을 사용해", "dark mode"
    Signal words: "prefer", "like", "always use", "좋아해", "선호", "습관"
  • "decision": A specific choice made for a particular situation. May change.
    Examples: "Use PostgreSQL for this project", "이번에는 Redis로 가자"
  • "fact": An objective piece of information. Not a choice.
    Examples: "The API runs on port 3847", "Database is 161MB"
  • "lesson": Something learned from experience, especially from failure.
    Examples: "node:sqlite doesn't support FTS5", "delta-only analysis lacks insight"
  • "constraint": A limitation or requirement that restricts choices.
    Examples: "Must use Node 22+", "Hook timeout is 3 seconds", "마감 금요일"
- IMPORTANT: do NOT merge unrelated facts. Each distinct decision or fact is a separate unit
- Skip: greetings ("안녕", "hello"), acknowledgements ("ok", "좋아", "네"), commands ("모니터링해봐", "확인해")
- Skip: system notifications (<task-notification>, <system-reminder>, hook outputs)
- Skip: assistant's general knowledge responses that don't contain user-specific information
- Skip: conversation meta-data (session IDs, timestamps, tool status updates)
- If the conversation contains ONLY greetings or meta-conversation with no decisions/facts, return an empty array []

- LINKING: If an extracted unit relates to an existing decision above, add a "relates_to" field:
  • "supersedes": this unit replaces/updates the existing decision (same subject, new info)
  • "builds_on": this unit extends or adds context to the existing decision
  • Only link when there is a clear semantic relationship, NOT just keyword overlap

Return ONLY a JSON array:
[{"kind":"...","topic":"...","summary":"...","details":"...","confidence":0.9,"relates_to":{"id":"decision_xxx","type":"builds_on"}}]
The "relates_to" field is optional — omit it when no existing decision is related.

Conversation:
${conversationText}`;
}

export function parseExtractionResponse(response: string): ExtractedMemoryUnit[] {
  if (!response || response.trim().length === 0) {
    return [];
  }

  let jsonStr = response;

  // Try extracting from markdown code fences
  const fenceMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1];
  }

  // Try extracting bare JSON array
  if (!jsonStr.trimStart().startsWith('[')) {
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonStr = arrayMatch[0];
    }
  }

  let parsed: unknown[];
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter((item): item is Record<string, unknown> => {
      if (typeof item !== 'object' || item === null) return false;
      const obj = item as Record<string, unknown>;
      return (
        typeof obj.kind === 'string' &&
        VALID_KINDS.has(obj.kind) &&
        typeof obj.topic === 'string' &&
        obj.topic.length > 0 &&
        typeof obj.summary === 'string' &&
        obj.summary.length > 0
      );
    })
    .map((item) => {
      const relatesTo = item.relates_to as { id?: string; type?: string } | undefined;
      return {
        kind: item.kind as MemoryKind,
        topic: String(item.topic),
        summary: String(item.summary).slice(0, 200),
        details: typeof item.details === 'string' ? String(item.details) : String(item.summary),
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
        relates_to:
          relatesTo &&
          typeof relatesTo.id === 'string' &&
          typeof relatesTo.type === 'string' &&
          ['supersedes', 'builds_on', 'debates'].includes(relatesTo.type)
            ? { id: relatesTo.id, type: relatesTo.type as 'supersedes' | 'builds_on' | 'debates' }
            : undefined,
      };
    });
}
