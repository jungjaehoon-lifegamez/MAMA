/**
 * workerRun - the operator's worker primitive (plan: owner-console v6 S0-T1).
 *
 * A worker is NOT a standing agent identity and NOT a delegate/native-Task
 * subagent: it is a briefed, FRESH-session lane run - the same substrate the
 * report lane already uses (LaneManager serialization, loud failure, result
 * returned to the caller, gateway calls audited).
 *
 * CALLER CONTRACT (deadlock seal):
 * - Callers must be HOST CODE running OUTSIDE any lane (scheduler ticks,
 *   work-order consumers, forwarder hooks).
 * - NEVER call workerRun from inside an active lane run (an LLM run's tool
 *   handler, a report run, another worker): the parent holds its global lane
 *   slot for its whole duration, so a nested awaited lane run can queue
 *   behind its own parent forever.
 *
 * Concurrency: same-kind runs serialize on the `operator:worker:<kind>`
 * session lane; ALL operator work (reports + workers) serializes on the
 * 'operator' global lane, which is separate from chat 'main' so long worker
 * runs never block owner replies.
 */

import type { AgentLoopOptions, ContentBlock } from '../agent/types.js';
import type { BackendType } from '../agent/model-runner.js';
import type { WorkOrderKind } from './task-ledger.js';
import { UNTRUSTED_EXTERNAL_EVIDENCE_INSTRUCTION } from '../utils/untrusted-content.js';

/** Identity fields workerRun owns - never overridable by callers (plan E7/G3). */
export interface WorkerIdentityOptions {
  sessionKey: string;
  source: string;
  channelId: string;
  freshSession: boolean;
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
  }>;
}

export interface WorkerRunOutput {
  response: string;
  /** input+output tokens of the run; undefined when the runner reported no usage
   *  (never a fabricated 0 - absence must stay distinguishable from "free"). */
  tokensUsed?: number;
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

/**
 * Worker-specific system prompt (shadow-gate finding §8.2): the spawn-default
 * persona prompt carries code-act sandbox instructions, so worker tool calls
 * went through POST /api/code-act - a server-side surface the per-run
 * execution-context seam (envelope, capture override) cannot reach. A custom
 * systemPrompt REPLACES the persona layers entirely (agent-loop.ts:484-486),
 * so Claude workers advertise only the text-gateway syntax while Codex workers
 * use the injected native host tools. Both routes reach the same in-process
 * gateway executor where the per-run seam works.
 */
export function buildWorkerSystemPrompt(
  gatewayToolsPrompt: string,
  backend: BackendType = 'claude',
  kind?: WorkOrderKind
): string {
  const toolInstructions =
    backend === 'codex'
      ? [
          'Follow the brief in the user message. Use the injected native host tools directly.',
          'Call them through the model tool interface; never emit Markdown or JavaScript substitutes.',
        ]
      : [
          'Follow the brief in the user message. Call tools ONLY via the tool_call JSON',
          'blocks documented below - no other execution mechanism exists in this session.',
        ];
  return [
    'You are a MAMA OS system worker. You execute exactly ONE work order and stop.',
    ...toolInstructions,
    UNTRUSTED_EXTERNAL_EVIDENCE_INSTRUCTION,
    ...(kind === 'board'
      ? [
          '',
          'Board data boundaries (non-negotiable):',
          "- Trello is external connector evidence and is available only through context_compile. When intentionally isolating Trello, use context_compile({ task: '...', connectors: ['trello'] }); never treat kagemusha_* as Trello.",
          '- kagemusha_* is the read-only project-task truth.',
          '- task_list/task_create/task_update is the native owner-task ledger and the pipeline projection source.',
          '- Never infer or copy lifecycle status across those stores.',
          '- Never copy Trello or Kagemusha lifecycle status into the native ledger.',
          '- Temporal fact: use task_list.temporal_state as the canonical time category and render it separately.',
          '- Workflow judgment: preserve the source-of-truth lifecycle status; overdue does not mean blocked.',
          '- System condition: reconciliation retrying or authority unavailable is not task lifecycle state.',
          '- Set due_at only from trusted, unambiguous time and time zone evidence; otherwise retain date-only precision.',
          '- Never infer completion from calendar disappearance.',
        ]
      : []),
    'Do not ask questions; finish with the exact final line your brief specifies.',
    ...(backend === 'claude' ? ['', gatewayToolsPrompt.trim()] : []),
  ].join('\n');
}

export function buildWorkerSessionKey(kind: string): string {
  return `operator:worker:${kind}`;
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
 * Run a briefed worker on its own operator lane and return its output.
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

  const prompt = `${brief.trim()}\n\n---\n\nWork order:\n${input.trim()}`;

  const result = await runner.runWithContent([{ type: 'text', text: prompt }], {
    // Raised per-run CLI request timeout for long gather runs. Placed BEFORE
    // runOptions so an explicit caller override still wins; identity fields
    // below always win (plan E7/G3). Chat runs never route through workerRun,
    // so their request bound is untouched.
    requestTimeoutMs: resolveWorkerRequestTimeoutMs(),
    // runOptions: identity fields below always win (plan E7/G3).
    ...(runOptions ?? {}),
    sessionKey: buildWorkerSessionKey(kind),
    // freshSession pool reset keys on source+channelId (agent-loop.ts) -
    // both MUST be explicit per call or another lane's pool entry gets reset.
    source: 'operator',
    channelId: `worker:${kind}`,
    // Workers are stateless: continuity lives in the brief + artifacts,
    // never in session accumulation (owner principle: session = cache).
    freshSession: true,
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
  return tokensUsed === undefined ? { response } : { response, tokensUsed };
}
