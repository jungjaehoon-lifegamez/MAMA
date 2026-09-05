/**
 * Task B / parent-fix P3+P5 — progressive board_read views over synthetic slots.
 * No report store, no network. Covers descriptors-by-default, code-point paging
 * for text and html, a REAL non-executing HTML parser (block/entity/script), and
 * the content readVersion that pins a continuation to one document.
 */
import { describe, it, expect } from 'vitest';
import { readBoardView, type BoardSlots } from '../../src/operator/board-read-views.js';

const LONG_TEXT = 'x'.repeat(5000);
function makeSlots(): BoardSlots {
  return {
    briefing: {
      html: `<div title="a > b">Status &amp; plan</div><script>alert('no')</script><p>tail &mdash; ${LONG_TEXT}</p>`,
      updatedAt: '2026-07-21T09:00:00.000Z',
    },
    decisions: { html: '<ul><li>ship</li></ul>', updatedAt: null },
  };
}

describe('Task B: board_read descriptors (default)', () => {
  it('lists slot names, updatedAt and html length in code points, never the HTML', () => {
    const slots = makeSlots();
    const result = readBoardView({}, slots) as {
      slots: Array<{ name: string; updatedAt: string | null; htmlLength: number }>;
    };
    expect(result.slots.map((s) => s.name).sort()).toEqual(['briefing', 'decisions']);
    const briefing = result.slots.find((s) => s.name === 'briefing')!;
    expect(briefing.updatedAt).toBe('2026-07-21T09:00:00.000Z');
    expect(briefing.htmlLength).toBe(Array.from(slots.briefing.html).length);
    expect(result.slots.find((s) => s.name === 'decisions')!.updatedAt).toBeNull();
    expect(JSON.stringify(result)).not.toContain('<script>');
  });
});

describe('Task B: board_read selected content', () => {
  it('pages a long slot as html by code points and reconstructs it with no lost tail', () => {
    const slots = makeSlots();
    let assembled = '';
    let offset: number | null = 0;
    let total = -1;
    let version: string | undefined;
    while (offset !== null) {
      const page = readBoardView(
        { slot: 'briefing', format: 'html', offset, limit: 1000, readVersion: version },
        slots
      ) as {
        content: string;
        total: number;
        nextOffset: number | null;
        readVersion: string;
      };
      total = page.total;
      version = page.readVersion;
      assembled += page.content;
      offset = page.nextOffset;
    }
    expect(total).toBe(Array.from(slots.briefing.html).length);
    expect(assembled).toBe(slots.briefing.html);
  });

  it('extracts text with a real parser: quoted ">" stays in the attribute, blocks break, entities decode, script drops', () => {
    const slots = makeSlots();
    const page = readBoardView({ slot: 'briefing', format: 'text', limit: 4000 }, slots) as {
      content: string;
      nextOffset: number | null;
    };
    // The regex stripper used to leak ' b">' from the title attribute; the parser does not.
    expect(page.content).not.toContain('b">');
    expect(page.content).not.toContain('<');
    expect(page.content).not.toContain("alert('no')");
    expect(page.content).toContain('Status & plan');
    expect(page.content).toContain('tail —');
    // div and p are separate blocks: their text is not run together.
    expect(page.content).toMatch(/Status & plan\s*\n/);
    // The 5000-char body is longer than one 4000 window: the tail is reachable.
    expect(page.nextOffset).not.toBeNull();
  });

  it('reconstructs long extracted text across pages under a stable readVersion', () => {
    const slots = makeSlots();
    let assembled = '';
    let offset: number | null = 0;
    let version: string | undefined;
    while (offset !== null) {
      const page = readBoardView(
        { slot: 'briefing', format: 'text', offset, limit: 2000, readVersion: version },
        slots
      ) as { content: string; nextOffset: number | null; readVersion: string };
      version = page.readVersion;
      assembled += page.content;
      offset = page.nextOffset;
    }
    const full = readBoardView({ slot: 'briefing', format: 'text', limit: 4000 }, slots) as {
      content: string;
      total: number;
    };
    expect(Array.from(assembled)).toHaveLength(full.total);
  });

  it('rejects a continuation whose content changed to a same-length document', () => {
    const slots = makeSlots();
    const first = readBoardView({ slot: 'briefing', format: 'html', limit: 1000 }, slots) as {
      readVersion: string;
      nextOffset: number | null;
    };
    expect(first.nextOffset).not.toBeNull();
    // Replace the slot with a DIFFERENT document of the SAME length between chunks.
    const replaced: BoardSlots = {
      ...slots,
      briefing: {
        html: 'Z'.repeat(Array.from(slots.briefing.html).length),
        updatedAt: slots.briefing.updatedAt,
      },
    };
    expect(() =>
      readBoardView(
        {
          slot: 'briefing',
          format: 'html',
          offset: first.nextOffset!,
          readVersion: first.readVersion,
        },
        replaced
      )
    ).toThrow(/content changed/i);
  });

  it('requires a readVersion for a continuation and rejects a missing one', () => {
    const slots = makeSlots();
    expect(() => readBoardView({ slot: 'briefing', format: 'html', offset: 1000 }, slots)).toThrow(
      /requires the readVersion/i
    );
  });

  it('rejects an unknown slot explicitly', () => {
    expect(() => readBoardView({ slot: 'ghost' }, makeSlots())).toThrow(/unknown slot/i);
  });

  it('rejects an unknown format and out-of-range bounds, never clamping', () => {
    const slots = makeSlots();
    expect(() => readBoardView({ slot: 'briefing', format: 'pdf' }, slots)).toThrow(/format/);
    expect(() => readBoardView({ slot: 'briefing', limit: 0 }, slots)).toThrow(/1 to 4000/);
    expect(() => readBoardView({ slot: 'briefing', limit: 4001 }, slots)).toThrow(/1 to 4000/);
    expect(() => readBoardView({ slot: 'briefing', offset: -1 }, slots)).toThrow(/non-negative/);
  });

  it('a short slot read is complete in one window', () => {
    const page = readBoardView({ slot: 'decisions', format: 'text' }, makeSlots()) as {
      complete: boolean;
      nextOffset: number | null;
      content: string;
    };
    expect(page.complete).toBe(true);
    expect(page.nextOffset).toBeNull();
    expect(page.content).toContain('ship');
  });

  it('treats a missing html slot as an empty complete window, never throwing', () => {
    // The nominal type says string, but a slot could arrive without html; a
    // boundary cast reproduces it. Descriptor and both formats stay non-throwing.
    const slots = {
      empty: { html: undefined as unknown as string, updatedAt: null },
    } as BoardSlots;
    const descriptors = readBoardView({}, slots) as {
      slots: Array<{ name: string; htmlLength: number }>;
    };
    expect(descriptors.slots[0]).toMatchObject({ name: 'empty', htmlLength: 0 });
    for (const format of ['text', 'html'] as const) {
      const page = readBoardView({ slot: 'empty', format }, slots) as {
        content: string;
        total: number;
        complete: boolean;
        nextOffset: number | null;
      };
      expect(page.content).toBe('');
      expect(page.total).toBe(0);
      expect(page.complete).toBe(true);
      expect(page.nextOffset).toBeNull();
    }
  });
});
