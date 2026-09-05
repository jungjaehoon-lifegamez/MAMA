/**
 * Progressive board_read views (Task B, parent-fix P3/P5).
 *
 * The default read is descriptors only - each slot's name, updatedAt and stored
 * HTML length in Unicode code points - never the full HTML. To read a slot the
 * caller names it and a format: `text` extracts the slot's text with a real
 * non-executing HTML parser (block/list/table breaks preserved, entities decoded,
 * script/style bodies dropped - markup is never executed or fetched) and `html`
 * returns the stored markup verbatim. Either way the content is paged by Unicode
 * code points with offset/limit and total/nextOffset, and every selected read
 * carries a readVersion bound to (slot, format, content): a continuation (offset
 * > 0) must echo it, so a document that changes between chunks is caught rather
 * than silently mixed. The default deliberately does not invent a summary.
 */

import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';

export type BoardSlots = Record<string, { html: string; updatedAt?: string | null }>;

const CONTENT_DEFAULT_LIMIT = 1000;
const CONTENT_MAX_LIMIT = 4000;
const FORMATS = ['text', 'html'] as const;
type BoardFormat = (typeof FORMATS)[number];

export interface BoardSlotDescriptor {
  name: string;
  updatedAt: string | null;
  /** Stored HTML length in Unicode code points (NOT the extracted-text length). */
  htmlLength: number;
}

export type BoardReadResult =
  | { success: true; slots: BoardSlotDescriptor[] }
  | {
      success: true;
      slot: string;
      format: BoardFormat;
      content: string;
      /** Unicode code-point offset this window starts at. */
      offset: number;
      limit: number;
      /** Total length of the selected representation in Unicode code points. */
      total: number;
      /** Next code-point offset, or null when this window ends the slot. */
      nextOffset: number | null;
      complete: boolean;
      /** Binds (slot, format, content); a continuation must echo it or restart. */
      readVersion: string;
    };

export function readBoardView(rawInput: unknown, slots: BoardSlots): BoardReadResult {
  const input = asObject(rawInput, 'board_read');
  if (input.slot === undefined) {
    return { success: true, slots: describeSlots(slots) };
  }
  if (typeof input.slot !== 'string' || input.slot.trim().length === 0) {
    throw new Error('board_read slot must be a slot name; omit slot for the descriptor list.');
  }
  const slot = input.slot;
  const entry = Object.prototype.hasOwnProperty.call(slots, slot) ? slots[slot] : undefined;
  if (!entry) {
    throw new Error(
      `board_read unknown slot '${slot}'; call board_read with no slot to list available slots.`
    );
  }
  const format = parseFormat(input.format);
  const offset = parseNonNegativeInt(input.offset, 'offset');
  const limit = parseBoundedInt(input.limit, 'limit', CONTENT_DEFAULT_LIMIT, CONTENT_MAX_LIMIT);
  // Normalize once: a missing html (despite the nominal type) is an empty slot,
  // not a throw. The same normalized value backs both the representation and the
  // content version, so a text read, an html read and readVersion all agree.
  const html = entry.html ?? '';
  const representation = format === 'html' ? html : extractText(html);
  const readVersion = contentVersion(slot, format, html);
  // Continuation must be pinned: a document that changed between chunks would
  // otherwise splice two versions at a raw offset. Page 1 (offset 0) issues the
  // version; every later page must echo the one it was handed.
  validateContinuationVersion(input.readVersion, readVersion, offset, 'board_read');
  const points = Array.from(representation);
  const total = points.length;
  const start = Math.min(offset, total);
  const slice = points.slice(start, start + limit);
  const end = start + slice.length;
  const nextOffset = end < total ? end : null;
  return {
    success: true,
    slot,
    format,
    content: slice.join(''),
    offset,
    limit,
    total,
    nextOffset,
    complete: nextOffset === null,
    readVersion,
  };
}

function describeSlots(slots: BoardSlots): BoardSlotDescriptor[] {
  return Object.entries(slots).map(([name, value]) => ({
    name,
    updatedAt: value.updatedAt ?? null,
    htmlLength: Array.from(value.html ?? '').length,
  }));
}

function contentVersion(slot: string, format: BoardFormat, html: string): string {
  return createHash('sha256')
    .update(`${slot}\0${format}\0${html}`)
    .digest('base64url')
    .slice(0, 22);
}

/** Block-level tags whose boundary is a line break in the extracted text. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'nav',
  'main',
  'figure',
  'figcaption',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
]);
const CELL_TAGS = new Set(['td', 'th']);

/**
 * Remove markup with a real non-executing parser. Script and style bodies are
 * display-irrelevant and dropped; block/list/table boundaries become line breaks
 * and cells are tab-separated; entities (named and numeric) are decoded by the
 * tokenizer. No DOM tree, no evaluation, no fetch - the parser only tokenizes.
 */
function extractText(html: string): string {
  const parts: string[] = [];
  let skipDepth = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === 'script' || name === 'style') {
          skipDepth += 1;
        } else if (name === 'br') {
          parts.push('\n');
        } else if (BLOCK_TAGS.has(name)) {
          parts.push('\n');
        }
      },
      ontext(text) {
        if (skipDepth === 0) parts.push(text);
      },
      onclosetag(name) {
        if (name === 'script' || name === 'style') {
          if (skipDepth > 0) skipDepth -= 1;
        } else if (CELL_TAGS.has(name)) {
          parts.push('\t');
        } else if (BLOCK_TAGS.has(name)) {
          parts.push('\n');
        }
      },
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();
  return normalizeText(parts.join(''));
}

/** Collapse runs of blank lines and trailing cell tabs; keep intentional breaks. */
function normalizeText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\t+\n/g, '\n')
    .trim();
}

export function validateContinuationVersion(
  supplied: unknown,
  current: string,
  offset: number,
  tool: string
): void {
  if (offset > 0 && supplied === undefined) {
    throw new Error(
      `${tool} continuation (offset > 0) requires the readVersion from the previous page; restart from offset 0.`
    );
  }
  if (supplied !== undefined && supplied !== current) {
    throw new Error(
      `${tool} content changed since this readVersion was issued; restart the read from offset 0.`
    );
  }
}

function parseFormat(value: unknown): BoardFormat {
  if (value === undefined) return 'text';
  if (typeof value !== 'string' || !(FORMATS as readonly string[]).includes(value)) {
    throw new Error(`board_read format must be one of ${FORMATS.join('|')}.`);
  }
  return value as BoardFormat;
}

function parseNonNegativeInt(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`board_read ${field} must be a non-negative integer.`);
  }
  return value as number;
}

function parseBoundedInt(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`board_read ${field} must be an integer from 1 to ${max}.`);
  }
  return value as number;
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} input must be an object.`);
  }
  return value as Record<string, unknown>;
}
