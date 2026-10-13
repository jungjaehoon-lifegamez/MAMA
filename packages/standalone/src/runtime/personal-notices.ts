import {
  appendJudgment,
  createPrincipalRepository,
  type DatabaseInstance,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { ChatSources } from '../storage/chat-sources.js';
import { deliverPersonalTurnResult, PersonalTurnFinalFailure } from './personal-turns.js';

/** Exact inputs to source.read and memory.read:record; no common-session text. */
export type NoticeRef = { observationRef: string; source?: string } | { memory_id: string };
export interface PersonalNoticePayload {
  refs: NoticeRef[];
  timeZone: string;
  lifecycleVersion: number;
}
export function personalNoticePayload(row: MailboxRow): PersonalNoticePayload | null {
  if (row.kind !== 'scheduled' || row.channelKey !== 'notice') return null;
  const value = row.payload;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.timeZone !== 'string' ||
    !Number.isSafeInteger(value.lifecycleVersion) ||
    Number(value.lifecycleVersion) < 0 ||
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
  const principals = () => createPrincipalRepository(adapter);
  const access = (row: MailboxRow): JudgmentAccess => ({
    principalId: row.principalId,
    agentId: 'host',
    scopes: [{ kind: 'user', id: row.principalId }],
    actions: [],
  });
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
    isActive: (id: string) => principals().findById(id)?.status === 'active',
    isOffboarded: (id: string) => principals().findById(id)?.status === 'offboarded',
    isCurrent: (row: MailboxRow) =>
      principals().findById(row.principalId)?.status === 'active' &&
      principals().lifecycleVersion(row.principalId) ===
        personalNoticePayload(row)!.lifecycleVersion,
    // Retain exactly what this native input was given, including pre-turn access filtering.
    // A later reconciliation must not substitute the enqueue candidates for the turn's refs.
    prepare: async (row: MailboxRow, refs: NoticeRef[]) => {
      const nativeInputId = row.nativeDelivery?.invocationId;
      if (!nativeInputId) throw new Error('Personal notice has no native input identity');
      await appendJudgment(
        {
          commandId: `notice-input:${nativeInputId}:${row.attempts}`,
          topic: 'personal-notice/input',
          recordKind: 'judgment',
          summary: 'Personal notice input refs',
          payload: { type: 'personal-notice-input', nativeInputId, refs },
          scopes: [...access(row).scopes],
          record: { kind: 'fact', status: 'stale' },
          agentId: 'host',
        },
        access(row),
        { adapter, embedder: null }
      );
    },
    turnRefs: (row: MailboxRow): NoticeRef[] => {
      const record = adapter
        .prepare(
          `SELECT d.payload_json FROM decisions d JOIN command_bindings b ON b.receipt_key=d.id
          WHERE b.principal_id=? AND b.erased_at IS NULL AND d.erased_at IS NULL
          AND json_extract(d.payload_json, '$.type')='personal-notice-input'
          AND json_extract(d.payload_json, '$.nativeInputId')=? ORDER BY d.rowid DESC LIMIT 1`
        )
        .get(row.principalId, row.nativeDelivery?.invocationId) as
        | { payload_json: string }
        | undefined;
      if (!record) throw new Error('Personal notice native input refs are missing');
      return (JSON.parse(record.payload_json) as { refs: NoticeRef[] }).refs;
    },
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
          record: { kind: 'fact', status: 'stale' },
          agentId: 'host',
        },
        access(row),
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
    read(ref: NoticeRef, access: JudgmentAccess): Promise<boolean>;
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
    assertCurrent: async () => {
      if (!ports.store.isCurrent(row))
        throw new PersonalTurnFinalFailure('Personal notice person lifecycle changed');
      const access = ports.access();
      for (const ref of ports.store.turnRefs(row))
        if (!(await ports.read(ref, access)))
          throw new PersonalTurnFinalFailure('Personal notice ref is no longer readable');
      if (!ports.store.isCurrent(row))
        throw new PersonalTurnFinalFailure('Personal notice person lifecycle changed');
    },
    complete,
    completeIfCurrent: complete,
    hasExchange: () => ports.chat.hasPersonalExchange('notice', row.stimulusId),
    archive: (text) =>
      ports.chat.savePersonalExchange({
        kind: 'notice',
        ref: row.stimulusId,
        occurrenceAt: row.occurredAt,
        hostText: JSON.stringify(ports.store.turnRefs(row)),
        text,
        metadata: { refs: ports.store.turnRefs(row), timeZone: payload.timeZone },
      }),
  });
}
