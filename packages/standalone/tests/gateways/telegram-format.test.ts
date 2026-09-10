import { describe, expect, it } from 'vitest';

import {
  closeOpenTelegramHtml,
  formatTelegramMessage,
  isTelegramEntityRejection,
  TELEGRAM_FORMAT_GUIDE,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from '../../src/gateways/telegram-format.js';

describe('Story TG-01/TG-06: Telegram formatting', () => {
  describe('AC: final chunks preserve text and entity boundaries', () => {
    it('leaves plain text untouched and adds no entities', () => {
      const chunks = formatTelegramMessage('line one\nline two');

      expect(chunks).toEqual([{ text: 'line one\nline two', entities: [] }]);
    });

    it('returns no chunk for empty input', () => {
      expect(formatTelegramMessage('')).toEqual([]);
    });

    it('never returns zero chunks for a non-empty answer that parses to no text', () => {
      // Readable markup around nothing. Zero chunks would let the transport call
      // the answer delivered without one API call and strand the placeholder.
      expect(formatTelegramMessage('<b></b>')).toEqual([{ text: '<b></b>', entities: [] }]);
    });

    it('converts bold, italic, underline and strikethrough into entity spans', () => {
      const [chunk] = formatTelegramMessage('<b>Alpha</b> <i>beta</i> <u>gamma</u> <s>delta</s>');

      expect(chunk.text).toBe('Alpha beta gamma delta');
      expect(chunk.entities).toEqual([
        { type: 'bold', offset: 0, length: 5 },
        { type: 'italic', offset: 6, length: 4 },
        { type: 'underline', offset: 11, length: 5 },
        { type: 'strikethrough', offset: 17, length: 5 },
      ]);
    });

    it('accepts the alias tags for bold and italic', () => {
      const [chunk] = formatTelegramMessage('<strong>a</strong><em>b</em>');

      expect(chunk.text).toBe('ab');
      expect(chunk.entities.map((entity) => entity.type)).toEqual(['bold', 'italic']);
    });

    it('converts inline code and code blocks', () => {
      const [chunk] = formatTelegramMessage('id <code>abc-1</code>\n<pre>one\ntwo</pre>');

      expect(chunk.text).toBe('id abc-1\none\ntwo');
      expect(chunk.entities).toEqual([
        { type: 'code', offset: 3, length: 5 },
        { type: 'pre', offset: 9, length: 7 },
      ]);
    });

    it('converts a link into a text_link entity carrying the url', () => {
      const [chunk] = formatTelegramMessage('see <a href="https://example.com/x">the source</a>');

      expect(chunk.text).toBe('see the source');
      expect(chunk.entities).toEqual([
        { type: 'text_link', offset: 4, length: 10, url: 'https://example.com/x' },
      ]);
    });

    it('refuses a link protocol Telegram would not open', () => {
      const input = 'see <a href="javascript:alert(1)">here</a>';

      expect(formatTelegramMessage(input)).toEqual([{ text: input, entities: [] }]);
    });

    it('keeps list markers as literal text and styles only the marked span', () => {
      const [chunk] = formatTelegramMessage('- <b>first</b>\n- second\n1. third');

      expect(chunk.text).toBe('- first\n- second\n1. third');
      expect(chunk.entities).toEqual([{ type: 'bold', offset: 2, length: 5 }]);
    });

    it('decodes escaped angle brackets and ampersands into literal text', () => {
      const [chunk] = formatTelegramMessage('<b>a &amp; b</b> &lt;tag&gt;');

      expect(chunk.text).toBe('a & b <tag>');
      expect(chunk.entities).toEqual([{ type: 'bold', offset: 0, length: 5 }]);
    });

    it('nests non-verbatim styling', () => {
      const [chunk] = formatTelegramMessage('<b>bold <i>and italic</i></b>');

      expect(chunk.text).toBe('bold and italic');
      expect(chunk.entities).toEqual([
        { type: 'bold', offset: 0, length: 15 },
        { type: 'italic', offset: 5, length: 10 },
      ]);
    });

    it('closes a tag left open instead of degrading the whole message', () => {
      // Was whole-message literal. One forgotten closing tag used to make every
      // tag in the answer visible; now the span the author opened is closed.
      const [chunk] = formatTelegramMessage('report <b>never closed');

      expect(chunk.text).toBe('report never closed');
      expect(chunk.entities).toEqual([{ type: 'bold', offset: 7, length: 12 }]);
    });

    it('escapes a mismatched closing tag and keeps the surrounding span', () => {
      // Was whole-message literal.
      const [chunk] = formatTelegramMessage('<b>a</i>');

      expect(chunk.text).toBe('a</i>');
      expect(chunk.entities).toEqual([{ type: 'bold', offset: 0, length: 5 }]);
    });

    it('escapes a tag the author only mentioned, with no entity from it', () => {
      // Live 2026-09-10: the owner answer explained Telegram formatting and the
      // cited tag names took the WHOLE reply literal.
      const [chunk] = formatTelegramMessage('\uc11c\uc2dd(<b>, <i> \ub4f1)\uc744 \uc801\uc6a9');

      expect(chunk.text).toBe('\uc11c\uc2dd(<b>, <i> \ub4f1)\uc744 \uc801\uc6a9');
      expect(chunk.entities).toEqual([]);
    });

    it('renders a closed span and auto-closes an unclosed one in the same answer', () => {
      // The other live shape: a styled heading plus one unclosed tag.
      const [chunk] = formatTelegramMessage('<b>\uc81c\ubaa9</b> \ubcf8\ubc11 <i>\ubbf8\ub2eb\ud790');

      expect(chunk.text).toBe('\uc81c\ubaa9 \ubcf8\ubc11 \ubbf8\ub2eb\ud790');
      expect(chunk.entities).toEqual([
        { type: 'bold', offset: 0, length: 2 },
        { type: 'italic', offset: 6, length: 3 },
      ]);
    });

    it('keeps the rest of the markup when one tag is outside the subset', () => {
      const [chunk] = formatTelegramMessage('<div>x</div> <b>bold</b>');

      expect(chunk.text).toBe('<div>x</div> bold');
      expect(chunk.entities).toEqual([{ type: 'bold', offset: 13, length: 4 }]);
    });

    it('falls back to literal text for a tag outside the subset', () => {
      const input = '<div>block</div>';

      expect(formatTelegramMessage(input)).toEqual([{ text: input, entities: [] }]);
    });

    it('falls back to literal text for an unexpected attribute', () => {
      const input = '<b class="x">a</b>';

      expect(formatTelegramMessage(input)).toEqual([{ text: input, entities: [] }]);
    });

    it('escapes markup nested inside code and keeps the code span', () => {
      // Was whole-message literal. Nothing nests inside code: the inner tag
      // becomes text, the verbatim span it sits in still renders.
      const [chunk] = formatTelegramMessage('<code>a <b>b</b></code>');

      expect(chunk.text).toBe('a <b>b</b>');
      expect(chunk.entities).toEqual([{ type: 'code', offset: 0, length: 10 }]);
    });

    it('escapes code inside another tag and keeps the outer span', () => {
      // Was whole-message literal. The guide forbids both directions; the
      // forbidden span degrades, the one containing it does not.
      for (const [input, text, type] of [
        ['<blockquote>note <code>x</code></blockquote>', 'note <code>x</code>', 'blockquote'],
        ['<pre><code>x</code></pre>', '<code>x</code>', 'pre'],
        ['<a href="https://example.com"><code>x</code></a>', '<code>x</code>', 'text_link'],
      ] as const) {
        const [chunk] = formatTelegramMessage(input);

        expect(chunk.text).toBe(text);
        expect(chunk.entities.map((entity) => entity.type)).toEqual([type]);
      }
    });

    it('falls back to literal text for a tg: link', () => {
      // A tg: deep link is not in the guide, and Telegram rejects the entity with
      // an unsupported-protocol 400 the unstyled resend cannot recover from.
      const input = 'see <a href="tg://user?id=1">here</a>';

      expect(formatTelegramMessage(input)).toEqual([{ text: input, entities: [] }]);
    });

    it('keeps a bare less-than sign as text', () => {
      const chunks = formatTelegramMessage('threshold < 3 and 5 > 4');

      expect(chunks).toEqual([{ text: 'threshold < 3 and 5 > 4', entities: [] }]);
    });

    it('splits past the limit and preserves the whole text', () => {
      const text = 'a'.repeat(9000);

      const chunks = formatTelegramMessage(text);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
      }
      expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    });

    it('does not split a message that is exactly at the limit', () => {
      const text = 'a'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH);

      expect(formatTelegramMessage(text)).toHaveLength(1);
    });

    it('prefers a late newline as the split boundary', () => {
      const text = `${'a'.repeat(8)}\n${'b'.repeat(8)}`;

      const chunks = formatTelegramMessage(text, 10);

      expect(chunks.map((chunk) => chunk.text)).toEqual([`${'a'.repeat(8)}\n`, 'b'.repeat(8)]);
    });

    it('never splits a surrogate pair across chunks', () => {
      const text = `1234${String.fromCodePoint(0x1f600)}tail`;

      const chunks = formatTelegramMessage(text, 5);

      expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
      for (const chunk of chunks) {
        expect(/[\uD800-\uDBFF]$/.test(chunk.text)).toBe(false);
        expect(/^[\uDC00-\uDFFF]/.test(chunk.text)).toBe(false);
      }
    });

    it('never splits a surrogate pair at the real Telegram boundary', () => {
      // The boundary is counted in UTF-16 code units, so the pair straddles 4096
      // exactly: a code-point count would have measured this text as fitting.
      const text = `${'a'.repeat(4095)}\u{1F600}tail`;

      const chunks = formatTelegramMessage(text);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].text.length).toBe(4095);
      expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
        expect(/[\uD800-\uDBFF]$/.test(chunk.text)).toBe(false);
        expect(/^[\uDC00-\uDFFF]/.test(chunk.text)).toBe(false);
      }
    });

    it('maps an entity that straddles a chunk boundary onto both chunks', () => {
      const text = `<b>${'a'.repeat(12)}</b>`;

      const chunks = formatTelegramMessage(text, 5);

      expect(chunks.map((chunk) => chunk.text)).toEqual(['aaaaa', 'aaaaa', 'aa']);
      expect(chunks.map((chunk) => chunk.entities)).toEqual([
        [{ type: 'bold', offset: 0, length: 5 }],
        [{ type: 'bold', offset: 0, length: 5 }],
        [{ type: 'bold', offset: 0, length: 2 }],
      ]);
    });

    it('drops an entity from a chunk it does not reach', () => {
      const chunks = formatTelegramMessage('<b>ab</b>cdefgh', 5);

      expect(chunks.map((chunk) => chunk.entities)).toEqual([
        [{ type: 'bold', offset: 0, length: 2 }],
        [],
      ]);
    });
  });
});

describe('Story TG-05/TG-06: producer formatting contract', () => {
  describe('AC: the advertised subset agrees with the formatter', () => {
    it('names every tag the parser accepts and forbids the markup it cannot read', () => {
      for (const tag of [
        '<b>',
        '<i>',
        '<u>',
        '<s>',
        '<code>',
        '<pre>',
        '<tg-spoiler>',
        '<blockquote>',
      ]) {
        expect(TELEGRAM_FORMAT_GUIDE).toContain(tag);
      }
      expect(TELEGRAM_FORMAT_GUIDE).toContain('<a href="..."');
      expect(TELEGRAM_FORMAT_GUIDE).toMatch(/no Markdown/i);
      expect(TELEGRAM_FORMAT_GUIDE).toMatch(/&amp;/);
      // The sender owns entities and splitting; the model must never restate them.
      expect(TELEGRAM_FORMAT_GUIDE).toMatch(/Never write entity JSON, offsets or lengths/);
    });

    it('states the nesting and protocol rules the parser actually enforces', () => {
      expect(TELEGRAM_FORMAT_GUIDE).toMatch(
        /<code> and <pre>\n.*must not appear inside any other tag/
      );
      expect(TELEGRAM_FORMAT_GUIDE).toMatch(/Links must be http, https or mailto/);
      // Naming a protocol the parser rejects would be a contract the sender
      // cannot honour: the resulting 400 costs the answer, not just the styling.
      expect(TELEGRAM_FORMAT_GUIDE).not.toMatch(/\btg:/);
    });

    it('is shown to the model as text, never styled by its own tag citations', () => {
      // Was a byte-identical round-trip, which only held because ANY unreadable
      // markup took the whole message literal. Per-span degradation has to reach
      // the same outcome for the guide on purpose: every cited tag stays visible
      // and contributes no entity. The escaped `&amp;`/`&lt;` of the guide's own
      // escaping rule now decode, as they do in any other answer.
      const [chunk] = formatTelegramMessage(TELEGRAM_FORMAT_GUIDE);

      expect(chunk.entities).toEqual([]);
      expect(chunk.text).toBe(
        TELEGRAM_FORMAT_GUIDE.replace(
          'as &amp;, &lt;, &gt; and &quot;.',
          'as &, <, > and ".'
        )
      );
      for (const tag of ['<b>', '<i>', '<code>', '<pre>', '<blockquote>', '<a href="...">']) {
        expect(chunk.text).toContain(tag);
      }
    });
  });
});

describe('Story TG-01: streaming formatting', () => {
  describe('AC: partial tags do not expose raw markup', () => {
    it('leaves a complete snapshot alone', () => {
      expect(closeOpenTelegramHtml('<b>done</b> tail')).toBe('<b>done</b> tail');
      expect(closeOpenTelegramHtml('no markup at all')).toBe('no markup at all');
    });

    it('drops a tag the stream cut in half', () => {
      expect(closeOpenTelegramHtml('see <a href="https:')).toBe('see ');
      expect(closeOpenTelegramHtml('<b')).toBe('');
    });

    it('drops a tag the stream has opened but not yet filled', () => {
      // Closing it would build markup around no text, which formatTelegramMessage
      // shows literally rather than send as an empty message.
      expect(closeOpenTelegramHtml('<b>')).toBe('');
      expect(closeOpenTelegramHtml('<b><i>')).toBe('');
      expect(closeOpenTelegramHtml('a <b>')).toBe('a ');
    });

    it('closes the tags still open, innermost first', () => {
      expect(closeOpenTelegramHtml('<b>bold <i>and')).toBe('<b>bold <i>and</i></b>');
    });

    it('leaves a snapshot the scan cannot follow to the parser', () => {
      expect(closeOpenTelegramHtml('</b>orphan')).toBe('</b>orphan');
      expect(closeOpenTelegramHtml('<div>block')).toBe('<div>block');
    });

    it('shows no raw markup for ANY prefix of a formatted answer', () => {
      const answer =
        '<b>Status</b>\nsee <a href="https://example.com/x">the source</a> and ' +
        '<i>note</i> <code>id-1</code>\n<blockquote>quoted</blockquote>';

      for (let cut = 1; cut <= answer.length; cut += 1) {
        const [chunk] = formatTelegramMessage(closeOpenTelegramHtml(answer.slice(0, cut)));
        expect(chunk?.text ?? '').not.toMatch(/<[a-z/]|href=/i);
      }
    });
  });
});

describe('Story TG-01/TG-06: entity rejection', () => {
  describe('AC: styling rejection is distinct from transport failure', () => {
    it('recognizes the Telegram entity parse rejection', () => {
      expect(
        isTelegramEntityRejection(new Error("Bad Request: can't parse entities: unexpected end"))
      ).toBe(true);
      expect(isTelegramEntityRejection('Bad Request: entity offset is out of range')).toBe(true);
    });

    it('recognizes every entity-level 400 wording, so none costs the answer', () => {
      for (const message of [
        "Bad Request: can't parse entities: unsupported start tag",
        "Bad Request: CAN'T PARSE ENTITIES",
        'Bad Request: entity offset is out of range',
        'Bad Request: entity is invalid',
        'Bad Request: entities are invalid',
        'Bad Request: too many entities',
        'Bad Request: unsupported URL protocol',
      ]) {
        expect(isTelegramEntityRejection(new Error(message))).toBe(true);
        expect(isTelegramEntityRejection(message)).toBe(true);
      }
    });

    it('does not claim an unrelated failure as a markup problem', () => {
      expect(isTelegramEntityRejection(new Error('Bad Request: chat not found'))).toBe(false);
      expect(isTelegramEntityRejection(new Error('socket hang up'))).toBe(false);
    });
  });
});

import { describe as describeE, expect as expectE, it as itE } from 'vitest';
import { formatTelegramMessage as formatE } from '../../src/gateways/telegram-format.js';

describeE('escaped rejected tags keep their entity text literal', () => {
  itE('shows &amp; inside an unsupported tag as text, not decoded twice', () => {
    const [chunk] = formatE('<b>ok</b> <a href="https://x.test/?a=1&amp;b=2" onclick="x">link</a>', 4096, 'html-v1');
    expectE(chunk.text).toContain('&amp;b=2');
    expectE(chunk.text).not.toContain('&b=2"');
    expectE(chunk.entities.some((e) => e.type === 'bold')).toBe(true);
  });
});
