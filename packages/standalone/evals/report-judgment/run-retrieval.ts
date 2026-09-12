/** Actual AgentLoop -> CodeAct -> TaskLedger/calendar-reader evaluation. Synthetic local data only. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resetConfigCache } from '../../src/cli/config/config-manager.js';
import { AgentLoop as CandidateLoop } from '../../src/agent/agent-loop.js';
import { GatewayToolExecutor as CandidateExecutor } from '../../src/agent/gateway-tool-executor.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { RawStore } from '@jungjaehoon/mama-core/storage/source-archive';
import { SituationReporter } from '../../src/operator/situation-report.js';
import Database from '../../src/sqlite.js';
import { makeSignedEnvelope } from '../../tests/envelope/fixtures.js';

interface Fixture {
  asOf: string;
  nativeDeadline: string;
  start: string;
  end: string;
  summary: string;
}
async function main(): Promise<void> {
  const mode = process.argv.find((x) => x.startsWith('--mode='))?.slice(7);
  if (mode !== 'baseline' && mode !== 'candidate')
    throw new Error('Expected --mode=baseline|candidate');
  const output = process.argv.find((x) => x.startsWith('--output='))?.slice(9);
  if (!output) throw new Error('--output is required');
  const base = resolve(output);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const fixturePath = join(base, 'retrieval-fixture.json');
  if (mode === 'baseline' && !existsSync(fixturePath)) {
    const day = new Date().toISOString().slice(0, 10);
    const midnight = Date.parse(day + 'T00:00:00Z');
    const created = new Date(midnight);
    // Land the deadline in the NEXT calendar month (mid-month), so a month-end creation date does
    // not skip a month the way a fixed +35d offset would (e.g. Jan 30 -> March).
    const nextMonth = new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth() + 1, 15));
    const fixture: Fixture = {
      asOf: new Date().toISOString(),
      nativeDeadline: nextMonth.toISOString().slice(0, 10),
      start: new Date(midnight - 86400000).toISOString(),
      end: new Date(midnight + 86400000).toISOString(),
      summary:
        'Current-month service renewal remains pending external confirmation. Owner approval was received; completion is unverified. The next-month renewal is a separate obligation.',
    };
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), { mode: 0o600, flag: 'wx' });
  }
  const bytes = readFileSync(fixturePath, 'utf8');
  const fixture = JSON.parse(bytes) as Fixture;
  // Both real reader clocks must stay well inside the same fixed overlap interval.
  if (
    Date.now() < Date.parse(fixture.start) + 3600000 ||
    Date.now() >= Date.parse(fixture.end) - 3600000
  ) {
    throw new Error('Fixture clock window expired; freeze a new baseline fixture');
  }
  const root = join(base, `${mode}-${Date.now()}`);
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '--quiet', cwd]);
  const db = new Database(join(root, 'operator.db'));
  const ledger = new TaskLedger(db, { now: () => Date.parse(fixture.asOf), timeZone: 'UTC' });
  ledger.create({
    title: 'Next-month service renewal',
    deadline: fixture.nativeDeadline,
    completion_criteria: 'External confirmation for next-month renewal is received.',
  });
  const raw = new RawStore(join(root, 'connectors'));
  raw.save('calendar', [
    {
      source: 'calendar',
      sourceId: 'synthetic-current-renewal',
      channel: 'calendar',
      author: 'synthetic-source',
      content: fixture.summary,
      timestamp: new Date(fixture.start),
      type: 'event',
      metadata: {
        summary: fixture.summary,
        start: fixture.start,
        end: fixture.end,
        status: 'confirmed',
      },
    },
  ]);
  process.env.MAMA_CALENDAR_RAW_DB = join(root, 'connectors', 'calendar', 'raw.db');
  process.env.MAMA_DB_PATH = join(root, 'core.db');
  process.env.MAMA_FORCE_TIER_3 = 'true';
  const installed = '/opt/homebrew/lib/node_modules/@jungjaehoon/mama-os/dist';
  // Baseline is the already verified installed 0.50.0 artifact; candidate imports source. Verify the
  // installed version so a global-package upgrade cannot silently make "baseline" a different build.
  if (mode === 'baseline') {
    const installedPkg = JSON.parse(
      readFileSync(join(installed, '..', 'package.json'), 'utf8')
    ) as {
      version?: string;
    };
    if (installedPkg.version !== '0.50.0') {
      throw new Error(
        `Baseline requires installed @jungjaehoon/mama-os 0.50.0; found ${installedPkg.version ?? 'unknown'}.`
      );
    }
  }
  const Loop: typeof CandidateLoop =
    mode === 'baseline' ? require(installed + '/agent/agent-loop.js').AgentLoop : CandidateLoop;
  const Executor: typeof CandidateExecutor =
    mode === 'baseline'
      ? require(installed + '/agent/gateway-tool-executor.js').GatewayToolExecutor
      : CandidateExecutor;
  resetConfigCache(true);
  if (mode === 'baseline')
    require(installed + '/cli/config/config-manager.js').resetConfigCache(true);
  const executor = new Executor({ mamaDbPath: join(root, 'core.db') });
  executor.setTaskLedger(ledger);
  const role = {
    model: 'gpt-5.6-sol',
    maxTurns: 12,
    allowedTools: ['code_act', 'task_list', 'schedule_upcoming'],
    blockedTools: ['Bash', 'Write', 'Read', 'native_subagent'],
    systemControl: false,
    sensitiveAccess: false,
  };
  const trace: Array<{ tool: string; success: boolean | null }> = [];
  const prompt =
    new SituationReporter()
      .buildPrompt('full')
      .replace(/^Current local time:.*$/m, `Report as-of: ${fixture.asOf}.`) +
    '\nProvide the full report for this synthetic workspace. The task ledger reader task_list and calendar reader schedule_upcoming are available. Use tool_describe to inspect their contracts if needed. Choose and read relevant sources yourself. Report actual facts and unresolved work; a calendar confirmed status confirms the schedule entry, not business completion. No mutation tools are available. Do not claim to have performed an action.';
  const loop = new Loop(null, {
    backend: 'codex',
    model: 'gpt-5.6-sol',
    codexEffort: 'medium',
    systemPrompt: 'MAMA synthetic read-only report evaluation.',
    codexCwd: cwd,
    codexHome: join(root, 'codex-home'),
    codexIsolatedHome: join(root, 'home'),
    codexRegistryRoot: join(root, 'registry'),
    codexSandbox: 'read-only',
    useCodeAct: true,
    useLanes: true,
    executor,
    timeoutMs: 180000,
    onToolUse: (tool, _input, result) => {
      trace.push({
        tool,
        success:
          result && typeof result === 'object' && 'success' in result
            ? result.success === true
            : null,
      });
    },
  });
  const started = performance.now();
  try {
    const result = await loop.run(prompt, {
      sessionKey: 'owner:runtime',
      source: 'operator',
      channelId: 'report',
      sourceMessageRef: 'owner-report:synthetic-readonly',
      disableAutoRecall: true,
      sessionPolicyRole: role,
      envelope: makeSignedEnvelope({
        source: 'cron',
        channel_id: 'report',
        budget: { wall_seconds: 600 },
        expires_at: new Date(Date.now() + 600000).toISOString(),
        scope: {
          project_refs: [],
          memory_scopes: [],
          raw_connectors: ['calendar'],
          allowed_destinations: [],
        },
      }),
      agentContext: {
        source: 'operator',
        platform: 'cli',
        roleName: 'owner_console',
        role,
        session: {
          sessionId: 'synthetic',
          channelId: 'report',
          userId: 'synthetic-owner',
          startedAt: new Date(fixture.asOf),
        },
        capabilities: role.allowedTools,
        limitations: [],
        backend: 'codex',
        tier: 1,
      },
    });
    const evidenceDb = new Database(join(root, 'core.db'));
    const businessReads = evidenceDb
      .prepare(
        "SELECT tool_name, COUNT(*) AS count FROM tool_traces WHERE execution_status = 'completed' AND tool_name IN ('task_list', 'schedule_upcoming') GROUP BY tool_name"
      )
      .all() as Array<{ tool_name: string; count: number }>;
    evidenceDb.close();
    const retrievalExercised = ['task_list', 'schedule_upcoming'].every((name) =>
      businessReads.some((row) => row.tool_name === name && row.count > 0)
    );
    const artifact = {
      mode,
      businessReads,
      retrievalExercised,
      asOf: fixture.asOf,
      actualReaderClock: new Date().toISOString(),
      fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
      promptSha256: createHash('sha256').update(prompt).digest('hex'),
      model: 'gpt-5.6-sol',
      elapsedMs: performance.now() - started,
      response: result.response,
      history: result.history,
      trace,
      boundary:
        'Real model/AgentLoop/CodeAct/TaskLedger/calendar reader; synthetic local stores and restricted read-only tool set. No live sources or delivery. Reader clocks differ but both are inside the same fixed membership interval; independent semantic assessment required.',
    };
    const path = join(root, 'result.json');
    writeFileSync(path, JSON.stringify(artifact, null, 2), { mode: 0o600 });
    process.stdout.write(path + '\n');
    if (!retrievalExercised) process.exitCode = 1;
  } finally {
    await loop.stop();
    const authCopy = join(root, 'codex-home', 'auth.json');
    if (existsSync(authCopy)) unlinkSync(authCopy);
    raw.close();
    db.close();
  }
}
void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
