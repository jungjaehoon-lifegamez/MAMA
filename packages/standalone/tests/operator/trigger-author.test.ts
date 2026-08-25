/**
 * Unit tests for trigger authoring (Task 3 - G1+G3: the agent writes its own triggers).
 * The agent is INJECTED (askAgent stub) so this is deterministic; the real claude-CLI
 * agent is exercised by the LLM eval (RUN_LLM_EVAL). Validation is STRUCTURAL only -
 * unknown kind/action VALUES are accepted (never narrowed to a catalog), or G3 re-freezes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import {
  authorTriggers,
  createAskAgentCLI,
  createTriggerAgentRuntime,
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

describe('trigger agent provider boundary', () => {
  it('uses a customization-free, tool-free, non-persistent Claude JSON session (TG-05)', async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ type: 'result', result: '[{"kind":"k"}]' }),
    });
    const askAgent = createAskAgentCLI(execute);

    await expect(askAgent('author prompt')).resolves.toBe('[{"kind":"k"}]');
    expect(execute).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        'author prompt',
        '--output-format',
        'json',
        '--effort',
        'high',
        '--safe-mode',
        '--tools',
        '',
        '--no-session-persistence',
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    );
  });

  it('constructs the Claude trigger runner with the configured model (TG-06)', async () => {
    const askClaude = vi.fn().mockResolvedValue('[]');
    const createClaudeAsk = vi.fn(() => askClaude);
    const dependencies = { createClaudeAsk } as unknown as Parameters<
      typeof createTriggerAgentRuntime
    >[2];

    const runtime = createTriggerAgentRuntime('claude', { model: 'claude-sonnet-5' }, dependencies);

    expect(createClaudeAsk).toHaveBeenCalledWith({
      model: 'claude-sonnet-5',
      signal: expect.any(AbortSignal),
    });
    await expect(runtime.askAuthor('author')).resolves.toBe('[]');
    await expect(runtime.askReview('review')).resolves.toBe('[]');
    expect(askClaude).toHaveBeenCalledTimes(2);
  });

  it('passes the configured model to the Claude CLI instead of inheriting user settings', async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ type: 'result', result: '[]' }),
    });
    const askAgent = createAskAgentCLI(execute, { model: 'claude-sonnet-5' });

    await askAgent('review prompt');

    const args = execute.mock.calls[0][1];
    const modelIndex = args.indexOf('--model');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(args[modelIndex + 1]).toBe('claude-sonnet-5');
  });

  it('does not construct Codex for the Claude backend and propagates Claude failures', async () => {
    const failure = new Error('claude failed');
    const askClaude = vi.fn().mockRejectedValue(failure);
    const createCodexRuntime = vi.fn();
    const runtime = createTriggerAgentRuntime('claude', {}, { askClaude, createCodexRuntime });

    await expect(runtime.askAuthor('prompt')).rejects.toBe(failure);
    expect(createCodexRuntime).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('TG-05/TG-06 aborts and drains an in-flight Claude trigger call on stop', async () => {
    let runtimeSignal: AbortSignal | undefined;
    let rejectCall: ((error: Error) => void) | undefined;
    let abortObserved = false;
    const createClaudeAsk = vi.fn((options: { model?: string; signal?: AbortSignal }) => {
      runtimeSignal = options.signal;
      return async () =>
        new Promise<string>((_resolve, reject) => {
          rejectCall = reject;
          options.signal?.addEventListener('abort', () => {
            abortObserved = true;
          });
        });
    });
    const runtime = createTriggerAgentRuntime('claude', {}, { createClaudeAsk });
    const pending = runtime.askAuthor('long author prompt');
    const rejection = expect(pending).rejects.toThrow('aborted');

    let stopResolved = false;
    const stopping = Promise.all([runtime.stop(), runtime.stop()]).then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(abortObserved).toBe(true);
    expect(stopResolved).toBe(false);

    rejectCall?.(new Error('claude trigger call aborted after child cleanup'));
    await stopping;
    await rejection;

    expect(runtimeSignal?.aborted).toBe(true);
    expect(createClaudeAsk).toHaveBeenCalledTimes(1);
  });

  it('uses one read-only Codex app-server runner with isolated fresh author and review lanes', async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({ response: '[{"kind":"k"}]' })
      .mockResolvedValueOnce({ response: '{"action":"kept"}' });
    const stop = vi.fn().mockResolvedValue(undefined);
    const createCodexRuntime = vi.fn(() => ({ prompt, stop }));
    const runtime = createTriggerAgentRuntime(
      'codex',
      {
        model: 'gpt-5.4',
        cwd: '/safe/workspace',
        command: '/usr/local/bin/codex',
      },
      { createCodexRuntime }
    );

    await expect(runtime.askAuthor('author prompt')).resolves.toBe('[{"kind":"k"}]');
    await expect(runtime.askReview('review prompt')).resolves.toBe('{"action":"kept"}');

    expect(createCodexRuntime).toHaveBeenCalledTimes(1);
    expect(createCodexRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        cwd: '/safe/workspace',
        command: '/usr/local/bin/codex',
        sandbox: 'read-only',
      })
    );
    const authorOptions = prompt.mock.calls[0][2];
    const reviewOptions = prompt.mock.calls[1][2];
    expect(authorOptions).toEqual(
      expect.objectContaining({
        sessionKey: 'operator:trigger-author',
        resumeSession: false,
      })
    );
    expect(reviewOptions).toEqual(
      expect.objectContaining({
        sessionKey: 'operator:trigger-review',
        resumeSession: false,
      })
    );
    expect(authorOptions.sessionKey).not.toBe(reviewOptions.sessionKey);
    expect(authorOptions).not.toHaveProperty('hostToolBridge');
    expect(reviewOptions).not.toHaveProperty('hostToolBridge');
    expect(JSON.stringify(createCodexRuntime.mock.calls)).not.toMatch(/mcp|tool_call/i);
  });

  it('threads the configured effort into the Codex trigger runner', () => {
    const createCodexRuntime = vi.fn(() => ({
      prompt: vi.fn().mockResolvedValue({ response: '[]' }),
      stop: vi.fn().mockResolvedValue(undefined),
    }));

    createTriggerAgentRuntime(
      'codex',
      { model: 'gpt-5.4', cwd: '/safe/workspace', effort: 'xhigh' },
      { createCodexRuntime }
    );

    expect(createCodexRuntime).toHaveBeenCalledWith(expect.objectContaining({ effort: 'xhigh' }));
  });

  it('uses isolated Cline routes for isolated author and review calls', async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({ response: '[{"kind":"cline"}]' })
      .mockResolvedValueOnce({ response: '{"action":"kept"}' });
    const stop = vi.fn();
    const createClineRuntime = vi.fn(() => ({ prompt, stop }));
    const runtime = createTriggerAgentRuntime(
      'cline',
      {
        model: 'deepseek/deepseek-v4-flash',
        cwd: '/safe/workspace',
        command: '/usr/local/bin/cline',
        provider: 'cline',
      },
      { createClineRuntime }
    );

    await expect(runtime.askAuthor('author prompt')).resolves.toBe('[{"kind":"cline"}]');
    await expect(runtime.askReview('review prompt')).resolves.toBe('{"action":"kept"}');
    expect(createClineRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/usr/local/bin/cline',
        provider: 'cline',
        model: 'deepseek/deepseek-v4-flash',
        cwd: '/safe/workspace',
      })
    );
    expect(prompt.mock.calls[0][2]).toEqual(
      expect.objectContaining({ resumeSession: false, sessionKey: 'operator:trigger-author' })
    );
    expect(prompt.mock.calls[1][2]).toEqual(
      expect.objectContaining({ resumeSession: false, sessionKey: 'operator:trigger-review' })
    );
    await runtime.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('propagates malformed Codex results and runner errors without fallback', async () => {
    const malformedRuntime = createTriggerAgentRuntime(
      'codex',
      {},
      {
        createCodexRuntime: () => ({
          prompt: vi.fn().mockResolvedValue({ response: null }),
          stop: vi.fn(),
        }),
      }
    );
    await expect(malformedRuntime.askAuthor('prompt')).rejects.toThrow(
      'Codex trigger agent did not return a text result'
    );

    const failure = new Error('codex failed');
    const failingRuntime = createTriggerAgentRuntime(
      'codex',
      {},
      {
        createCodexRuntime: () => ({
          prompt: vi.fn().mockRejectedValue(failure),
          stop: vi.fn(),
        }),
      }
    );
    await expect(failingRuntime.askReview('prompt')).rejects.toBe(failure);
  });

  it('stops the shared Codex runner exactly once', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const runtime = createTriggerAgentRuntime(
      'codex',
      {},
      {
        createCodexRuntime: () => ({
          prompt: vi.fn(),
          stop,
        }),
      }
    );

    await Promise.all([runtime.stop(), runtime.stop()]);
    await runtime.stop();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
