/**
 * The turn contract.
 *
 * Router-neutral on purpose. This module imports nothing from the message router, so a
 * user-facing surface can depend on how a turn is served without depending on WHAT
 * serves it. Keeping the contract next to its current implementation would leave the
 * coupling in place while looking inverted - a surface would still reach a concrete
 * router through its own base class.
 *
 * A surface owns receive, normalization, progress display, delivery and its restart
 * ledger. Everything inward of `processTurn` - session locks, durable persistence,
 * prompt assembly, the model run - belongs to the implementation.
 *
 * Connectors do not pass through here. They are data the agent reads, never a turn.
 */
import type { NormalizedMessage, RelatedDecision } from './types.js';
import type { StreamCallbacks } from '../agent/types.js';

/** Options a caller may pass alongside a turn. */
export interface ProcessOptions {
  /** Called immediately if the session is busy and the turn was queued. */
  onQueued?: () => void;
  onStream?: StreamCallbacks;
}

/** Fields every turn outcome carries, whatever happened. */
export interface TurnOutcomeBase {
  /** Response text from the agent. */
  response: string;
  /** Session the turn ran in. */
  sessionId: string;
  /** Related decisions that were injected. */
  injectedDecisions: RelatedDecision[];
  /** Processing duration in milliseconds. */
  duration: number;
}

/**
 * A turn that reached the model. It may still carry no durable run handle - see below.
 *
 * Run identity lives on this branch rather than as optional fields on one flat shape,
 * because a turn can end WITHOUT reaching the model. With optional fields a caller
 * cannot tell "no id recorded" from "no run happened", and anything that later traces a
 * delivered claim back to its evidence rests on exactly that distinction.
 */
export interface CompletedTurn extends TurnOutcomeBase {
  outcome: 'completed';
  /**
   * Durable model-run handle, or null when this turn has none.
   *
   * Required and nullable rather than optional: absent and null would otherwise mean the
   * same thing to a reader, and they are different questions - "was the field set" versus
   * "does a resolvable run exist". Null is returned honestly when the backend reported no
   * run, or when its record could not be committed; the answer still stands, the handle
   * does not.
   */
  modelRunId: string | null;
  /** Stable id for this inbound turn. */
  sourceTurnId: string;
  /** Canonical reference to the message that started it. */
  sourceMessageRef: string;
}

/** A turn answered without a model run - the caller must not look for run identity. */
export interface BlockedTurn extends TurnOutcomeBase {
  outcome: 'blocked';
  /** Why no model run exists. */
  reason: 'security_block';
}

/** Discriminated on `outcome`; both branches keep the base fields. */
export type ProcessingResult = CompletedTurn | BlockedTurn;

/**
 * The one callable boundary between a user-facing surface and turn processing.
 *
 * Session ownership belongs to the implementation, and the shape says so: nothing about
 * a session appears in the input, so a caller cannot hand one in, and the id it gets
 * back is the one the implementation chose. Durable conversation state, the backend
 * resume decision and the per-channel lock are held together; splitting any of them
 * across this boundary would leave one lock with two owners.
 *
 * Known exception, stated rather than discovered later: scheduled operator reports do
 * not pass through here. They run their own lane against a forced fresh session, so two
 * session models exist today.
 */
export interface TurnProcessor {
  processTurn(message: NormalizedMessage, options?: ProcessOptions): Promise<ProcessingResult>;
}

/**
 * Session data a surface may read for its own DISPLAY concerns - naming a channel,
 * listing what is active. Deliberately separate from `TurnProcessor`: reading session
 * data to render something is not turn ownership, and a surface that needs it should
 * have to ask for it by name rather than receive a whole router.
 */
export interface SessionDirectory {
  listSessions(
    source: string
  ): ReadonlyArray<{ readonly channelId: string; readonly channelName?: string | null }>;
  updateChannelName(source: string, channelId: string, channelName: string): boolean;
}
