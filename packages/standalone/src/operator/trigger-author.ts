/**
 * trigger-author - Task 3, the heart (G1 + G3).
 *
 * The agent recognizes a recurring situation in a window of polled events and AUTHORS a
 * trigger (its match keywords, memoryQuery, procedure, requiredEvidence). This replaces both
 * Kagemusha's hardcoded regex markers (G1) and its 4-profile executable catalog (G3).
 *
 * The agent is injected (`AskAgent`) so the flow is deterministic + unit-testable; the real
 * claude-CLI agent is `askAgentCLI`, exercised by the LLM eval.
 *
 * G3 GUARD: validation is STRUCTURAL only. `kind` and `procedure[].action` are open strings;
 * unknown VALUES are accepted. Never narrow them to a fixed enum - that re-freezes G3.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OperatorChannelEvent } from './operator-interfaces.js';
import type { CreateTriggerInput, TriggerRecord } from './trigger-types.js';
import type { TriggerRegistry } from './trigger-registry.js';

const execFileAsync = promisify(execFile);

/** Injected agent: prompt in, raw text answer out. */
export type AskAgent = (prompt: string) => Promise<string>;

/** What the agent returns (a CreateTriggerInput minus server-managed fields). */
export interface TriggerSpec {
  id?: string;
  kind: string;
  memoryQuery: string;
  match: { keywords: string[]; keywordMode: 'any' | 'every'; scopeChannelIds?: string[]; minConfidence: number };
  procedure: { action: string; description: string }[];
  requiredEvidence: string[];
}

export interface AuthorOptions {
  note?: string;
}

export async function authorTriggers(
  events: OperatorChannelEvent[],
  registry: TriggerRegistry,
  askAgent: AskAgent,
  opts: AuthorOptions = {}
): Promise<TriggerRecord[]> {
  const existing = registry.listActive();
  const prompt = buildAuthorPrompt(events, existing);
  const answer = await askAgent(prompt);
  const specs = parseTriggerSpecs(answer); // throws on unparseable output (no-fallback)

  const created: TriggerRecord[] = [];
  const seen = existing.map((t) => ({ keywords: t.match.keywords, scopeChannelIds: t.match.scopeChannelIds }));
  for (const spec of specs) {
    if (isDuplicate(spec, seen)) continue;
    const id = spec.id ?? deriveId(spec);
    if (registry.getById(id)) continue;
    const input: CreateTriggerInput = {
      id,
      kind: spec.kind,
      memoryQuery: spec.memoryQuery,
      match: spec.match,
      procedure: spec.procedure,
      requiredEvidence: spec.requiredEvidence,
      authoredBy: 'agent',
      provenance: { createdFrom: 'agent-authored', note: opts.note ?? '' },
    };
    created.push(registry.create(input));
    seen.push({ keywords: spec.match.keywords, scopeChannelIds: spec.match.scopeChannelIds });
  }
  return created;
}

export function buildAuthorPrompt(events: OperatorChannelEvent[], existing: TriggerRecord[]): string {
  // English default. Personal phrasing overrides load from ~/.mama/operator/*.json (later refinement).
  const window = events.map((e) => `- [${e.channelId}] ${e.content}`).join('\n');
  const existingList =
    existing.length === 0
      ? '(none yet)'
      : existing.map((t) => `- ${t.id}: keywords=[${t.match.keywords.join(', ')}] memoryQuery="${t.memoryQuery}"`).join('\n');
  return [
    'You maintain a personal operator\'s library of TRIGGERS. A trigger fires on future messages',
    'that match its keywords and then recalls a memory to help the operator intervene proactively.',
    '',
    'Look at the recent messages below. Propose new triggers ONLY for situations that genuinely',
    'RECUR (appear repeatedly, possibly phrased differently). Do NOT create triggers for one-off',
    'messages. If nothing recurs, return an empty array.',
    '',
    'Recent messages:',
    window,
    '',
    'Existing triggers (do not duplicate these):',
    existingList,
    '',
    'Return ONLY a JSON array (no prose) of trigger objects with this shape:',
    '[{ "kind": string, "memoryQuery": string,',
    '   "match": { "keywords": string[], "keywordMode": "any"|"every", "minConfidence": number },',
    '   "procedure": [{ "action": string, "description": string }],',
    '   "requiredEvidence": string[] }]',
    'kind and action are free text you choose - describe the situation and steps in your own words.',
  ].join('\n');
}

export function parseTriggerSpecs(text: string): TriggerSpec[] {
  const arr = extractJsonArray(stripCodeFences(text));
  if (arr === null) throw new Error('agent output contained no JSON array of trigger specs');
  let parsed: unknown;
  try {
    parsed = JSON.parse(arr);
  } catch (error) {
    throw new Error(`agent trigger JSON did not parse: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('agent trigger JSON was not an array');
  return parsed.map(validateTriggerSpec);
}

export function validateTriggerSpec(spec: unknown): TriggerSpec {
  if (!isObject(spec)) throw new Error('trigger spec must be an object');
  const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

  if (!nonEmptyString(spec.kind)) throw new Error('trigger.kind must be a non-empty string');
  if (!nonEmptyString(spec.memoryQuery)) throw new Error('trigger.memoryQuery must be a non-empty string');

  if (!isObject(spec.match)) throw new Error('trigger.match must be an object');
  const match = spec.match;
  if (!Array.isArray(match.keywords) || match.keywords.length === 0 || !match.keywords.every(nonEmptyString)) {
    throw new Error('trigger.match.keywords must be a non-empty string[]');
  }
  if (match.keywordMode !== 'any' && match.keywordMode !== 'every') {
    throw new Error("trigger.match.keywordMode must be 'any' or 'every'");
  }
  if (typeof match.minConfidence !== 'number') throw new Error('trigger.match.minConfidence must be a number');
  if (
    match.scopeChannelIds !== undefined &&
    (!Array.isArray(match.scopeChannelIds) || !match.scopeChannelIds.every((c) => typeof c === 'string'))
  ) {
    throw new Error('trigger.match.scopeChannelIds must be string[] when present');
  }

  if (
    !Array.isArray(spec.procedure) ||
    !spec.procedure.every((p) => isObject(p) && typeof p.action === 'string' && typeof p.description === 'string')
  ) {
    throw new Error('trigger.procedure must be an array of {action, description}');
  }
  if (!Array.isArray(spec.requiredEvidence) || !spec.requiredEvidence.every((e) => typeof e === 'string')) {
    throw new Error('trigger.requiredEvidence must be string[]');
  }

  // Deliberately NO check of kind/action VALUES against any catalog (G3 guard).
  return {
    id: typeof spec.id === 'string' ? spec.id : undefined,
    kind: spec.kind,
    memoryQuery: spec.memoryQuery,
    match: {
      keywords: match.keywords as string[],
      keywordMode: match.keywordMode,
      minConfidence: match.minConfidence,
      scopeChannelIds: match.scopeChannelIds as string[] | undefined,
    },
    procedure: spec.procedure as { action: string; description: string }[],
    requiredEvidence: spec.requiredEvidence as string[],
  };
}

/** Real agent: the local claude CLI (CLI-over-API). Used by the LLM eval, not unit tests. */
export const askAgentCLI: AskAgent = async (prompt) => {
  const { stdout } = await execFileAsync('claude', ['-p', prompt, '--output-format', 'json'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { type?: string; result?: unknown };
  if (parsed.type === 'result' && typeof parsed.result === 'string') return parsed.result;
  throw new Error('claude CLI did not return a text result');
};

// ---- helpers ----

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?/gi, '');
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function normalizedKeywordSet(keywords: string[]): string {
  return [...new Set(keywords.map((k) => k.trim().toLocaleLowerCase()))].sort().join('|');
}

function isDuplicate(spec: TriggerSpec, seen: { keywords: string[]; scopeChannelIds?: string[] }[]): boolean {
  const specKeys = normalizedKeywordSet(spec.match.keywords);
  const specScope = (spec.match.scopeChannelIds ?? []).slice().sort().join(',');
  return seen.some(
    (s) => normalizedKeywordSet(s.keywords) === specKeys && (s.scopeChannelIds ?? []).slice().sort().join(',') === specScope
  );
}

function deriveId(spec: TriggerSpec): string {
  const hash = createHash('sha256')
    .update(`${spec.kind}\n${normalizedKeywordSet(spec.match.keywords)}`)
    .digest('hex')
    .slice(0, 12);
  return `trigger.${hash}`;
}
