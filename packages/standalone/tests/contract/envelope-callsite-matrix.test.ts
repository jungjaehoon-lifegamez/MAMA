import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src');

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
    /\bmcpExecutor\.execute\s*\(/g,
    /\bgatewayToolExecutor\.execute\s*\(/g,
    /\bexecutor\.execute\s*\(/g,
  ];

  return walkTsFiles(SRC_ROOT).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    const rel = relative(SRC_ROOT, file);
    const hits: string[] = [];

    for (const pattern of patterns) {
      if (pattern.test(text)) {
        hits.push(rel);
      }
      pattern.lastIndex = 0;
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
    'P5 deferred: explicit legacy warning until Code-Act envelope plan',
  ],
  ['multi-agent/', 'P5 deferred: subordinate envelope work'],
  ['scheduler/', 'P5 deferred: Autonomous Standing envelope issuance in M8'],
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
