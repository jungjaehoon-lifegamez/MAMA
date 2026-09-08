/**
 * Outbound Telegram formatting: Telegram HTML subset -> MessageEntity list.
 *
 * The model writes a small HTML subset (b/strong, i/em, u, s/del, code, pre,
 * tg-spoiler, blockquote, a href). This module converts that markup into the
 * `{ text, entities }` pair Telegram's sendMessage/editMessageText accept, and
 * splits the result into transport-sized chunks with the entity spans mapped
 * onto each chunk.
 *
 * Entities, not `parse_mode`: a long answer has to be split, and a chunk
 * boundary can fall inside a tag pair. Offsets survive splitting; raw HTML does
 * not.
 *
 * Any input the parser cannot read as that subset is returned verbatim with no
 * entities. Plain text is therefore always deliverable and never mangled: an
 * unknown tag, an unclosed tag, an attribute we do not accept, or a nesting the
 * subset forbids all degrade to literal text rather than to an error.
 *
 * Offsets and lengths are counted in UTF-16 code units, which is what Telegram
 * counts for both entity spans and the 4096 message limit.
 */

import type { TelegramTextEntity } from './telegram-text-entities.js';

export interface TelegramFormattedText {
  text: string;
  entities: TelegramTextEntity[];
}

export type TelegramChunkFormat = 'plain-v1' | 'html-v1';

/** Telegram's per-message text limit, in UTF-16 code units. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Prefer a newline boundary only when it is late enough in the chunk; an early
 * newline would produce many tiny messages out of one answer.
 */
const NEWLINE_SPLIT_FLOOR = 0.3;

const TAG_TYPES: Record<string, string> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  s: 'strikethrough',
  del: 'strikethrough',
  code: 'code',
  pre: 'pre',
  'tg-spoiler': 'spoiler',
  blockquote: 'blockquote',
  a: 'text_link',
};

const LINK_PROTOCOLS = ['https:', 'http:', 'mailto:'];

/** The one tag scan this module has. Shared by the parser and the snapshot closer. */
const TAG_SCAN = /<\/?[a-z][^>]*>/gi;
const CLOSING_TAG = /^<\/([a-z-]+)\s*>$/i;
const OPENING_TAG = /^<([a-z-]+)([^>]*)>$/i;
const TRAILING_OPENING_TAG = /<[a-z][^>]*>$/i;

/**
 * The producer half of this module. The parser above can only read the subset
 * the model was actually told to write, so the contract and its reader ship
 * together: changing one without the other is what silently degrades every
 * answer to literal text.
 *
 * Loaded once with the owner session, regardless of which input starts it.
 */
export const TELEGRAM_FORMAT_GUIDE = [
  'Apply the following only to messages delivered via Telegram, including telegram_send.',
  'Telegram message formatting: write the body in the Telegram HTML text subset.',
  '- Allowed tags only: <b> <i> <u> <s> <code> <pre> <tg-spoiler> <blockquote> <a href="...">.',
  '- Use real newlines. For lists use a plain marker such as "-" or numbers.',
  '- No Markdown (no **bold**, no # headings, no tables) and no div/span/br or CSS.',
  '- Escape literal &, <, > and " in text and URLs as &amp;, &lt;, &gt; and &quot;.',
  '- Close every tag you open. Nothing may nest inside <code> or <pre>, and <code> and <pre>',
  '  must not appear inside any other tag (no <pre> inside <blockquote>, no <code> inside a link).',
  '- Links must be http, https or mailto.',
  '- Keep emphasis for headings and key actions; unstyled prose reads better than styled prose.',
  '- Never write entity JSON, offsets or lengths. The sender converts this HTML into Telegram',
  '  entities and splits long messages for you.',
].join('\n');

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };
  return text.replace(/&(amp|lt|gt|quot|#\d+|#x[\da-f]+);/gi, (raw, value: string) => {
    if (!value.startsWith('#')) return named[value.toLowerCase()] ?? raw;
    const point =
      value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : raw;
  });
}

/**
 * Read the HTML subset. Returns the input verbatim with no entities as soon as
 * anything outside the subset appears: unreadable markup must reach the owner
 * as text, never as a dropped or half-styled message.
 */
function parseTelegramHtml(text: string): TelegramFormattedText {
  const literal: TelegramFormattedText = { text, entities: [] };
  const entities: TelegramTextEntity[] = [];
  const stack: Array<{ tag: string; entity: TelegramTextEntity }> = [];
  let plain = '';
  let cursor = 0;
  for (const match of text.matchAll(TAG_SCAN)) {
    const at = match.index ?? 0;
    plain += decodeEntities(text.slice(cursor, at));
    cursor = at + match[0].length;
    const closing = CLOSING_TAG.exec(match[0]);
    if (closing) {
      const opened = stack.pop();
      if (!opened || opened.tag !== closing[1].toLowerCase()) return literal;
      opened.entity.length = plain.length - opened.entity.offset;
      if (opened.entity.length) entities.push(opened.entity);
      continue;
    }
    const opening = OPENING_TAG.exec(match[0]);
    if (!opening) return literal;
    const tag = opening[1].toLowerCase();
    const type = TAG_TYPES[tag];
    if (!type) return literal;
    const entity: TelegramTextEntity = { type, offset: plain.length, length: 0 };
    if (tag === 'a') {
      const href = /^\s+href="([^"]+)"\s*$/.exec(opening[2]);
      if (!href) return literal;
      entity.url = decodeEntities(href[1]);
      try {
        if (!LINK_PROTOCOLS.includes(new URL(entity.url).protocol)) return literal;
      } catch {
        return literal;
      }
    } else if (opening[2].trim()) {
      return literal;
    }
    const insideVerbatim = stack.some((open) => ['code', 'pre'].includes(open.entity.type));
    const verbatimInsideAnything = ['code', 'pre'].includes(type) && stack.length > 0;
    const repeatedSelfNesting =
      ['text_link', 'blockquote'].includes(type) && stack.some((open) => open.entity.type === type);
    if (insideVerbatim || verbatimInsideAnything || repeatedSelfNesting) return literal;
    stack.push({ tag, entity });
  }
  if (stack.length) return literal;
  plain += decodeEntities(text.slice(cursor));
  return {
    text: plain,
    entities: entities.sort((a, b) => a.offset - b.offset || b.length - a.length),
  };
}

/**
 * Make a mid-stream snapshot readable by the parser above.
 *
 * A streaming snapshot is cut at an arbitrary character: it can end inside a
 * tag, and it almost always leaves tags open. Either one makes the WHOLE
 * snapshot literal, so the owner watches the placeholder flicker between styled
 * text and raw markup. Drop the partial tag at the end and close what is still
 * open, using the same tag scan the parser uses.
 *
 * A snapshot the scan cannot follow is returned as-is: the parser then falls
 * back to literal text, which is the existing behaviour, not a new one.
 */
export function closeOpenTelegramHtml(snapshot: string): string {
  const lastOpen = snapshot.lastIndexOf('<');
  let text =
    lastOpen >= 0 && snapshot.indexOf('>', lastOpen) < 0 ? snapshot.slice(0, lastOpen) : snapshot;
  // A tag the stream has opened but not yet filled encloses nothing. Closing it
  // would build markup around no text, and `formatTelegramMessage` shows THAT
  // literally rather than send an empty message. Drop it instead.
  for (
    let empty = TRAILING_OPENING_TAG.exec(text);
    empty;
    empty = TRAILING_OPENING_TAG.exec(text)
  ) {
    text = text.slice(0, -empty[0].length);
  }
  const open: string[] = [];
  for (const match of text.matchAll(TAG_SCAN)) {
    const closing = CLOSING_TAG.exec(match[0]);
    if (closing) {
      if (open.pop() !== closing[1].toLowerCase()) return text;
      continue;
    }
    const opening = OPENING_TAG.exec(match[0]);
    if (!opening || !TAG_TYPES[opening[1].toLowerCase()]) return text;
    open.push(opening[1].toLowerCase());
  }
  let closed = text;
  while (open.length) closed += `</${open.pop()}>`;
  return closed;
}

/**
 * Convert one model answer into the chunks the transport sends, in order.
 * An empty input yields no chunks.
 */
export function formatTelegramMessage(
  input: string,
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH,
  chunkFormat: TelegramChunkFormat = 'html-v1'
): TelegramFormattedText[] {
  // Old pending receipts count code points in the original, unparsed text.
  // Keep those exact boundaries until that delivery finishes after an upgrade.
  if (chunkFormat === 'plain-v1') {
    const points = Array.from(input);
    const chunks: TelegramFormattedText[] = [];
    for (let start = 0; start < points.length; ) {
      const candidate = points.slice(start, start + maxLength);
      const newline = candidate.lastIndexOf('\n');
      const length =
        points.length - start > maxLength && newline > maxLength * NEWLINE_SPLIT_FLOOR
          ? newline + 1
          : candidate.length;
      chunks.push({ text: points.slice(start, start + length).join(''), entities: [] });
      start += length;
    }
    return chunks;
  }
  const parsed = parseTelegramHtml(input);
  // A parse can succeed and still leave nothing to send: `<b></b>` is readable
  // markup around no text. Zero chunks would let the transport report the
  // answer delivered without one API call and leave the placeholder standing
  // forever, so a non-empty answer always degrades to its literal source.
  const collapsed = input.length > 0 && parsed.text.length === 0;
  const text = collapsed ? input : parsed.text;
  const entities: TelegramTextEntity[] = collapsed ? [] : parsed.entities;
  const limit = Math.max(1, Math.floor(maxLength));
  const chunks: TelegramFormattedText[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline > start + limit * NEWLINE_SPLIT_FLOOR) end = newline + 1;
      // Never end a chunk on a lone high surrogate: Telegram would receive a
      // broken code point and the next chunk would start on its other half.
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    }
    // Backing off the surrogate can empty the chunk; take the whole pair
    // rather than emit the lone high surrogate the back-off just avoided.
    if (end <= start) end = Math.min(start + 2, text.length);
    const from = start;
    const to = end;
    chunks.push({
      text: text.slice(from, to),
      entities: entities.flatMap((entity) => {
        const spanStart = Math.max(from, entity.offset);
        const spanEnd = Math.min(to, entity.offset + entity.length);
        return spanStart < spanEnd
          ? [{ ...entity, offset: spanStart - from, length: spanEnd - spanStart }]
          : [];
      }),
    });
    start = end;
  }
  return chunks;
}

/**
 * True when Telegram rejected the entity list itself. The transport then
 * resends the same text without entities: the owner must get the answer even
 * when the styling is unusable.
 *
 * Deliberately wide. Telegram words these 400s inconsistently, and every
 * wording we fail to recognise costs the owner the whole answer to save a
 * styling that is already lost. An unrelated 400 (chat not found, bot blocked)
 * still fails, because resending it unstyled would fail identically.
 */
export function isTelegramEntityRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /can't parse entities|unsupported url protocol/i.test(message) ||
    (/entit(?:y|ies)/i.test(message) && /invalid|out of range|too many/i.test(message))
  );
}
