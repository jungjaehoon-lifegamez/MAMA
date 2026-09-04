/**
 * Marker vocabulary for detecting durable owner instructions in chat.
 *
 * Vocabulary is DATA. English defaults ship here; the owner's own language lives in runtime
 * config at ~/.mama/operator/locale.json (or MAMA_OPERATOR_LOCALE_PATH) under the key
 * `learningMarkers`. This file carries no non-English strings and no business vocabulary,
 * and a test pins that.
 *
 * Classification (mechanism ported from Kagemusha's experience-signal extractor): a message
 * classifies only when it carries a TOPIC NOUN and a DURABLE marker and NO one-off veto.
 * A durable-rule marker yields `policy`; a correction marker alone yields `lesson`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LearningMarkerConfig {
  durableRule: string[];
  correction: string[];
  oneOffVeto: string[];
  topicNouns: Record<string, string[]>;
}

export const DEFAULT_LEARNING_MARKERS: LearningMarkerConfig = {
  durableRule: ['always', 'from now on', 'going forward', 'treat * as', 'every time'],
  correction: ['not * but', "don't", 'do not', 'instead of', 'stop doing', 'never'],
  oneOffVeto: ['today only', 'this time', 'just once', 'for now', 'only now'],
  topicNouns: {
    lifecycle: ['review', 'done', 'complete', 'deadline', 'status', 'lifecycle', 'submitted'],
    report: ['report', 'briefing', 'summary', 'board', 'slot'],
    file: ['file', 'spreadsheet', 'export', 'upload', 'drive'],
    task: ['task', 'ticket', 'card', 'item', 'assignee'],
  },
};

export interface DurableInstruction {
  kind: 'policy' | 'lesson' | 'none';
  topicNoun?: string;
  matchedMarkers: string[];
  /** Why it was or was not classified; goes into the audit log. */
  reason: string;
}

export function learningMarkersPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAMA_OPERATOR_LOCALE_PATH || join(homedir(), '.mama', 'operator', 'locale.json');
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : null;
}

/** Defaults merged with the owner's overrides; overrides ADD to a list, never replace it. */
export function loadLearningMarkers(env: NodeJS.ProcessEnv = process.env): LearningMarkerConfig {
  const path = learningMarkersPath(env);
  const merged: LearningMarkerConfig = {
    durableRule: [...DEFAULT_LEARNING_MARKERS.durableRule],
    correction: [...DEFAULT_LEARNING_MARKERS.correction],
    oneOffVeto: [...DEFAULT_LEARNING_MARKERS.oneOffVeto],
    topicNouns: Object.fromEntries(
      Object.entries(DEFAULT_LEARNING_MARKERS.topicNouns).map(([k, v]) => [k, [...v]])
    ),
  };
  if (!existsSync(path)) {
    return merged;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(
      `learning markers: ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  const section =
    typeof parsed === 'object' && parsed !== null
      ? ((parsed as Record<string, unknown>).learningMarkers as Record<string, unknown> | undefined)
      : undefined;
  if (!section || typeof section !== 'object') {
    return merged;
  }
  for (const key of ['durableRule', 'correction', 'oneOffVeto'] as const) {
    const extra = stringList(section[key]);
    if (extra) {
      merged[key] = [...new Set([...merged[key], ...extra])];
    }
  }
  if (typeof section.topicNouns === 'object' && section.topicNouns !== null) {
    for (const [noun, words] of Object.entries(section.topicNouns as Record<string, unknown>)) {
      const extra = stringList(words);
      if (extra) {
        merged.topicNouns[noun] = [...new Set([...(merged.topicNouns[noun] ?? []), ...extra])];
      }
    }
  }
  return merged;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A marker is a phrase; `*` inside it matches a short run of words. */
function markerRegex(marker: string): RegExp {
  const parts = marker.split('*').map((part) => escapeRegExp(part.trim()));
  const body = parts.join('\\s+\\S+(?:\\s+\\S+){0,3}\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

function firstMatch(text: string, markers: string[]): string | null {
  for (const marker of markers) {
    if (markerRegex(marker).test(text)) {
      return marker;
    }
  }
  return null;
}

export function detectDurableInstruction(
  text: string,
  cfg: LearningMarkerConfig = DEFAULT_LEARNING_MARKERS
): DurableInstruction {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return { kind: 'none', matchedMarkers: [], reason: 'empty message' };
  }
  const veto = firstMatch(normalized, cfg.oneOffVeto);
  if (veto) {
    return { kind: 'none', matchedMarkers: [veto], reason: `one-off veto marker: ${veto}` };
  }
  let topicNoun: string | undefined;
  for (const [noun, words] of Object.entries(cfg.topicNouns)) {
    if (firstMatch(normalized, words)) {
      topicNoun = noun;
      break;
    }
  }
  const durable = firstMatch(normalized, cfg.durableRule);
  const correction = firstMatch(normalized, cfg.correction);
  if (!topicNoun) {
    return {
      kind: 'none',
      matchedMarkers: [durable, correction].filter((m): m is string => m !== null),
      reason: 'no topic noun',
    };
  }
  if (durable) {
    return {
      kind: 'policy',
      topicNoun,
      matchedMarkers: [durable, ...(correction ? [correction] : [])],
      reason: `durable-rule marker: ${durable}`,
    };
  }
  if (correction) {
    return {
      kind: 'lesson',
      topicNoun,
      matchedMarkers: [correction],
      reason: `correction marker: ${correction}`,
    };
  }
  return { kind: 'none', topicNoun, matchedMarkers: [], reason: 'topic noun without a marker' };
}
