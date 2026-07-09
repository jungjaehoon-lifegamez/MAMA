import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(TEST_DIR, '..', '..', 'src');

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      walkTsFiles(abs, out);
    } else if (entry.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function discoverExecuteCallsites(): string[] {
  const patterns = [
    /\bmcpExecutor\.execute\s*\(/,
    /\bgatewayToolExecutor\.execute\s*\(/,
    /\bexecutor\.execute\s*\(/,
  ];

  return walkTsFiles(SRC_ROOT).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    const rel = relative(SRC_ROOT, file);
    const hits: string[] = [];

    for (const pattern of patterns) {
      if (pattern.test(text)) {
        hits.push(rel);
      }
    }

    return hits;
  });
}

const CLASSIFIED = new Map<string, string>([
  [
    'agent/agent-loop.ts',
    'P1 thread: AgentLoopOptions.envelope copied by buildToolExecutionContext()',
  ],
  ['gateways/message-router.ts', 'P1 thread: creates signed envelope and passes AgentLoopOptions'],
  [
    'agent/code-act/host-bridge.ts',
    'M1R Reactive Main: HostBridge gateway calls carry the active envelope context',
  ],
  ['multi-agent/', 'M7-owned: spawn_subordinate delegated memory worker envelopes are outside M1R'],
  ['scheduler/', 'M8-owned: schedule_worker/Autonomous Standing envelope issuance is outside M1R'],
]);

function classificationFor(rel: string): string | undefined {
  for (const [prefix, classification] of CLASSIFIED.entries()) {
    if (rel === prefix || rel.startsWith(prefix)) {
      return classification;
    }
  }
  return undefined;
}

describe('envelope call-site matrix', () => {
  it('documents every GatewayToolExecutor execute call site before fail-loud closure', () => {
    expect(existsSync(SRC_ROOT)).toBe(true);

    const discovered = [...new Set(discoverExecuteCallsites())].sort();
    const unclassified = discovered.filter((rel) => !classificationFor(rel));

    expect(unclassified).toEqual([]);
    expect(discovered).toContain('agent/agent-loop.ts');
  });
});
