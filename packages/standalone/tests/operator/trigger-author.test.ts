/**
 * Unit tests for trigger authoring (Task 3 - G1+G3: the agent writes its own triggers).
 * The agent is INJECTED (askAgent stub) so this is deterministic; the real claude-CLI
 * agent is exercised by the LLM eval (RUN_LLM_EVAL). Validation is STRUCTURAL only -
 * unknown kind/action VALUES are accepted (never narrowed to a catalog), or G3 re-freezes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import {
  authorTriggers,
  createAskAgentCLI,
  describeCliFailure,
  parseTriggerSpecs,
  validateTriggerSpec,
} from '../../src/operator/trigger-author.js';
import type { OperatorChannelEvent } from '../../src/operator/operator-interfaces.js';

const cannedSpec = JSON.stringify([
  {
    kind: 'weird_new_kind_the_agent_invented',
    memoryQuery: 'recall the deploy rollback preference',
    match: { keywords: ['rollback'], keywordMode: 'any', minConfidence: 0.7 },
    procedure: [{ action: 'novel_action', description: 'do the thing' }],
    requiredEvidence: ['current_message'],
  },
]);

function ev(content: string, id = 1): OperatorChannelEvent {
  return {
    id,
    channel: 'discord',
    channelId: 'c1',
    userId: 'u1',
    role: 'user',
    content,
    createdAt: id * 100,
  };
}

describe('authorTriggers', () => {
  let db: SQLiteDatabase;
  let reg: TriggerRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    reg = new TriggerRegistry(db);
  });
  afterEach(() => reg.close());

  it('TG-05 preserves validated canonical procedure references through authoring', async () => {
    const spec = {
      ...JSON.parse(cannedSpec)[0],
      procedureRef: { id: 'p1', revision: 2, scopeKey: 'a'.repeat(64) },
    };
    const created = await authorTriggers([ev('rollback')], reg, async () => JSON.stringify([spec]));
    expect(reg.getById(created[0].id)?.procedureRef).toEqual(spec.procedureRef);
    expect(() =>
      validateTriggerSpec({ ...spec, procedureRef: { ...spec.procedureRef, scopeKey: 'bad' } })
    ).toThrow(/scopeKey/);
    expect(() => validateTriggerSpec({ ...spec, procedureRef: { id: 'p1', revision: 0 } })).toThrow(
      /procedureRef/
    );
  });

  it('persists an agent-authored trigger with open kind/action (G3)', async () => {
    const created = await authorTriggers(
      [ev('rollback again'), ev('another rollback', 2)],
      reg,
      async () => cannedSpec
    );
    expect(created).toHaveLength(1);
    expect(created[0].kind).toBe('weird_new_kind_the_agent_invented'); // arbitrary value accepted, not an enum
    expect(created[0].procedure[0].action).toBe('novel_action');
    expect(created[0].authoredBy).toBe('agent');
    expect(reg.listActive().map((t) => t.id)).toContain(created[0].id);
  });

  it('throws on unparseable agent output (no-fallback)', async () => {
    await expect(
      authorTriggers([ev('x')], reg, async () => 'maybe a trigger about rollbacks would be nice')
    ).rejects.toThrow();
  });

  it('dedups against an existing active trigger with the same keyword set', async () => {
    reg.create({
      id: 'existing',
      kind: 'k',
      memoryQuery: 'q',
      match: { keywords: ['rollback'], keywordMode: 'any', minConfidence: 0.7 },
      procedure: [],
      requiredEvidence: [],
      authoredBy: 'agent',
      provenance: { createdFrom: 'seed', note: '' },
    });
    const created = await authorTriggers([ev('rollback')], reg, async () => cannedSpec);
    expect(created).toHaveLength(0);
  });

  it('rejects near-duplicates: keyword subset or >=0.6 Jaccard overlap in the same scope', async () => {
    // Day-1 live data: 65% of fires were co-fires of overlapping triggers.
    reg.create({
      id: 'existing-wide',
      kind: 'k',
      memoryQuery: 'q',
      match: { keywords: ['rollback', 'deploy', 'hotfix'], keywordMode: 'any', minConfidence: 0.7 },
      procedure: [],
      requiredEvidence: [],
      authoredBy: 'agent',
      provenance: { createdFrom: 'seed', note: '' },
    });
    // subset of existing-wide's keywords -> rejected
    const subsetSpec = JSON.stringify([
      {
        kind: 'k2',
        memoryQuery: 'q2',
        match: { keywords: ['rollback', 'deploy'], keywordMode: 'any', minConfidence: 0.7 },
        procedure: [{ action: 'a', description: 'd' }],
        requiredEvidence: [],
      },
    ]);
    expect(await authorTriggers([ev('x')], reg, async () => subsetSpec)).toHaveLength(0);

    // high-overlap variant (3 shared of 4 union = 0.75) -> rejected
    const overlapSpec = JSON.stringify([
      {
        kind: 'k3',
        memoryQuery: 'q3',
        match: {
          keywords: ['rollback', 'deploy', 'hotfix', 'incident'],
          keywordMode: 'any',
          minConfidence: 0.7,
        },
        procedure: [{ action: 'a', description: 'd' }],
        requiredEvidence: [],
      },
    ]);
    expect(await authorTriggers([ev('x')], reg, async () => overlapSpec)).toHaveLength(0);

    // disjoint keywords -> accepted
    const disjointSpec = JSON.stringify([
      {
        kind: 'k4',
        memoryQuery: 'q4',
        match: { keywords: ['invoice', 'billing'], keywordMode: 'any', minConfidence: 0.7 },
        procedure: [{ action: 'a', description: 'd' }],
        requiredEvidence: [],
      },
    ]);
    expect(await authorTriggers([ev('x')], reg, async () => disjointSpec)).toHaveLength(1);
  });

  it('author prompt warns against near-variants of existing triggers', async () => {
    const { buildAuthorPrompt } = await import('../../src/operator/trigger-author.js');
    const prompt = buildAuthorPrompt([ev('x')], reg.listActive());
    expect(prompt).toContain('partial keyword overlap');
    expect(prompt).toContain('proposing NOTHING over proposing a variant');
  });

  // The list's job is dedup, and keywords + scope decide that. IDs grow on every refinement and
  // recall queries do not help dedup, so neither belongs in the recurring author prompt.
  it('carries existing trigger keywords without refinement IDs or recall queries', async () => {
    const { buildAuthorPrompt } = await import('../../src/operator/trigger-author.js');
    const querySentinel = 'FORBIDDEN_QUERY_SENTINEL';
    const long = `${querySentinel}${'x'.repeat(4000)}`;
    reg.create({
      id: `root${'.r.refinement'.repeat(80)}`,
      kind: 'k',
      memoryQuery: long,
      match: {
        keywords: ['unmistakable-keyword'],
        keywordMode: 'any',
        minConfidence: 0.5,
        scopeChannelIds: ['telegram:owner'],
      },
      procedure: [{ action: 'a', description: 'd' }],
      requiredEvidence: [],
      authoredBy: 'agent',
      provenance: { createdFrom: 'seed', note: '' },
    });

    const prompt = buildAuthorPrompt([ev('x')], reg.listActive());

    // Dedup still possible: the keyword is intact.
    expect(prompt).toContain('unmistakable-keyword');
    expect(prompt).toContain('telegram:owner');
    // Prompt growth inputs are absent.
    expect(prompt).not.toContain(querySentinel);
    expect(prompt).not.toContain(long.slice(0, 160));
    expect(prompt).not.toContain('.r.refinement');
  });

  it('TG-05 bounds recurring author input even when events and registry contain large text', async () => {
    const { buildAuthorPrompt } = await import('../../src/operator/trigger-author.js');
    for (let index = 0; index < 80; index += 1) {
      reg.create({
        id: `bounded-${index}`,
        kind: `kind-${index}`,
        memoryQuery: `query-${index}`,
        match: {
          keywords: [`keyword-${index}-${'k'.repeat(300)}`],
          keywordMode: 'any',
          minConfidence: 0.5,
        },
        procedure: [],
        requiredEvidence: [],
        authoredBy: 'agent',
        provenance: { createdFrom: 'seed', note: '' },
      });
    }

    const prompt = buildAuthorPrompt(
      Array.from({ length: 50 }, (_, index) => ev(`event-${index}-${'e'.repeat(4000)}`, index + 1)),
      reg.listActive()
    );

    expect(prompt.length).toBeLessThanOrEqual(30_000);
    expect(prompt).toContain('omitted');
  });

  it('TG-05 keeps the newest author evidence when the budget omits older messages', async () => {
    const { buildAuthorPrompt } = await import('../../src/operator/trigger-author.js');
    const events = Array.from({ length: 30 }, (_, index) =>
      ev(
        `${index === 0 ? 'OLDEST_AUTHOR_SENTINEL' : index === 29 ? 'NEWEST_AUTHOR_SENTINEL' : `event-${index}`} ${'x'.repeat(600)}`,
        index + 1
      )
    );

    const prompt = buildAuthorPrompt(events, []);

    expect(prompt).toContain('NEWEST_AUTHOR_SENTINEL');
    expect(prompt).not.toContain('OLDEST_AUTHOR_SENTINEL');
  });

  // 193 failures over the log's lifetime recorded nothing but the 240 KB command line that
  // produced them, because the executor destructured `{ stdout }` and Node's own message
  // embeds the whole argv. The tick that dies here takes the scheduled report with it.
  // The bug the 0.29.1 diagnostics found on their first live failure. The call inherited
  // `effortLevel: xhigh` from the user's settings, the daemon exports MAX_THINKING_TOKENS=0,
  // and the pair is a hard API 400. Measured: 46 failures against 8 successes on 2026-07-28,
  // then 34 against ZERO on 07-29 - the lane had been dead for two days.
  it('names its own effort instead of inheriting one the daemon cannot satisfy', async () => {
    const calls: string[][] = [];
    const ask = createAskAgentCLI(async (_file, args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ type: 'result', result: '[]' }) };
    });

    await ask('anything');

    const args = calls[0];
    const i = args.indexOf('--effort');
    expect(i, 'the call must name an effort').toBeGreaterThan(-1);
    // Anything above 'high' is rejected when thinking is disabled.
    expect(['high', 'medium', 'low']).toContain(args[i + 1]);
  });

  describe('describeCliFailure', () => {
    it('names a timeout kill rather than reporting a bare failure', () => {
      const note = describeCliFailure('claude', {
        killed: true,
        signal: 'SIGTERM',
        code: null,
        stderr: '',
        stdout: '',
      });
      expect(note).toContain('killed');
      expect(note).toContain('SIGTERM');
      expect(note).toContain('timeout');
    });

    it('reports the exit code and the tail of stderr', () => {
      const note = describeCliFailure('claude', { code: 1, stderr: 'Error: overloaded_error' });
      expect(note).toContain('exit=1');
      expect(note).toContain('overloaded_error');
    });

    // The CLI puts API errors on stdout, so an empty stderr is not an absent cause.
    it('falls back to stdout when stderr is empty', () => {
      const note = describeCliFailure('claude', {
        code: 1,
        stderr: '',
        stdout: '{"is_error":true,"result":"rate limit"}',
      });
      expect(note).toContain('rate limit');
    });

    // Never the argv: that is what made the log unreadable and told nobody anything.
    it('leaves the command line out no matter how large it was', () => {
      const argv = 'x'.repeat(240_000);
      const note = describeCliFailure('claude', { message: `Command failed: claude -p ${argv}` });
      expect(note.length).toBeLessThan(600);
      expect(note).not.toContain('x'.repeat(400));
    });
  });

  it('parseTriggerSpecs extracts the JSON array even with surrounding prose', () => {
    const specs = parseTriggerSpecs(`Sure, here you go:\n${cannedSpec}\nHope that helps.`);
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe('weird_new_kind_the_agent_invented');
  });

  it('validateTriggerSpec accepts unknown kind/action VALUES, rejects malformed SHAPE', () => {
    expect(() =>
      validateTriggerSpec({
        kind: 'anything_at_all',
        memoryQuery: 'q',
        match: { keywords: ['x'], keywordMode: 'any', minConfidence: 0.5 },
        procedure: [{ action: 'whatever_action', description: 'd' }],
        requiredEvidence: [],
      })
    ).not.toThrow();
    expect(() => validateTriggerSpec({ kind: 'k' })).toThrow(); // missing required fields
    expect(() =>
      validateTriggerSpec({
        kind: '',
        memoryQuery: 'q',
        match: { keywords: [], keywordMode: 'any', minConfidence: 0.5 },
        procedure: [],
        requiredEvidence: [],
      })
    ).toThrow(); // empty kind + empty keywords = malformed shape
  });

  it('TG-05 rejects oversized trigger fields and arrays before persistence', () => {
    const valid = {
      kind: 'recurring report',
      memoryQuery: 'weekly report state',
      match: { keywords: ['report'], keywordMode: 'any', minConfidence: 0.7 },
      procedure: [],
      requiredEvidence: [],
    };

    expect(() => validateTriggerSpec({ ...valid, memoryQuery: 'x'.repeat(4_001) })).toThrow(
      /memoryQuery/
    );
    expect(() =>
      validateTriggerSpec({
        ...valid,
        match: { ...valid.match, keywords: Array.from({ length: 65 }, () => 'report') },
      })
    ).toThrow(/keywords/);
    expect(() =>
      validateTriggerSpec({
        ...valid,
        procedure: Array.from({ length: 65 }, () => ({ action: 'recall', description: 'x' })),
      })
    ).toThrow(/procedure/);
  });

  it('TG-05 pins every trigger input boundary at max and max plus one', () => {
    const atLimit = {
      id: 'i'.repeat(512),
      kind: 'k'.repeat(256),
      memoryQuery: 'q'.repeat(4_000),
      match: {
        keywords: Array.from({ length: 64 }, () => 'w'.repeat(256)),
        keywordMode: 'any',
        minConfidence: 0.7,
        scopeChannelIds: Array.from({ length: 64 }, () => 's'.repeat(256)),
      },
      procedure: Array.from({ length: 64 }, () => ({
        action: 'a'.repeat(256),
        description: 'd'.repeat(2_000),
      })),
      requiredEvidence: Array.from({ length: 64 }, () => 'e'.repeat(1_000)),
    };
    expect(() => validateTriggerSpec(atLimit)).not.toThrow();

    const overLimit: Array<[string, unknown]> = [
      ['id', { ...atLimit, id: 'i'.repeat(513) }],
      ['kind', { ...atLimit, kind: 'k'.repeat(257) }],
      ['memoryQuery', { ...atLimit, memoryQuery: 'q'.repeat(4_001) }],
      [
        'keyword count',
        { ...atLimit, match: { ...atLimit.match, keywords: [...atLimit.match.keywords, 'x'] } },
      ],
      ['keyword length', { ...atLimit, match: { ...atLimit.match, keywords: ['w'.repeat(257)] } }],
      [
        'scope count',
        {
          ...atLimit,
          match: {
            ...atLimit.match,
            scopeChannelIds: [...atLimit.match.scopeChannelIds, 'x'],
          },
        },
      ],
      [
        'scope length',
        { ...atLimit, match: { ...atLimit.match, scopeChannelIds: ['s'.repeat(257)] } },
      ],
      [
        'procedure count',
        {
          ...atLimit,
          procedure: [...atLimit.procedure, { action: 'a', description: 'd' }],
        },
      ],
      ['action length', { ...atLimit, procedure: [{ action: 'a'.repeat(257), description: 'd' }] }],
      [
        'description length',
        { ...atLimit, procedure: [{ action: 'a', description: 'd'.repeat(2_001) }] },
      ],
      ['evidence count', { ...atLimit, requiredEvidence: [...atLimit.requiredEvidence, 'x'] }],
      ['evidence length', { ...atLimit, requiredEvidence: ['e'.repeat(1_001)] }],
    ];
    for (const [label, spec] of overLimit) {
      expect(() => validateTriggerSpec(spec), label).toThrow();
    }
  });
});
