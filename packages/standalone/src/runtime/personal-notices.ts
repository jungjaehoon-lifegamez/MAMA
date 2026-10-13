import {
  appendJudgment,
  createPrincipalRepository,
  type DatabaseInstance,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { ChatSources } from '../storage/chat-sources.js';
import { deliverPersonalTurnResult } from './personal-turns.js';

/** Exact inputs to source.read and memory.read:record; no common-session text. */
export type NoticeRef = { observationRef: string; source?: string } | { memory_id: string };
export interface PersonalNoticePayload {
  refs: NoticeRef[];
  timeZone: string;
}
export function personalNoticePayload(row: MailboxRow): PersonalNoticePayload | null {
  if (row.kind !== 'scheduled' || row.channelKey !== 'notice') return null;
  const value = row.payload;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.timeZone !== 'string' ||
    !Array.isArray(value.refs) ||
    value.refs.length === 0 ||
    !value.refs.every(
      (ref) =>
        ref &&
        typeof ref === 'object' &&
        !Array.isArray(ref) &&
        (typeof ref.observationRef === 'string' || typeof ref.memory_id === 'string')
    )
  )
    throw new Error('Invalid personal notice input');
  return value as unknown as PersonalNoticePayload;
}
export const personalNoticeSessionKey = (row: MailboxRow) =>
  `member:${row.principalId}:notice:${row.stimulusId}`;

/** Personal close receipts follow the job close pattern and are exported/erased by P9. */
export function createPersonalNoticeStore(adapter: DatabaseInstance) {
  const commandId = (row: MailboxRow) => `notice-close:${row.stimulusId}`;
  const isClosed = (row: MailboxRow) =>
    // P9 retains uncertain native inputs until settlement; their earlier notice results must
    // never restore a DM or archive after the person's erasure.
    adapter
      .prepare('SELECT 1 FROM principal_erasure_receipts WHERE principal_id=? AND erased_at>=?')
      .get(row.principalId, row.createdAt) !== undefined ||
    adapter
      .prepare(
        `SELECT 1 FROM mailbox_inputs m WHERE stimulus_id=? AND principal_id=? AND status IN ('acked','dead')
      AND NOT EXISTS (SELECT 1 FROM native_input_deliveries n WHERE n.input_id=m.id AND n.state<>'settled')`
      )
      .get(row.stimulusId, row.principalId) !== undefined ||
    adapter
      .prepare(
        'SELECT 1 FROM command_bindings WHERE command_id=? AND principal_id=? AND erased_at IS NULL'
      )
      .get(commandId(row), row.principalId) !== undefined;
  return {
    isClosed,
    isActive: (id: string) => createPrincipalRepository(adapter).findById(id)?.status === 'active',
    isOffboarded: (id: string) =>
      createPrincipalRepository(adapter).findById(id)?.status === 'offboarded',
    close: async (row: MailboxRow) => {
      if (isClosed(row)) return;
      await appendJudgment(
        {
          commandId: commandId(row),
          topic: 'personal-notice/closed',
          recordKind: 'judgment',
          summary: 'Personal notice closed',
          payload: { type: 'personal-notice-close', noticeId: row.stimulusId },
          scopes: [{ kind: 'user', id: row.principalId }],
          record: { kind: 'fact', status: 'active' },
          agentId: 'host',
        },
        {
          principalId: row.principalId,
          agentId: 'host',
          scopes: [{ kind: 'user', id: row.principalId }],
          actions: [],
        },
        { adapter, embedder: null }
      );
    },
  };
}
export type PersonalNoticeStore = ReturnType<typeof createPersonalNoticeStore>;

export async function deliverPersonalNoticeResult(
  row: MailboxRow,
  result: NativeTurnResult,
  ports: {
    store: PersonalNoticeStore;
    chat: Pick<ChatSources, 'hasPersonalExchange' | 'savePersonalExchange'>;
    access(): JudgmentAccess;
    send(access: JudgmentAccess, text: string, key: string): Promise<boolean>;
    delivered(key: string): boolean;
  }
) {
  const payload = personalNoticePayload(row)!;
  const complete = () => ports.store.close(row);
  await deliverPersonalTurnResult(result, {
    ...ports,
    label: 'Personal notice',
    key: row.stimulusId,
    isClosed: () => ports.store.isClosed(row),
    isActive: () => ports.store.isActive(row.principalId),
    isOffboarded: () => ports.store.isOffboarded(row.principalId),
    assertCurrent: () => {},
    complete,
    completeIfCurrent: complete,
    hasExchange: () => ports.chat.hasPersonalExchange('notice', row.stimulusId),
    archive: (text) =>
      ports.chat.savePersonalExchange({
        kind: 'notice',
        ref: row.stimulusId,
        occurrenceAt: row.occurredAt,
        hostText: JSON.stringify(payload.refs),
        text,
        metadata: { refs: payload.refs, timeZone: payload.timeZone },
      }),
  });
}
