import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeTurnResultRecord } from '@jungjaehoon/mama-core/runtime/native-input-journal';
import type { MessageSource, NormalizedMessage } from './types.js';

/** The narrow producer contract used by a gateway: accept, do not run a model. */
export interface OwnerMessageInput {
  /** Stable provider-qualified source message reference used as the mailbox stimulus identity. */
  id: string;
  channelKey: string;
  occurredAt: number;
  text: string;
  replyTo?: string | null;
  payload?: JsonValue;
}

export interface TurnIntake {
  acceptOwnerMessage(input: OwnerMessageInput): StimulusReceipt;
  recordOwnerReply(input: OwnerReplyInput): void;
  isPending?(sourceMessageRef: string): boolean;
}

export interface OwnerReplyInput {
  messageRef: string;
  text: string;
  occurredAt: number;
  author: 'agent' | 'host';
  deliveryVerified: boolean;
}

/** Conversation history supplied by the host, without admitting an owner model turn. */
export interface OwnerHostExchangeInput {
  message: OwnerMessageInput;
  reply: Pick<OwnerReplyInput, 'text' | 'occurredAt' | 'deliveryVerified'>;
}

export interface TurnOutcomeBase {
  response: string;
  sessionId: string;
  duration: number;
}

export type TurnProvenance =
  | { status: 'available'; modelRunId: string }
  | { status: 'unavailable'; reason: 'backend_no_run' | 'commit_failed' };

export interface CompletedTurn extends TurnOutcomeBase {
  outcome: 'completed';
  provenance: TurnProvenance;
  sourceTurnId: string;
  sourceMessageRef: string;
}

export interface SharedReplyTurn extends TurnOutcomeBase {
  outcome: 'shared_reply';
  response: '';
  sourceTurnId: string;
  sourceMessageRef: string;
  replySourceMessageRef: string;
}

export type ProcessingResult = CompletedTurn | SharedReplyTurn;

export interface SessionDirectory {
  listSessions(
    source: MessageSource
  ): ReadonlyArray<{ readonly channelId: string; readonly channelName?: string | null }>;
  updateChannelName(source: MessageSource, channelId: string, channelName: string): boolean;
}

/** Kept as the neutral name used by gateway consumers. */
export type TurnProcessor = TurnIntake;

export type { NativeTurnResultRecord, NormalizedMessage };
