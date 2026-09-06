/**
 * workerRun - the operator's worker primitive (plan: owner-console v6 S0-T1).
 *
 * A maintenance work order is a bounded stimulus for the standing owner agent.
 * The maintenance kind never creates another model identity. If specialist or
 * parallel work is useful, the owner agent creates native subagents itself and
 * remains responsible for their result.
 *
 * CALLER CONTRACT (deadlock seal):
 * - Callers must be HOST CODE running OUTSIDE any lane (scheduler ticks,
 *   work-order consumers, forwarder hooks).
 * - NEVER call workerRun from inside an active lane run (an LLM run's tool
 *   handler, a report run, another worker): the parent holds its global lane
 *   slot for its whole duration, so a nested awaited lane run can queue
 *   behind its own parent forever.
 *
 * Concurrency: every owner stimulus serializes on the one owner runtime lane.
 */

import { createHash } from 'node:crypto';
import type { AgentLoopOptions, ContentBlock } from '../agent/types.js';
import type { PrivateConnectorPolicy } from '../connectors/private-connector-policy.js';
import { projectConsoleBriefForPrompt } from './console-brief.js';
import { stripMarkedPrivatePromptOverlays } from '../connectors/private-prompt-overlay.js';
import { OWNER_RUNTIME_SESSION_KEY } from './owner-runtime.js';

/** Identity fields workerRun owns - never overridable by callers (plan E7/G3). */
export interface WorkerIdentityOptions {
  sessionKey: string;
  source: string;
  channelId: string;
}

export type WorkerRunnerOptions = WorkerIdentityOptions &
  Pick<AgentLoopOptions, 'workorderAttemptId'> &
  Record<string, unknown>;

/** Minimal surface of AgentLoop.runWithContent that workerRun needs (DI seam).
 *  totalUsage is optional because the seam is structural: the real AgentLoopResult
 *  always carries it, but injected test runners and older adapters may not. */
export interface WorkerRunner {
  runWithContent(
    content: ContentBlock[],
    options: WorkerRunnerOptions
  ): Promise<{
    response: string;
    totalUsage?: { input_tokens: number; output_tokens: number };
    /** Host-side stop on the per-run token budget (agent-loop.ts). */
    stoppedBy?: 'budget';
    ownerJournalProvenance?: 'commit_failed';
  }>;
}

export interface WorkerRunOutput {
  response: string;
  /** SHA-256 prefix of the exact source brief before runtime projection. */
  briefHash: string;
  /** Carried through unchanged so the consumer can treat a budget stop as a retry. */
  stoppedBy?: 'budget';
  /** input+output tokens of the run; undefined when the runner reported no usage
   *  (never a fabricated 0 - absence must stay distinguishable from "free"). */
  tokensUsed?: number;
  /** The work completed, but bounded owner-runtime recovery did not persist. */
  ownerJournalProvenance?: 'commit_failed';
}

export interface WorkerRunInput {
  /** Worker kind (kebab-case, e.g. 'board', 'wiki', 'memory-curation'). */
  kind: string;
  /** Procedural brief (skill text) injected ahead of the work order. */
  brief: string;
  /** The work order payload the worker acts on. */
  input: string;
  /**
   * Extra run options (e.g. the per-run scoped envelope).
   * Applied BEFORE the identity fields - identity always wins (plan E7/G3:
   * an override must never move a worker onto another lane or reset another
   * lane's fresh-session pool).
   */
  runOptions?: Record<string, unknown>;
}

const KIND_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Env override for the worker-run per-request CLI timeout, in whole seconds. */
export const WORKER_TIMEOUT_ENV = 'MAMA_WORKER_TIMEOUT_SECONDS';

/**
 * Default worker request timeout: 600s. Worker gather runs (board/wiki briefs)
 * are long single model turns that overrun the 300s chat request bound - live
 * shadow evidence killed 8 of 31 orders mid-run at 300s ("CLI error: Request
 * timeout"). 600s is the plan's original per-kind number, un-dropped by that
 * evidence.
 */
export const DEFAULT_WORKER_TIMEOUT_SECONDS = 600;

/**
 * Resolve the worker-run per-request CLI timeout in ms. Unset/empty -> the
 * 600s default; any other value MUST be a positive integer number of seconds.
 * A malformed value throws (no silent fallback: a typo must not quietly revert
 * workers to the 300s bound this raise exists to lift).
 */
export function resolveWorkerRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[WORKER_TIMEOUT_ENV] ?? '').trim();
  if (raw === '') {
    return DEFAULT_WORKER_TIMEOUT_SECONDS * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `${WORKER_TIMEOUT_ENV} must be a positive integer number of seconds (or unset), got: '${raw}'`
    );
  }
  return seconds * 1000;
}

export function buildWorkerSessionKey(kind: string): string {
  if (!KIND_PATTERN.test(kind)) {
    throw new Error(`[worker-run] invalid worker kind "${kind}" (expected kebab-case)`);
  }
  return OWNER_RUNTIME_SESSION_KEY;
}

/** Attach a claimed system-row id after all caller-provided options. */
export function attachWorkOrderAttemptContext(
  runOptions: Record<string, unknown>,
  workorderAttemptId: number
): Record<string, unknown> & { workorderAttemptId: number } {
  if (!Number.isInteger(workorderAttemptId) || workorderAttemptId <= 0) {
    throw new Error('[worker-run] workorder attempt id must be a positive integer');
  }
  return { ...runOptions, workorderAttemptId };
}

/**
 * Submit a briefed maintenance stimulus to the standing owner runtime.
 * Throws loudly on invalid input, runner failure, or an empty response -
 * a worker never ends silently.
 */
export async function workerRun(
  runner: WorkerRunner,
  { kind, brief, input, runOptions }: WorkerRunInput
): Promise<WorkerRunOutput> {
  if (!KIND_PATTERN.test(kind)) {
    throw new Error(`[worker-run] invalid worker kind "${kind}" (expected kebab-case)`);
  }
  if (!brief.trim()) {
    throw new Error(`[worker-run] empty brief for worker kind "${kind}"`);
  }
  if (!input.trim()) {
    throw new Error(`[worker-run] empty input for worker kind "${kind}"`);
  }

  const {
    workOrderBriefProjectionPolicy: rawBriefProjectionPolicy,
    freshSession: _discardedFreshSession,
    systemPrompt: _discardedWorkerPersona,
    ...forwardedRunOptions
  } = runOptions ?? {};
  const briefProjectionPolicy = rawBriefProjectionPolicy as PrivateConnectorPolicy | undefined;
  // One brief for every kind: the private-connector projection is the guarantee that
  // matters here, and it no longer depends on which kind is running.
  let projectedBrief = briefProjectionPolicy
    ? projectConsoleBriefForPrompt(brief, briefProjectionPolicy)
    : brief;
  if (
    typeof forwardedRunOptions.systemPrompt === 'string' &&
    forwardedRunOptions.systemPrompt.includes('# Gateway Tools')
  ) {
    projectedBrief = stripMarkedPrivatePromptOverlays(projectedBrief);
  }
  const prompt = `${projectedBrief.trim()}\n\n---\n\nWork order:\n${input.trim()}`;

  const result = await runner.runWithContent([{ type: 'text', text: prompt }], {
    // Raised per-run CLI request timeout for long gather runs. Placed BEFORE
    // runOptions so an explicit caller override still wins; identity fields
    // below always win (plan E7/G3). Chat runs never route through workerRun,
    // so their request bound is untouched.
    requestTimeoutMs: resolveWorkerRequestTimeoutMs(),
    // runOptions: identity fields below always win (plan E7/G3).
    ...forwardedRunOptions,
    sessionKey: buildWorkerSessionKey(kind),
    source: 'operator',
    channelId: `worker:${kind}`,
    ownerJournalPrompt: `Maintenance ${kind}: ${input.trim()}`,
  });

  const response = result.response?.trim();
  if (!response) {
    throw new Error(`[worker-run] worker "${kind}" returned an empty response`);
  }
  const usage = result.totalUsage;
  const tokensUsed =
    usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
      ? usage.input_tokens + usage.output_tokens
      : undefined;
  const briefHash = createHash('sha256').update(brief).digest('hex').slice(0, 16);
  const stopped = result.stoppedBy === 'budget' ? { stoppedBy: 'budget' as const } : {};
  const journal =
    result.ownerJournalProvenance === 'commit_failed'
      ? { ownerJournalProvenance: 'commit_failed' as const }
      : {};
  return tokensUsed === undefined
    ? { response, briefHash, ...stopped, ...journal }
    : { response, tokensUsed, briefHash, ...stopped, ...journal };
}
