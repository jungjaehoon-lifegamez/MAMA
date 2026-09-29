import { describe, expect, it } from 'vitest';
import type { ActionContract } from '@jungjaehoon/mama-core';
import {
  actionCatalogLine,
  actionSignature,
  helpActionRegistrations,
} from '../../src/api/help-actions.js';

const contracts = [
  {
    name: 'work.list',
    summary: 'Read owner work progressively. Views: overview, pipeline, items, detail.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        view: {
          type: 'string',
          enum: ['overview', 'items'],
          description: 'Which view to read, e.g. "items".',
        },
        text: { type: 'string', minLength: 1 },
        links: {
          type: 'array',
          items: {
            type: 'object',
            required: ['relation'],
            properties: {
              relation: { type: 'string', enum: ['derived_from'] },
              target: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        },
        eventDatetime: { oneOf: [{ type: 'number' }, { type: 'null' }] },
      },
    },
    examples: [{ title: 'Items', input: { view: 'items', text: 'asset' } }],
  },
  {
    name: 'source.read',
    summary: 'Read originals by one reference or a batch.',
    inputSchema: {
      type: 'object',
      properties: {
        observationRef: { type: 'string' },
        observationRefs: { type: 'array', items: { type: 'string' }, maxItems: 500 },
        mode: { const: 'stored' },
      },
      oneOf: [{ required: ['observationRef'] }, { required: ['observationRefs'] }],
    },
  },
  {
    name: 'memory.read:provenance',
    summary: 'Trace a memory to its cited source messages.',
    inputSchema: { type: 'object' },
  },
] as unknown as ActionContract[];

const help = helpActionRegistrations({ contracts: () => contracts })[0]!;
const run = (input: unknown) => help.exec(input as never, {} as never) as string;

describe('action catalog line', () => {
  it("lists the arguments, required first, with a plain enum's values, then the first sentence", () => {
    expect(actionSignature(contracts[0]!.inputSchema)).toBe(
      '{text, view?: "overview"|"items", links?, eventDatetime?}'
    );
    expect(actionCatalogLine(contracts[0]!)).toBe(
      'work.list({text, view?: "overview"|"items", links?, eventDatetime?}) — Read owner work progressively.'
    );
    expect(actionCatalogLine(contracts[2]!)).toBe(
      'memory.read:provenance({}) — Trace a memory to its cited source messages.'
    );
  });

  it('names the arguments a top-level oneOf requires, and fixed values', () => {
    expect(actionSignature(contracts[1]!.inputSchema)).toBe(
      '{observationRef?, observationRefs?: ≤500 items, mode?: "stored"; one of: observationRef | observationRefs}'
    );
    expect(
      run({ actions: ['source_read'] })
        .split('\n')
        .slice(2)
    ).toEqual([
      '- observationRef: string',
      '- observationRefs: string[] (at most 500 items)',
      '- mode: "stored"',
      '- one of: observationRef | observationRefs',
    ]);
  });

  it('shows the bound of a number or a list, which a caller cannot guess from the name', () => {
    expect(
      actionSignature({
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          caption: { type: 'string', maxLength: 1024 },
          ids: { type: 'array', minItems: 1, maxItems: 4 },
          asOf: { type: 'integer', minimum: 0 },
        },
      })
    ).toBe('{limit?: ≤50, caption?: ≤1024 chars, ids?: ≤4 items, asOf?}');
  });

  it('caps the sentence, never the argument list', () => {
    const line = actionCatalogLine({
      name: 'x.y',
      summary: 'z'.repeat(300),
      inputSchema: { type: 'object', properties: { a: {}, b: {} } },
    } as never);
    expect(line.startsWith('x.y({a?, b?}) — ')).toBe(true);
    expect(line.length).toBe('x.y({a?, b?}) — '.length + 160);
  });
});

describe('help action', () => {
  it('lists every action line when no names are given', () => {
    expect(run({})).toBe(contracts.map(actionCatalogLine).join('\n'));
  });

  it('returns each contract as text for dotted, Codex and Claude names alike', () => {
    for (const name of ['work.list', 'work_list', 'mcp__mama__work_list']) {
      expect(run({ actions: [name] })).toBe(
        [
          'work.list({text, view?: "overview"|"items", links?, eventDatetime?})',
          'Read owner work progressively. Views: overview, pipeline, items, detail.',
          '- text (required): string',
          '- view: "overview"|"items". Which view to read, e.g. "items".',
          '- links: ({relation: "derived_from", target?: {id?: string}})[]',
          '- eventDatetime: number | null',
          'example (Items): {"view":"items","text":"asset"}',
        ].join('\n')
      );
    }
    expect(
      run({ actions: ['mcp__mama__memory_read_provenance', 'work.list'] }).split('\n\n')
    ).toHaveLength(2);
    expect(() => run({ actions: ['work.delete'] })).toThrow(/unknown actions: work.delete/);
  });
});
