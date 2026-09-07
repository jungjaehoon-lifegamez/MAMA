/**
 * Task G: Telegram entity capture and model-visible rendering.
 *
 * Offsets/lengths are Telegram UTF-16 code units against the ORIGINAL text or
 * caption field. The helper never rewrites the body into Markdown; it records
 * exact spans as data.
 */

import { describe, it, expect } from 'vitest';
import {
  captureTelegramTextFormatting,
  renderTelegramFormattingForModel,
  selectTelegramTextEntities,
  TELEGRAM_FORMATTING_HEADER,
} from '../../src/gateways/telegram-text-entities.js';

describe('Story TG-04 Task G: AC #1 select original Telegram text and caption entities', () => {
  it('pairs text with entities and caption with caption_entities', () => {
    const textSelection = selectTelegramTextEntities({
      text: 'HELLO',
      entities: [{ type: 'bold', offset: 0, length: 5 }],
      caption_entities: [{ type: 'italic', offset: 0, length: 5 }],
    });
    expect(textSelection.field).toBe('text');
    expect(textSelection.text).toBe('HELLO');
    expect(textSelection.entities).toEqual([{ type: 'bold', offset: 0, length: 5 }]);

    const captionSelection = selectTelegramTextEntities({
      caption: 'Read this',
      entities: [{ type: 'bold', offset: 0, length: 4 }],
      caption_entities: [{ type: 'italic', offset: 0, length: 4 }],
    });
    expect(captionSelection.field).toBe('caption');
    expect(captionSelection.text).toBe('Read this');
    expect(captionSelection.entities).toEqual([{ type: 'italic', offset: 0, length: 4 }]);
  });

  it('returns an empty text frame when neither field is present', () => {
    const selection = selectTelegramTextEntities({});
    expect(selection.field).toBe('text');
    expect(selection.text).toBe('');
    expect(selection.entities).toBeUndefined();
  });
});

describe('Story TG-04 Task G: AC #2 preserve exact UTF-16 formatting spans', () => {
  it('keeps the exact original body including trailing double spaces and newline', () => {
    const original = 'HELLO  \nhello';
    const formatting = captureTelegramTextFormatting('text', original, [
      { type: 'bold', offset: 0, length: 5 },
    ]);
    expect(formatting).toEqual({
      platform: 'telegram',
      field: 'text',
      originalText: 'HELLO  \nhello',
      entities: [{ type: 'bold', offset: 0, length: 5 }],
    });
  });

  it('returns undefined when there are no entities or only invalid ones', () => {
    expect(captureTelegramTextFormatting('text', 'plain *stars*', undefined)).toBeUndefined();
    expect(captureTelegramTextFormatting('text', 'plain *stars*', [])).toBeUndefined();
    expect(
      captureTelegramTextFormatting('text', 'short', [
        { type: 'bold', offset: 3, length: 10 },
        { type: 'bold', offset: -1, length: 2 },
        { type: 'bold', offset: 0, length: 0 },
        { type: 'bold', offset: 1.5, length: 2 },
      ])
    ).toBeUndefined();
  });

  it('drops out-of-range entities but keeps the valid ones', () => {
    const formatting = captureTelegramTextFormatting('text', 'HELLO', [
      { type: 'bold', offset: 0, length: 5 },
      { type: 'italic', offset: 4, length: 5 },
    ]);
    expect(formatting?.entities).toEqual([{ type: 'bold', offset: 0, length: 5 }]);
  });

  it('preserves overlapping entities in offset order', () => {
    const formatting = captureTelegramTextFormatting('text', 'bold and italic', [
      { type: 'italic', offset: 5, length: 10 },
      { type: 'bold', offset: 0, length: 8 },
    ]);
    expect(formatting?.entities).toEqual([
      { type: 'bold', offset: 0, length: 8 },
      { type: 'italic', offset: 5, length: 10 },
    ]);
  });

  it('retains pre language, text_link url, custom emoji id and text_mention user id only', () => {
    const formatting = captureTelegramTextFormatting('text', 'code link emoji who', [
      { type: 'pre', offset: 0, length: 4, language: 'python' },
      { type: 'text_link', offset: 5, length: 4, url: 'https://example.com/x' },
      { type: 'custom_emoji', offset: 10, length: 5, custom_emoji_id: '5368324170671202286' },
      {
        type: 'text_mention',
        offset: 16,
        length: 3,
        user: { id: 424242, is_bot: false, first_name: 'Synthetic', username: 'synth' },
      },
    ]);
    expect(formatting?.entities).toEqual([
      { type: 'pre', offset: 0, length: 4, language: 'python' },
      { type: 'text_link', offset: 5, length: 4, url: 'https://example.com/x' },
      { type: 'custom_emoji', offset: 10, length: 5, custom_emoji_id: '5368324170671202286' },
      { type: 'text_mention', offset: 16, length: 3, user: { id: 424242, username: 'synth' } },
    ]);
  });
});

describe('Story TG-05 Task G: AC #3 render formatting as untrusted model data', () => {
  it('renders the bold span as data with UTF-16 offsets and never as Markdown', () => {
    const body = 'HELLO  \nhello';
    const formatting = captureTelegramTextFormatting('text', body, [
      { type: 'bold', offset: 0, length: 5 },
    ]);
    const rendered = renderTelegramFormattingForModel(formatting!, body);
    expect(rendered.startsWith(TELEGRAM_FORMATTING_HEADER)).toBe(true);
    expect(rendered).toContain('field=text');
    expect(rendered).toContain('utf16');
    expect(rendered).toContain('bold offset=0 length=5 span="HELLO"');
    expect(rendered).not.toContain('**');
    expect(rendered).not.toContain('HELLO  \nhello');
    expect(rendered).not.toContain('adjusted by the host');
  });

  it('uses UTF-16 offsets so a non-BMP emoji before the span is two units', () => {
    const body = '\u{1F44D} HELLO';
    const formatting = captureTelegramTextFormatting('text', body, [
      { type: 'bold', offset: 3, length: 5 },
    ]);
    expect(renderTelegramFormattingForModel(formatting!, body)).toContain(
      'bold offset=3 length=5 span="HELLO"'
    );
  });

  it('renders overlapping bold/italic spans separately and escapes newlines inside a span', () => {
    const body = 'first\nsecond';
    const formatting = captureTelegramTextFormatting('text', body, [
      { type: 'bold', offset: 0, length: 12 },
      { type: 'italic', offset: 6, length: 6 },
    ]);
    const rendered = renderTelegramFormattingForModel(formatting!, body);
    expect(rendered).toContain('bold offset=0 length=12 span="first\\nsecond"');
    expect(rendered).toContain('italic offset=6 length=6 span="second"');
  });

  it('carries language, url and custom emoji metadata but not auto-detected literal entities', () => {
    const body = 'code link emoji https://a.example #tag';
    const formatting = captureTelegramTextFormatting('caption', body, [
      { type: 'pre', offset: 0, length: 4, language: 'python' },
      { type: 'text_link', offset: 5, length: 4, url: 'https://example.com/x' },
      { type: 'custom_emoji', offset: 10, length: 5, custom_emoji_id: '5368324170671202286' },
      { type: 'url', offset: 16, length: 17 },
      { type: 'hashtag', offset: 34, length: 4 },
    ]);
    const rendered = renderTelegramFormattingForModel(formatting!, body);
    expect(rendered).toContain('field=caption');
    expect(rendered).toContain('pre offset=0 length=4 language="python" span="code"');
    expect(rendered).toContain(
      'text_link offset=5 length=4 url="https://example.com/x" span="link"'
    );
    expect(rendered).toContain(
      'custom_emoji offset=10 length=5 custom_emoji_id="5368324170671202286" span="emoji"'
    );
    expect(rendered).not.toContain('url offset=16');
    expect(rendered).not.toContain('hashtag');
  });

  it('declares the original frame explicitly when the routed body was adjusted by the host', () => {
    const original = '@test_bot fix this';
    const formatting = captureTelegramTextFormatting('text', original, [
      { type: 'mention', offset: 0, length: 9 },
      { type: 'bold', offset: 10, length: 3 },
    ]);
    const rendered = renderTelegramFormattingForModel(formatting!, 'fix this');
    expect(rendered).toContain('adjusted by the host');
    expect(rendered).toContain('original_length=18');
    expect(rendered).toContain('bold offset=10 length=3 span="fix"');
    expect(rendered).not.toContain('mention offset=0');
  });

  it('returns an empty string when no renderable formatting entity exists', () => {
    const formatting = captureTelegramTextFormatting('text', 'see https://a.example', [
      { type: 'url', offset: 4, length: 17 },
    ]);
    expect(renderTelegramFormattingForModel(formatting!, 'see https://a.example')).toBe('');
  });

  it('truncates a very long span quote and says so', () => {
    const body = 'x'.repeat(400);
    const formatting = captureTelegramTextFormatting('text', body, [
      { type: 'code', offset: 0, length: 400 },
    ]);
    const rendered = renderTelegramFormattingForModel(formatting!, body);
    expect(rendered).toContain('code offset=0 length=400');
    expect(rendered).toContain('span_truncated=true');
    expect(rendered).not.toContain('x'.repeat(400));
  });
});
