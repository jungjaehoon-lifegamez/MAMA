import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { SituationReporter } from '../../src/operator/situation-report.js';
import { CodexRuntimeProcess } from '../../src/multi-agent/runtime-process.js';
import { evaluateJudgment, parseModelJudgment, type JudgmentFixture } from './evaluator.js';

type Mode = 'baseline' | 'candidate';

interface FixtureFile {
  version: number;
  description: string;
  fixtures: JudgmentFixture[];
}

const COMMON_INSTRUCTIONS = `This is a supplied-evidence evaluation of the production report guidance. Treat the fixture as the only available sources; native/external tools are unavailable. Do not infer successful actions that were not executed.
Return JSON only with this exact shape:
{"fixtureId":"...","conclusions":[{"label":"...","disposition":"confirmed|unconfirmed|unsupported|completed|agent_action|owner_decision","period":"YYYY-MM","evidenceRefs":["..."],"explanation":"..."}],"coverageGaps":["..."],"report":"plain scannable report"}
Emit exactly one conclusion for every supplied material label. Cite only supplied evidence refs observed at or before the report as-of.`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv: string[]): { mode: Mode; outputRoot: string } {
  const modeArg = argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length);
  if (modeArg !== 'baseline' && modeArg !== 'candidate') {
    throw new Error(
      'Usage: tsx evals/report-judgment/run.ts --mode=baseline|candidate [--output=PATH]'
    );
  }
  const outputArg = argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
  return {
    mode: modeArg,
    outputRoot: resolve(outputArg ?? '.superpowers/eval-artifacts/report-judgment'),
  };
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function main(): Promise<void> {
  const { mode, outputRoot } = parseArgs(process.argv.slice(2));
  const here = __dirname;
  const fixturePath = join(here, 'fixtures.v1.json');
  const fixtureBytes = await readFile(fixturePath, 'utf8');
  const fixtureFile = JSON.parse(fixtureBytes) as FixtureFile;
  const baselinePath = join(outputRoot, 'baseline-guidance.txt');
  await privateDirectory(outputRoot);
  const currentGuidance = new SituationReporter()
    .buildPrompt('full')
    .replace(/^Current local time:.*$/m, 'Use the fixture asOf as the sole report clock.');
  if (mode === 'baseline') {
    await writeFile(baselinePath, currentGuidance, { mode: 0o600, flag: 'wx' }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        if ((await readFile(baselinePath, 'utf8')) !== currentGuidance)
          throw new Error('Baseline guidance changed; use a new output directory');
      }
    );
  }
  const baselineGuidance = await readFile(baselinePath, 'utf8');
  const guidance = `${mode === 'candidate' ? currentGuidance : baselineGuidance}\n\n${COMMON_INSTRUCTIONS}`;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}-${randomUUID().slice(0, 8)}`;
  const runRoot = join(outputRoot, runId);
  const runtimeRoot = join(runRoot, 'runtime');
  const cwd = join(runtimeRoot, 'cwd');
  const codexHome = join(runtimeRoot, 'codex-home');
  const isolatedHome = join(runtimeRoot, 'home');
  const registryRoot = join(runtimeRoot, 'registry');
  await Promise.all([
    privateDirectory(runRoot),
    privateDirectory(cwd),
    privateDirectory(codexHome),
    privateDirectory(isolatedHome),
    privateDirectory(registryRoot),
  ]);

  // Stop project instruction discovery at the synthetic evaluation workspace.
  await promisify(execFile)('git', ['init', '--quiet', cwd]);

  const runtime = new CodexRuntimeProcess({
    model: 'gpt-5.6-sol',
    effort: 'medium',
    systemPrompt: guidance,
    cwd,
    codexHome,
    isolatedHome,
    registryRoot,
    sandbox: 'read-only',
    auxiliaryToolPolicy: { allowedTools: [], roots: [cwd] },
    requestTimeout: 180_000,
  });

  const records: Array<Record<string, unknown>> = [];
  try {
    for (const fixture of fixtureFile.fixtures) {
      const prompt = JSON.stringify({
        fixtureId: fixture.id,
        asOf: fixture.asOf,
        materialLabels: fixture.expected.map((item) => item.label),
        evidence: fixture.evidence,
      });
      const startedAt = new Date();
      const startedMs = Date.now();
      try {
        const result = await runtime.prompt(prompt, undefined, {
          sessionKey: `report-judgment:${runId}:${fixture.id}`,
          resumeSession: false,
          model: 'gpt-5.6-sol',
          systemPrompt: guidance,
          requestTimeout: 180_000,
        });
        const judgment = parseModelJudgment(result.response);
        records.push({
          fixtureId: fixture.id,
          asOf: fixture.asOf,
          startedAt: startedAt.toISOString(),
          elapsedMs: Date.now() - startedMs,
          promptSha256: sha256(prompt),
          responseSha256: sha256(result.response),
          response: result.response,
          evaluation: evaluateJudgment(fixture, judgment),
          usage: result.usage,
          error: null,
        });
      } catch (error: unknown) {
        records.push({
          fixtureId: fixture.id,
          asOf: fixture.asOf,
          startedAt: startedAt.toISOString(),
          elapsedMs: Date.now() - startedMs,
          promptSha256: sha256(prompt),
          responseSha256: null,
          response: null,
          evaluation: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await runtime.stop();
    await unlink(join(codexHome, 'auth.json')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  const artifact = {
    schemaVersion: 1,
    runId,
    mode,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    fixtureSha256: sha256(fixtureBytes),
    guidanceSha256: sha256(guidance),
    suppliedEvidenceOnly: true,
    autonomousRetrievalEvaluated: false,
    structuredEvaluationOnly: true,
    independentSemanticReviewRequired: true,
    baselineGuidanceSha256: sha256(baselineGuidance),
    evaluationProtocolSha256: sha256(COMMON_INSTRUCTIONS),
    p95ClaimSupported: false,
    records,
  };
  const artifactPath = join(runRoot, 'results.json');
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${artifactPath}\n`);
  // Nonzero distinguishes provider/setup failure from rubric review; an artifact alone is not a pass.
  if (
    records.length !== fixtureFile.fixtures.length ||
    records.some((record) => record.error !== null)
  ) {
    process.exitCode = 1;
  } else if (
    records.some((record) => (record.evaluation as { passed: boolean } | null)?.passed !== true)
  ) {
    process.exitCode = 2;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
