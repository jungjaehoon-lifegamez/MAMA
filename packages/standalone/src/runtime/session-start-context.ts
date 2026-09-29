/**
 * What a new owner session is told, gathered as Kagemusha's `agent-session.ts` does: the owner
 * channel's last ten messages, the last ten turns a session resumes from, and the latest decisions.
 * Owner exchanges count only once the transport delivered them.
 */
import type { DatabaseInstance, MemoryRecord } from '@jungjaehoon/mama-core';
import type { Mailbox, MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import { deltaLines, type SessionStartInput } from './turn-orders.js';

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

/** The owner channel's last ten messages, oldest first. */
function ownerMessages(
  mailbox: Mailbox,
  deliveredRefs: readonly string[],
  current: MailboxRow
): string[] {
  return deliveredRefs
    .slice(0, 20)
    .map((ref) => mailbox.readInput(ref, current.principalId))
    .filter(
      (row): row is MailboxRow =>
        row !== null && row.kind === 'owner_message' && row.stimulusId !== current.stimulusId
    )
    .sort((a, b) => b.occurredAt - a.occurredAt || b.id - a.id)
    .flatMap((row) => {
      const text = ownerText(row);
      const answer = answerFor(mailbox, row);
      return text === null || answer === null ? [] : [[`[agent] ${answer}`, `[owner] ${text}`]];
    })
    .flat()
    .slice(0, RECENT)
    .reverse();
}

/**
 * The last ten turns a session resumes from, oldest first: owner turns and live delta turns with
 * their replies. Record orders, reports and replay windows are left out, as Kagemusha leaves out its
 * reconcile and system turns.
 */
function resumableTurns(
  adapter: DatabaseInstance,
  mailbox: Mailbox,
  current: MailboxRow
): string[] {
  const rows = (
    adapter
      .prepare(
        `SELECT stimulus_id FROM mailbox_inputs
          WHERE principal_id = ? AND kind IN ('owner_message', 'source_delta') AND status = 'acked'
            AND stimulus_id != ?
          ORDER BY id DESC LIMIT ?`
      )
      .all(current.principalId, current.stimulusId, RECENT * 2) as Array<{ stimulus_id: string }>
  )
    .map(({ stimulus_id }) => mailbox.readInput(stimulus_id, current.principalId))
    .filter((row): row is MailboxRow => row !== null);
  const entries: string[] = [];
  for (const row of rows) {
    const answer = answerFor(mailbox, row);
    if (answer === null) continue;
    if (row.kind === 'owner_message') {
      const text = ownerText(row);
      if (text !== null) entries.push(`[agent] ${answer}`, `[owner] ${text}`);
      continue;
    }
    const payload = row.payload;
    // A replay window is a batch rebuild, not a live change, even though its refs carry text.
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      payload.replay !== undefined
    )
      continue;
    const lines = deltaLines(payload);
    if (lines.length === 0) continue;
    const channel = `delta ${lines[0]!.channel || row.channelKey}`;
    entries.push(
      `[${channel}][agent] ${answer}`,
      `[${channel}][source] ${lines.map((line) => `${line.author}: ${line.text}`).join(' / ')}`
    );
  }
  return entries.slice(0, RECENT).reverse();
}

export async function readSessionStartInput(ports: {
  adapter: DatabaseInstance;
  mailbox: Mailbox;
  deliveredRefs: readonly string[];
  current: MailboxRow;
  /** The owner's active memory records, in any order. */
  records: () => Promise<readonly MemoryRecord[]>;
  now: number;
}): Promise<SessionStartInput> {
  const records = [...(await ports.records())];
  const createdAt = (value: number | string): number =>
    typeof value === 'number' ? value : Date.parse(value);
  return {
    ownerMessages: ownerMessages(ports.mailbox, ports.deliveredRefs, ports.current),
    turns: resumableTurns(ports.adapter, ports.mailbox, ports.current),
    decisions: records
      .sort((a, b) => createdAt(b.created_at) - createdAt(a.created_at))
      .slice(0, RECENT)
      .map((record) => ({
        topic: record.topic,
        summary: record.summary,
        ageHours: (ports.now - createdAt(record.created_at)) / 3_600_000,
      })),
  };
}
