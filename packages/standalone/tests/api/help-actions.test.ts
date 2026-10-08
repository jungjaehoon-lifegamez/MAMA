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

const help = helpActionRegistrations({
  contracts: () => contracts,
  topics: () => ({ 'full-report': 'Full report procedure text.', record: 'Recording text.' }),
})[0]!;
const run = async (input: unknown) =>
  (await help.exec(input as never, {
    access: {
      principalId: 'principal-test',
      agentId: 'agent-test',
      scopes: [],
      actions: contracts.map((contract) => contract.name),
    },
  })) as string;

describe('action catalog line', () => {
  it('is an index entry: the name and first sentence, the arguments left to help', () => {
    expect(actionSignature(contracts[0]!.inputSchema)).toBe(
      '{text, view?: "overview"|"items", links?, eventDatetime?}'
    );
    expect(actionCatalogLine(contracts[0]!)).toBe('work.list — Read owner work progressively.');
    expect(actionCatalogLine(contracts[2]!)).toBe(
      'memory.read:provenance — Trace a memory to its cited source messages.'
    );
  });

  it('names the arguments a top-level oneOf requires, and fixed values', async () => {
    expect(actionSignature(contracts[1]!.inputSchema)).toBe(
      '{observationRef?, observationRefs?: ≤500 items, mode?: "stored"; one of: observationRef | observationRefs}'
    );
    expect((await run({ actions: ['source_read'] })).split('\n').slice(2)).toEqual([
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

  it('caps the sentence', () => {
    const line = actionCatalogLine({ name: 'x.y', summary: 'z'.repeat(300) } as never);
    expect(line.startsWith('x.y — ')).toBe(true);
    expect(line.length).toBe('x.y — '.length + 160);
  });
});

describe('help action', () => {
  it('lists the topics and every action line when nothing is asked', async () => {
    expect(await run({})).toBe(
      ['Topics: full-report, record', 'Actions:', ...contracts.map(actionCatalogLine)].join('\n')
    );
  });

  it('returns a procedure by topic, alone or with contracts, and names the topics when unknown', async () => {
    expect(await run({ topic: 'full-report' })).toBe('Full report procedure text.');
    expect((await run({ topic: 'record', actions: ['work.list'] })).split('\n\n')[0]).toBe(
      'Recording text.'
    );
    await expect(run({ topic: 'reports' })).rejects.toThrow(
      'unknown topic: reports; topics: full-report, record'
    );
    // An inherited name is not a topic.
    await expect(run({ topic: 'toString' })).rejects.toThrow('unknown topic: toString');
  });

  it('returns each contract as text for dotted and Codex names alike', async () => {
    for (const name of ['work.list', 'work_list']) {
      expect(await run({ actions: [name] })).toBe(
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
    // Several actions: one call line each, not their whole contracts.
    expect(await run({ actions: ['memory_read_provenance', 'work.list'] })).toBe(
      [
        'memory.read:provenance({}) — Trace a memory to its cited source messages.',
        'work.list({text, view?: "overview"|"items", links?, eventDatetime?}) — Read owner work progressively.',
        'Ask for one action by itself for its argument descriptions and examples.',
      ].join('\n')
    );
    await expect(run({ actions: ['work.delete'] })).rejects.toThrow(/unknown actions: work.delete/);
  });
});
