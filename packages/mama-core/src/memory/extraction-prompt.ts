import {
  MEMORY_KINDS,
  type ConversationMessage,
  type ExtractedMemoryUnit,
  type MemoryKind,
} from './types.js';

const VALID_KINDS = new Set<string>(MEMORY_KINDS);

export function buildExtractionPrompt(messages: ConversationMessage[]): string {
  const conversationText = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

  return `You are extracting structured memory units from a conversation.

Read the conversation and identify distinct pieces of information worth remembering.
Classify each as one of: preference, fact, decision, lesson, constraint.

Rules:
- topic: lowercase_snake_case, reuse existing topics when same subject
- summary: concise (<200 chars), must include key entities/numbers/names
- details: full context with evidence from the conversation
- confidence: 0.0-1.0 based on how explicitly stated the information is
- For preferences: state what IS preferred and what is NOT (if mentioned)
- For countable facts: enumerate items explicitly (e.g., "Projects: 1. X, 2. Y, 3. Z")
- Skip small talk and meta-conversation
- Merge related facts into one unit when they share a topic

Return ONLY a JSON array:
[{"kind":"...","topic":"...","summary":"...","details":"...","confidence":0.9}]

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
    .map((item) => ({
      kind: item.kind as MemoryKind,
      topic: String(item.topic),
      summary: String(item.summary).slice(0, 200),
      details: typeof item.details === 'string' ? String(item.details) : String(item.summary),
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
    }));
}
