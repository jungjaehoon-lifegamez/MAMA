import { InvalidEntityLabelError } from './errors.js';

export type EntityScript = 'Latn' | 'Hang' | 'Jpan' | 'Mixed' | 'Unknown';

export interface NormalizedEntityLabel {
  original: string;
  normalized: string;
  script: EntityScript;
}

const LATIN_RE = /\p{Script=Latin}/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
const HIRAGANA_RE = /\p{Script=Hiragana}/u;
const KATAKANA_RE = /\p{Script=Katakana}/u;
const HAN_RE = /\p{Script=Han}/u;

function collapseWhitespace(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function detectScript(input: string): EntityScript {
  const hasLatin = LATIN_RE.test(input);
  const hasHangul = HANGUL_RE.test(input);
  const hasJapanese = HIRAGANA_RE.test(input) || KATAKANA_RE.test(input) || HAN_RE.test(input);

  const activeScripts = [hasLatin, hasHangul, hasJapanese].filter(Boolean).length;

  if (activeScripts > 1) {
    return 'Mixed';
  }
  if (hasHangul) {
    return 'Hang';
  }
  if (hasJapanese) {
    return 'Jpan';
  }
  if (hasLatin) {
    return 'Latn';
  }
  return 'Unknown';
}

export function normalizeEntityLabel(input: unknown): NormalizedEntityLabel {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new InvalidEntityLabelError({
      input,
      reason: typeof input === 'string' ? 'empty_string' : 'non_string_input',
    });
  }

  const original = input;
  const collapsed = collapseWhitespace(input);
  const script = detectScript(collapsed);
  const normalized = script === 'Latn' ? collapsed.toLowerCase() : collapsed;

  return {
    original,
    normalized,
    script,
  };
}

export function extractStructuredIdentifiers(input: string): {
  emails: string[];
  handles: string[];
  domains: string[];
} {
  const emails = Array.from(
    new Set(
      (input.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu) ?? []).map((v) =>
        v.toLowerCase()
      )
    )
  );
  const handles = Array.from(
    new Set(
      (input.match(/(?<!\w)@([a-z0-9_][a-z0-9_.-]*)/giu) ?? []).map((v) => v.slice(1).toLowerCase())
    )
  );
  const domains = Array.from(
    new Set(
      (input.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/giu) ?? [])
        .map((v) => v.toLowerCase())
        .filter((v) => !emails.some((email) => email.endsWith(`@${v}`)))
    )
  );

  return {
    emails,
    handles,
    domains,
  };
}
