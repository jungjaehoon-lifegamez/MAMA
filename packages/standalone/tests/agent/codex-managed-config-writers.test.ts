import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentProcessManager } from '../../src/multi-agent/agent-process-manager.js';
import { GatewayToolExecutor } from '../../src/agent/index.js';
import type { AgentPersonaConfig, MultiAgentConfig } from '../../src/multi-agent/types.js';

/**
 * Story F3: one shared managed Codex config, many writers
 *
 * codexHome defaults to ~/.mama/.codex for every Codex process, and
 * prepareManagedFiles rewrites config.toml whenever the on-disk text differs from
 * that process's own expected fingerprint. A construction site that omits the
 * effort does not merely lose the setting for itself - it rewrites the shared file
 * back to the default and flips the effective effort for every other live child.
 *
 * Acceptance Criteria:
 * - AC: the direct Codex construction sites in src/ are exactly the pinned set
 * - AC: every direct site threads `effort`
 * - AC: the AgentLoop-mediated sites in src/ are exactly the pinned set
 * - AC: every AgentLoop site that can run codex threads `codexEffort`
 * - AC: the multi-agent Codex runner carries the global runtime effort
 * - AC: the managed Code-Act runner carries the global runtime effort
 */

const REPO_SRC = join(__dirname, '..', '..', 'src');

/** Direct writers: they construct a Codex process themselves and MUST pass `effort`. */
const PINNED_DIRECT_SITES = [
  'agent/agent-loop.ts',
  'agent/backend-model-runner-factory.ts',
  'multi-agent/agent-process-manager.ts',
  'multi-agent/runtime-process.ts',
  'operator/trigger-author.ts',
] as const;

/**
 * Indirect writers: they build an AgentLoop that constructs the Codex process for
 * them, so they MUST pass `codexEffort`. This class is why the first F3 sweep was
 * incomplete - grepping only for `new Codex...` cannot see them.
 */
const PINNED_AGENT_LOOP_SITES = [
  'cli/commands/run.ts',
  'cli/runtime/agent-loop-init.ts',
  'cli/runtime/memory-agent-init.ts',
  'multi-agent/agent-process-manager.ts',
] as const;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(REPO_SRC);
  return out;
}

function filesMatching(pattern: RegExp): string[] {
  return sourceFiles()
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(REPO_SRC, file).split(sep).join('/'))
    .sort();
}

describe('F3: writers of the shared managed Codex config', () => {
  describe('AC: direct Codex construction sites', () => {
    it('pins the whole src tree so a new direct writer fails this suite', () => {
      expect(filesMatching(/new Codex(RuntimeProcess|AppServerProcess)\(/)).toEqual([
        ...PINNED_DIRECT_SITES,
      ]);
    });

    it.each(PINNED_DIRECT_SITES)('%s threads effort', (relativePath) => {
      expect(readFileSync(join(REPO_SRC, relativePath), 'utf8')).toMatch(/\beffort:/);
    });
  });

  describe('AC: AgentLoop-mediated construction sites', () => {
    it('pins the whole src tree so a new AgentLoop writer fails this suite', () => {
      expect(filesMatching(/new AgentLoop\(/)).toEqual([...PINNED_AGENT_LOOP_SITES]);
    });

    it.each(PINNED_AGENT_LOOP_SITES)('%s threads codexEffort', (relativePath) => {
      expect(readFileSync(join(REPO_SRC, relativePath), 'utf8')).toMatch(/\bcodexEffort:/);
    });
  });

  describe('AC: runners carry the global runtime effort', () => {
    let previousHome: string | undefined;
    let tempHome: string;

    beforeEach(() => {
      previousHome = process.env.HOME;
      tempHome = mkdtempSync(join(tmpdir(), 'mama-codex-writers-'));
      process.env.HOME = tempHome;
    });

    afterEach(() => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(tempHome, { recursive: true, force: true });
    });

    function manager(effort?: string): AgentProcessManager {
      return new AgentProcessManager({ agents: {} } as MultiAgentConfig, {}, {
        backend: 'codex',
        model: 'gpt-5.6-luna',
        ...(effort ? { effort } : {}),
      } as ConstructorParameters<typeof AgentProcessManager>[2]);
    }

    function codexRunnerOptions(effort?: string): { effort?: string } {
      const runner = (
        manager(effort) as unknown as {
          createCodexRunner(
            options: Record<string, unknown>,
            sessionKey: string
          ): { options: { effort?: string } };
        }
      ).createCodexRunner({}, 'session-1');
      return runner.options;
    }

    function codeActRunnerOptions(effort?: string): { effort?: string } {
      const runner = (
        manager(effort) as unknown as {
          createManagedCodeActRunner(
            backend: 'codex' | 'cline',
            options: Record<string, unknown>,
            sessionKey: string,
            source: string,
            channelId: string,
            agentId: string,
            agentConfig: Omit<AgentPersonaConfig, 'id'>,
            executor: GatewayToolExecutor
          ): unknown;
        }
      ).createManagedCodeActRunner(
        'codex',
        { systemPrompt: 'system', model: 'gpt-5.6-luna' },
        'session-1',
        'cli',
        'channel-1',
        'workorder-board',
        { tier: 2 } as Omit<AgentPersonaConfig, 'id'>,
        new GatewayToolExecutor({})
      );
      return (runner as { loop: { agent: { options: { effort?: string } } } }).loop.agent.options;
    }

    it('carries the global runtime effort into the plain Codex runner', () => {
      expect(codexRunnerOptions('xhigh').effort).toBe('xhigh');
    });

    it('leaves the plain Codex runner effort unset when the runtime has none', () => {
      expect(codexRunnerOptions().effort).toBeUndefined();
    });

    it('carries the global runtime effort into the managed Code-Act runner', () => {
      expect(codeActRunnerOptions('xhigh').effort).toBe('xhigh');
    });

    it('leaves the managed Code-Act runner effort unset when the runtime has none', () => {
      expect(codeActRunnerOptions().effort).toBeUndefined();
    });
  });
});
