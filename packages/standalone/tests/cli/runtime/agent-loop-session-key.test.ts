/**
 * Wiring guard: session keys are per-call options, never shared-instance state.
 *
 * agent-loop-init's client wrapper used to call agentLoop.setSessionKey()
 * before each run. On the shared AgentLoop this raced overlapping runs: run B
 * could mutate the key after run A computed its lane but before A enqueued,
 * sending A down B's session lane (observed live as polluted `default:*`
 * zero-tool sessions). The fix threads the key through callOptions.sessionKey,
 * which both run() and runWithContent() must prefer over this.sessionKey.
 * Source-guard both sides the same way agent-loop-client-usage.test.ts does.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const initSource = readFileSync(
  join(__dirname, '../../../src/cli/runtime/agent-loop-init.ts'),
  'utf-8'
);
const loopSource = readFileSync(join(__dirname, '../../../src/agent/agent-loop.ts'), 'utf-8');

describe('per-call session keys (no shared-instance mutation)', () => {
  it('client wrapper never mutates the shared AgentLoop session key', () => {
    expect(initSource).not.toMatch(/agentLoop\.setSessionKey\(/);
    // The key must instead ride the per-call options both wrappers build.
    const matches = initSource.match(/callOptions\.sessionKey =/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // run + runWithContent
  });

  it('AgentLoop.run resolves its lane from options.sessionKey first', () => {
    const runBody = loopSource.slice(
      loopSource.indexOf('async run(prompt: string'),
      loopSource.indexOf('async runWithContent(')
    );
    expect(runBody).toMatch(/options\?\.sessionKey \|\| this\.sessionKey/);
    // Lane resolution and enqueue must use the resolved key, not the field.
    expect(runBody).not.toMatch(/resolveGlobalLaneForSession\(this\.sessionKey\)/);
    expect(runBody).not.toMatch(/enqueueWithSession\(\s*this\.sessionKey/);
  });
});
