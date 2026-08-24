/**
 * F3 regression pin: every Codex process writes the SAME managed config.toml
 * (codexHome defaults to ~/.mama/.codex for all of them) and prepareManagedFiles
 * rewrites it whenever the on-disk text differs from that process's own expected
 * fingerprint. So a construction site that omits `effort` does not merely lose the
 * setting for itself - it rewrites the shared file back to the default and flips
 * the effective effort for every other live child.
 *
 * Two guards below:
 *   1. the pinned set of construction sites (a new one must thread effort too);
 *   2. the multi-agent runner actually carrying the global effort.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentProcessManager } from '../../src/multi-agent/agent-process-manager.js';
import type { MultiAgentConfig } from '../../src/multi-agent/types.js';

const REPO_SRC = join(__dirname, '..', '..', 'src');

/** Every production file that constructs a Codex process. Each MUST thread agent.effort. */
const PINNED_CONSTRUCTION_SITES = [
  'agent/agent-loop.ts',
  'agent/backend-model-runner-factory.ts',
  'multi-agent/agent-process-manager.ts',
  'multi-agent/runtime-process.ts',
  'operator/trigger-author.ts',
] as const;

function sourceFilesConstructingCodex(): string[] {
  const found: string[] = [];
  for (const relative of PINNED_CONSTRUCTION_SITES) {
    const text = readFileSync(join(REPO_SRC, relative), 'utf8');
    if (/new Codex(RuntimeProcess|AppServerProcess)\(/.test(text)) {
      found.push(relative);
    }
  }
  return found;
}

describe('F3: writers of the shared managed Codex config', () => {
  it('pins the known construction sites so a new one has to thread effort too', () => {
    expect(sourceFilesConstructingCodex()).toEqual([...PINNED_CONSTRUCTION_SITES]);
  });

  it.each(PINNED_CONSTRUCTION_SITES)('%s passes effort into the Codex process', (relative) => {
    const text = readFileSync(join(REPO_SRC, relative), 'utf8');
    expect(text).toMatch(/\beffort:/);
  });

  describe('multi-agent codex runner', () => {
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

    function codexRunnerOptions(effort?: string): { effort?: string } {
      const manager = new AgentProcessManager({ agents: {} } as MultiAgentConfig, {}, {
        backend: 'codex',
        model: 'gpt-5.6-luna',
        ...(effort ? { effort } : {}),
      } as ConstructorParameters<typeof AgentProcessManager>[2]);
      const runner = (
        manager as unknown as {
          createCodexRunner(
            options: Record<string, unknown>,
            sessionKey: string
          ): { options: { effort?: string } };
        }
      ).createCodexRunner({}, 'session-1');
      return (runner as unknown as { options: { effort?: string } }).options;
    }

    it('carries the global runtime effort', () => {
      expect(codexRunnerOptions('xhigh').effort).toBe('xhigh');
    });

    it('leaves effort unset when the runtime has none', () => {
      expect(codexRunnerOptions().effort).toBeUndefined();
    });
  });
});
