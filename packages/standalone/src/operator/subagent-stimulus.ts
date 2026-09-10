/**
 * Waking the standing owner when a native subagent finishes.
 *
 * The owner agent delegates long, bounded work to a native subagent and ends its
 * turn, so the owner conversation is never blocked behind maintenance. The child's
 * completion is therefore a HOST stimulus, delivered on the same one durable owner
 * subject as heartbeat and cron stimuli, and treated exactly like a background task
 * notification: the agent reads the result, verifies it, and decides what to do.
 *
 * The child's final text is text a model wrote outside this turn's authority. It is
 * wrapped as untrusted data - it is evidence to check, not an instruction to obey.
 */

import type { SubagentEvent } from '../multi-agent/runtime-process.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import { OWNER_RUNTIME_SESSION_KEY } from './owner-runtime.js';

export type { SubagentEvent } from '../multi-agent/runtime-process.js';

/** Upper bound on the quoted child result reaching the owner prompt. */
const MAX_RESULT_CHARS = 4000;

/**
 * The one sentence the host adds. It names the situation and the standing
 * obligation (verify, then carry the outcome) and stops there: choosing tools and
 * ordering the follow-up is the agent's judgment, not the host's script.
 */
const OWNER_OBLIGATION =
  'Read its result below (your runtime\'s own agent-result tools if you need more), verify what ' +
  'matters against the sources, and carry the outcome to the owner or the board as the original ' +
  'objective requires. Do not restate the result as your own work without checking it, and do not ' +
  'start another subagent for the same objective.';
const OWNER_SENTENCE = `A subagent you started has finished. ${OWNER_OBLIGATION}`;

/**
 * A child that failed, was interrupted, or whose completion was never confirmed must not
 * reach the owner wearing the success sentence. The status is named in the sentence.
 */
function ownerSentence(event: SubagentEvent): string {
  const status = event.status ?? 'unknown';
  return status === 'completed'
    ? OWNER_SENTENCE
    : `A subagent you started ended with status ${status}. ${OWNER_OBLIGATION}`;
}

/** Attribute values are host-visible identifiers; keep them from closing the tag. */
function attributeValue(raw: string): string {
  return raw.replace(/["<>]/g, '_');
}

function resultBody(event: SubagentEvent): string {
  const text = event.finalText ?? '';
  const error = event.error?.trim() ? event.error.slice(0, MAX_RESULT_CHARS) : '';
  const parts: string[] = [];
  if (text.trim().length > 0) {
    parts.push(
      text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text
    );
  }
  // Partial text never hides the failure: an error is reported alongside it, not instead.
  if (error) {
    parts.push(parts.length > 0 ? `error: ${error}` : `(no final answer) error: ${error}`);
  }
  if (parts.length === 0) {
    return '(no result text returned)';
  }
  return parts.join('\n');
}

/** Stable ref for dedupe and for the owner recovery journal. */
export function subagentStimulusSourceRef(event: SubagentEvent): string {
  return `subagent:${event.agentThreadId}`;
}

/**
 * The evidence block alone - what the recovery journal stores. The host sentence is
 * standing policy, not evidence, so it is not journalled.
 */
export function buildSubagentStimulusBlock(event: SubagentEvent): string {
  const header =
    `<subagent_completed path="${attributeValue(event.agentPath)}" ` +
    `thread="${attributeValue(event.agentThreadId)}" ` +
    `status="${attributeValue(event.status ?? 'unknown')}">`;
  return [
    header,
    wrapUntrustedContent(subagentStimulusSourceRef(event), resultBody(event)),
    '</subagent_completed>',
  ].join('\n');
}

/** The owner-turn text for a completed subagent event. */
export function buildSubagentStimulus(event: SubagentEvent): string {
  return `${buildSubagentStimulusBlock(event)}\n\n${ownerSentence(event)}`;
}

/** Only a finished child of the STANDING OWNER's own turn wakes the owner subject. */
export function shouldWakeOwner(event: SubagentEvent): boolean {
  return event.kind === 'completed' && event.sessionKey === OWNER_RUNTIME_SESSION_KEY;
}

interface SubagentEmitter {
  on(event: 'subagent', handler: (payload: SubagentEvent) => void): unknown;
  off?(event: 'subagent', handler: (payload: SubagentEvent) => void): unknown;
  removeListener?(event: 'subagent', handler: (payload: SubagentEvent) => void): unknown;
}

function asSubagentEmitter(runner: unknown): SubagentEmitter | null {
  if (!runner || typeof runner !== 'object') return null;
  const candidate = runner as Partial<SubagentEmitter>;
  return typeof candidate.on === 'function' ? (candidate as SubagentEmitter) : null;
}

const MAX_HANDLED_THREADS = 200;

/**
 * Subscribe an owner wake to a model runner's subagent events.
 *
 * Idempotent per child thread: a duplicate 'completed' event must not enqueue a
 * second owner turn. A runner that does not emit subagent events (Claude CLI,
 * test doubles) yields a no-op detach rather than a boot failure.
 */
export function attachSubagentWake(
  runner: unknown,
  wake: (event: SubagentEvent) => Promise<unknown>,
  log?: (line: string) => void
): () => void {
  const emitter = asSubagentEmitter(runner);
  if (!emitter) {
    return () => {};
  }
  const emit = log ?? ((line: string) => console.log(line));
  const handled = new Set<string>();

  const handler = (event: SubagentEvent): void => {
    if (!event || !shouldWakeOwner(event)) return;
    const ref = subagentStimulusSourceRef(event);
    if (handled.has(ref)) return;
    handled.add(ref);
    if (handled.size > MAX_HANDLED_THREADS) {
      const oldest = handled.values().next().value;
      if (oldest !== undefined) handled.delete(oldest);
    }
    emit(
      `[subagent] wake owner path=${event.agentPath} thread=${event.agentThreadId} ` +
        `status=${event.status ?? 'unknown'}`
    );
    void wake(event).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const line = `[subagent] wake failed thread=${event.agentThreadId}: ${message}`;
      if (log) log(line);
      else console.error(line);
      // A rejected wake delivered nothing, so the ref must leave the dedupe set: the
      // guarantee is "no duplicate owner turn", not "one attempt and the result is lost".
      handled.delete(ref);
    });
  };

  emitter.on('subagent', handler);
  return () => {
    if (typeof emitter.off === 'function') emitter.off('subagent', handler);
    else if (typeof emitter.removeListener === 'function')
      emitter.removeListener('subagent', handler);
  };
}
