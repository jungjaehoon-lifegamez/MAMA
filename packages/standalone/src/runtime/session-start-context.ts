/**
 * What a new owner session is told, gathered as Kagemusha's `agent-session.ts` does: the owner
 * channel's last ten messages, the last ten turns a session resumes from, and the latest decisions.
 * Owner exchanges count only once the transport delivered them.
 */
import type { MemoryRecord } from '@jungjaehoon/mama-core';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type { Mailbox, MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { SessionStartExchange, SessionStartInput } from './turn-orders.js';

const RECENT = 10;

/** The reply as text: messenger markup spends the 360-char line budget without adding meaning. */
function answerFor(mailbox: Mailbox, row: MailboxRow): string | null {
  const receipt = row.nativeDelivery?.receipt;
  if (!receipt) return null;
  const response = mailbox.nativeInputs.resultForReceipt(receipt, row.principalId)?.response;
  return response === undefined ? null : response.replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

function ownerText(row: MailboxRow): string | null {
  const payload = row.payload;
  return payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    typeof payload.text === 'string'
    ? payload.text
    : null;
}

/**
 * How long the mailbox keeps an acknowledged owner message (mama-core prunes acked rows after
 * seven days); owner.messages says so when asked for older days.
 */
export const OWNER_MESSAGE_RETENTION_MS = 7 * 86_400_000;

/** The owner's messages in [since, before), oldest first, each with its delivered reply. */
export function ownerExchangesBetween(
  mailbox: Mailbox,
  adapter: DatabaseAdapter,
  principalId: string,
  since: number,
  before: number
): Array<{ at: number; owner: string; reply: string | null }> {
  const refs = adapter
    .prepare(
      `SELECT stimulus_id FROM mailbox_inputs
        WHERE principal_id = ? AND kind = 'owner_message' AND occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at, id`
    )
    .all(principalId, since, before) as Array<{ stimulus_id: string }>;
  return refs.flatMap(({ stimulus_id: ref }) => {
    const row = mailbox.readInput(ref, principalId);
    const owner = row === null ? null : ownerText(row);
    return row === null || owner === null
      ? []
      : [{ at: row.occurredAt, owner, reply: answerFor(mailbox, row) }];
  });
}

/**
 * The owner channel's last ten exchanges, oldest first: the owner's message and the reply the
 * transport delivered. Source changes are not carried; the ledger and the sources hold them.
 */
function ownerExchanges(
  mailbox: Mailbox,
  deliveredRefs: readonly string[],
  current: MailboxRow
): SessionStartExchange[] {
  return deliveredRefs
    .slice(0, RECENT * 2)
    .map((ref) => mailbox.readInput(ref, current.principalId))
    .filter(
      (row): row is MailboxRow =>
        row !== null && row.kind === 'owner_message' && row.stimulusId !== current.stimulusId
    )
    .sort((a, b) => b.occurredAt - a.occurredAt || b.id - a.id)
    .flatMap((row) => {
      const owner = ownerText(row);
      const answer = answerFor(mailbox, row);
      return owner === null || answer === null ? [] : [{ at: row.occurredAt, owner, answer }];
    })
    .slice(0, RECENT)
    .reverse();
}

export async function readSessionStartInput(ports: {
  mailbox: Mailbox;
  deliveredRefs: readonly string[];
  current: MailboxRow;
  /** The owner's active memory records, in any order. */
  records: () => Promise<readonly MemoryRecord[]>;
  /** The latest session checkpoint the agent saved, if any; `createdAt` in epoch ms. */
  checkpoint: () => Promise<{ summary: string; nextSteps: string; createdAt: number } | null>;
  now: number;
}): Promise<SessionStartInput> {
  const records = [...(await ports.records())];
  const checkpoint = await ports.checkpoint();
  const createdAt = (value: number | string): number =>
    typeof value === 'number' ? value : Date.parse(value);
  return {
    exchanges: ownerExchanges(ports.mailbox, ports.deliveredRefs, ports.current),
    decisions: records
      .sort((a, b) => createdAt(b.created_at) - createdAt(a.created_at))
      .slice(0, RECENT)
      .map((record) => ({
        topic: record.topic,
        summary: record.summary,
        ageHours: (ports.now - createdAt(record.created_at)) / 3_600_000,
      })),
    checkpoint:
      checkpoint === null
        ? null
        : {
            summary: checkpoint.summary,
            nextSteps: checkpoint.nextSteps,
            ageHours: (ports.now - checkpoint.createdAt) / 3_600_000,
          },
  };
}
