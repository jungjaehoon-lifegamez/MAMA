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

import type { ContentBlock } from '../agent/types.js';

/** Minimal surface of AgentLoop.runWithContent that workerRun needs (DI seam). */
export interface WorkerRunner {
  runWithContent(
    content: ContentBlock[],
    options: {
      sessionKey: string;
      source: string;
      channelId: string;
      freshSession: boolean;
    }
  ): Promise<{ response: string }>;
}

export interface WorkerRunInput {
  /** Worker kind (kebab-case, e.g. 'board', 'wiki', 'memory-curation'). */
  kind: string;
  /** Procedural brief (skill text) injected ahead of the work order. */
  brief: string;
  /** The work order payload the worker acts on. */
  input: string;
}

const KIND_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function buildWorkerSessionKey(kind: string): string {
  return `operator:worker:${kind}`;
}

/**
 * Run a briefed worker on its own operator lane and return its output.
 * Throws loudly on invalid input, runner failure, or an empty response -
 * a worker never ends silently.
 */
export async function workerRun(
  runner: WorkerRunner,
  { kind, brief, input }: WorkerRunInput
): Promise<string> {
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
  return response;
}
