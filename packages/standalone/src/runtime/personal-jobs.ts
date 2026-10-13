import { randomUUID } from 'node:crypto';
import {
  appendJudgment,
  retireMemoryRecord,
  createPrincipalRepository,
  JudgmentError,
  type DatabaseInstance,
  type JudgmentAccess,
  type ActionContext,
} from '@jungjaehoon/mama-core';
import { canonicalizeJSON } from '@jungjaehoon/mama-core/canonicalize';
import type { Mailbox, MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { StimulusIntake } from './stimulus-delivery.js';
import type { ChatSources } from '../storage/chat-sources.js';
import { cronOccurrences, latestCronOccurrence, validateJobCron } from './personal-job-cron.js';
import { localNow, validateTimeZone, type TimeZoneSetting } from './timezone.js';
import { invalidInput } from '../utils/invalid-input.js';
import { isDefinitiveTelegramRejection } from '../gateways/telegram-errors.js';

export interface PersonalJob {
  jobId: string;
  cron: string;
  timeZone: string;
  instruction: string;
  enabled: boolean;
  createdAt: number;
  scheduleFrom: number;
  version: string;
  lastCompletedAt: number | null;
  lastClosedAt: number | null;
}
export interface StoredPersonalJob extends PersonalJob {
  recordId: string;
}
export const personalJobSessionKey = (principalId: string, jobId: string) =>
  `member:${principalId}:job:${jobId}`;
export const personalJobOccurrenceId = (jobId: string, at: number) => `job:${jobId}:${at}`;
export function personalJobPayload(
  row: MailboxRow
): { jobId: string; version: string; instruction: string; timeZone: string } | null {
  if (row.kind !== 'scheduled' || !row.channelKey.startsWith('job:')) return null;
  const value = row.payload;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.jobId !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.instruction !== 'string' ||
    typeof value.timeZone !== 'string' ||
    row.channelKey !== `job:${value.jobId}`
  )
    throw new Error('Invalid personal job input');
  return value as { jobId: string; version: string; instruction: string; timeZone: string };
}

/** Host-owned scheduling records use the same sole personal binding as P9 records. */
export function createPersonalJobStore(adapter: DatabaseInstance, timeZone: TimeZoneSetting) {
  const list = (principalId: string): StoredPersonalJob[] => {
    const rows = adapter
      .prepare(
        `SELECT d.id, d.payload_json FROM decisions d
      JOIN memory_scope_bindings b ON b.memory_id=d.id
      JOIN memory_scopes s ON s.id=b.scope_id
      WHERE d.status='active' AND json_extract(d.payload_json, '$.type')='personal-job'
        AND s.kind='user' AND s.external_id=?
        AND NOT EXISTS (SELECT 1 FROM memory_scope_bindings other WHERE other.memory_id=d.id AND other.scope_id<>b.scope_id)
      ORDER BY d.created_at, d.rowid`
      )
      .all(principalId) as Array<{ id: string; payload_json: string }>;
    return rows.map((row) => {
      const { type: _type, operation: _operation, ...job } = JSON.parse(row.payload_json);
      return { ...(job as PersonalJob), recordId: row.id };
    });
  };
  const find = (principalId: string, id: string) =>
    list(principalId).find((job) => job.jobId === id);
  const personalAccess = (access: JudgmentAccess): JudgmentAccess => ({
    ...access,
    scopes: [{ kind: 'user', id: access.principalId }],
    defaultScopes: [{ kind: 'user', id: access.principalId }],
    readScopes: [],
  });
  const write = async (
    job: PersonalJob,
    access: JudgmentAccess,
    commandId: string,
    previous?: StoredPersonalJob,
    context?: ActionContext,
    operation?: { action: string; input: JsonValue; result: JsonValue }
  ) => {
    const { recordId: _recordId, ...payload } = job as StoredPersonalJob;
    const receipt = await appendJudgment(
      {
        commandId,
        topic: `personal-job/${job.jobId}`,
        recordKind: 'judgment',
        summary: job.instruction,
        payload: {
          type: 'personal-job',
          ...payload,
          ...(operation ? { operation } : {}),
        } as Record<string, JsonValue>,
        scopes: [{ kind: 'user', id: access.principalId }],
        ...(previous
          ? { replaces: [{ id: previous.recordId, reason: 'Personal job revision' }] }
          : {}),
        record: { kind: 'fact', status: 'active' },
        provenance: {
          tool_name: context?.session?.toolName ?? 'schedule.job',
          source_message_ref: context?.session?.sourceMessageRef ?? null,
        },
        agentId: context ? access.agentId : 'host',
      },
      personalAccess(access),
      { adapter, embedder: null }
    );
    return { ...job, recordId: receipt.recordId };
  };
  const validate = (job: PersonalJob, principalId: string, except?: string) => {
    validateTimeZone(job.timeZone);
    validateJobCron(job.cron, job.timeZone, Date.now());
    if (!job.instruction.trim()) throw invalidInput('A personal job requires an instruction');
    if (
      job.enabled &&
      list(principalId).filter((current) => current.enabled && current.jobId !== except).length >=
        10
    )
      throw invalidInput('A person may have at most ten active jobs');
  };
  const view = (job: PersonalJob) => ({
    id: job.jobId,
    cron: job.cron,
    timeZone: job.timeZone,
    instruction: job.instruction,
    enabled: job.enabled,
    nextOccurrence: job.enabled
      ? `${localNow(cronOccurrences(job.cron, job.timeZone, Date.now(), 1)[0]!, job.timeZone)} ${job.timeZone}`
      : null,
    lastCompletedOccurrence:
      job.lastCompletedAt === null
        ? null
        : `${localNow(job.lastCompletedAt, job.timeZone)} ${job.timeZone}`,
  });
  // Like work.link, recover the committed statement before reading mutable heads. The
  // principal-bound command receipt selects the immutable revision, including its first reply.
  const replay = <T>(context: ActionContext, action: string, input: unknown): T | null => {
    const binding = adapter
      .prepare(
        'SELECT principal_id, action, receipt_key, erased_at FROM command_bindings WHERE command_id=?'
      )
      .get(context.operationId!) as
      | { principal_id: string; action: string; receipt_key: string; erased_at: number | null }
      | undefined;
    if (!binding) return null;
    if (binding.erased_at !== null)
      throw new JudgmentError('COMMAND_ERASED', 'The command belongs to an erased record');
    const conflict = () => {
      throw new JudgmentError(
        'COMMAND_CONFLICT',
        'The command id is already bound to another request'
      );
    };
    if (binding.principal_id !== context.access.principalId || binding.action !== 'judgment.append')
      conflict();
    const record = adapter
      .prepare('SELECT payload_json FROM decisions WHERE id=?')
      .get(binding.receipt_key) as { payload_json: string };
    const payload = JSON.parse(record.payload_json);
    if (action === 'delete') {
      if (
        typeof payload.amended !== 'string' ||
        payload.status !== 'stale' ||
        payload.reason !== 'The person deleted this job'
      )
        conflict();
      const target = adapter
        .prepare(
          "SELECT json_extract(payload_json, '$.jobId') AS id FROM decisions WHERE id=? AND json_extract(payload_json, '$.type')='personal-job'"
        )
        .get(payload.amended) as { id: string } | undefined;
      if (!target || canonicalizeJSON(input) !== canonicalizeJSON({ id: target.id })) conflict();
      return { id: target!.id, deleted: true } as T;
    }
    if (
      payload.type !== 'personal-job' ||
      payload.operation?.action !== action ||
      canonicalizeJSON(payload.operation.input) !== canonicalizeJSON(input)
    )
      conflict();
    return payload.operation.result as T;
  };
  const hostAccess = (principalId: string): JudgmentAccess => ({
    principalId,
    agentId: 'host',
    scopes: [{ kind: 'user', id: principalId }],
    actions: [],
  });
  const isClosed = (row: MailboxRow) =>
    adapter
      .prepare(
        'SELECT 1 FROM command_bindings WHERE command_id=? AND principal_id=? AND erased_at IS NULL'
      )
      .get(`job-close:${row.principalId}:${row.stimulusId}`, row.principalId) !== undefined;
  const isSuperseded = (row: MailboxRow) => {
    const payload = personalJobPayload(row)!;
    const job = find(row.principalId, payload.jobId);
    return job?.version === payload.version && (job.lastClosedAt ?? 0) > row.occurredAt;
  };
  const finish = async (
    row: MailboxRow,
    completed: boolean,
    access = hostAccess(row.principalId)
  ) => {
    const payload = personalJobPayload(row)!;
    const job = find(row.principalId, payload.jobId);
    if (!job || job.version !== payload.version || isClosed(row)) return;
    await write(
      {
        ...job,
        lastClosedAt: Math.max(job.lastClosedAt ?? 0, row.occurredAt),
        ...(completed && (job.lastClosedAt ?? 0) < row.occurredAt
          ? { lastCompletedAt: row.occurredAt }
          : {}),
      },
      access,
      `job-close:${row.principalId}:${row.stimulusId}`,
      job
    );
  };
  return {
    list,
    find,
    view,
    isClosed,
    isSuperseded,
    isActive: (principalId: string) =>
      createPrincipalRepository(adapter).findById(principalId)?.status === 'active',
    close: (row: MailboxRow) => finish(row, false),
    resume: async (principalId: string, now: number) => {
      for (const job of list(principalId))
        await write(
          { ...job, scheduleFrom: now, version: randomUUID() },
          hostAccess(principalId),
          `job-resume:${principalId}:${job.recordId}:${now}`,
          job
        );
    },
    create: async (
      body: { cron: string; timeZone?: string; instruction: string },
      context: ActionContext
    ) => {
      const committed = replay<ReturnType<typeof view>>(context, 'create', body);
      if (committed) return committed;
      const now = Date.now();
      const job: PersonalJob = {
        jobId: randomUUID(),
        cron: body.cron.trim(),
        timeZone: body.timeZone ?? timeZone.get(),
        instruction: body.instruction.trim(),
        enabled: true,
        createdAt: now,
        scheduleFrom: now,
        version: randomUUID(),
        lastCompletedAt: null,
        lastClosedAt: null,
      };
      validate(job, context.access.principalId);
      const result = view(job);
      await write(job, context.access, context.operationId!, undefined, context, {
        action: 'create',
        input: body,
        result,
      });
      return result;
    },
    update: async (
      body: {
        id: string;
        cron?: string;
        timeZone?: string;
        instruction?: string;
        enabled?: boolean;
      },
      context: ActionContext
    ) => {
      const committed = replay<ReturnType<typeof view>>(context, 'update', body);
      if (committed) return committed;
      const previous = find(context.access.principalId, body.id);
      if (!previous) throw invalidInput('This personal job does not exist');
      const { id: _id, ...changes } = body;
      const job = { ...previous, ...changes, scheduleFrom: Date.now(), version: randomUUID() };
      validate(job, context.access.principalId, body.id);
      const result = view(job);
      await write(job, context.access, context.operationId!, previous, context, {
        action: 'update',
        input: body,
        result,
      });
      return result;
    },
    delete: async (id: string, context: ActionContext) => {
      const committed = replay<{ id: string; deleted: true }>(context, 'delete', { id });
      if (committed) return committed;
      const job = find(context.access.principalId, id);
      if (!job) throw invalidInput('This personal job does not exist');
      await retireMemoryRecord(
        adapter,
        { memoryId: job.recordId, status: 'stale', reason: 'The person deleted this job' },
        personalAccess(context.access),
        context.operationId!,
        context.session
      );
      return { id, deleted: true };
    },
    complete: (row: MailboxRow, access: JudgmentAccess) => finish(row, true, access),
  };
}
export type PersonalJobStore = ReturnType<typeof createPersonalJobStore>;

export function createPersonalJobScheduler(ports: {
  adapter: DatabaseInstance;
  store: PersonalJobStore;
  mailbox: Pick<Mailbox, 'readInput'>;
  intake(id: string): Promise<Pick<StimulusIntake, 'acceptScheduled'>>;
  blocked(id: string): boolean;
  onError(error: unknown): void;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = async (now = new Date()) => {
    for (const person of createPrincipalRepository(ports.adapter).listMembers()) {
      try {
        if (person.status !== 'active' || ports.blocked(person.principalId)) continue;
        const due = ports.store.list(person.principalId).flatMap((job) => {
          if (!job.enabled) return [];
          const at = latestCronOccurrence(
            job.cron,
            job.timeZone,
            now.getTime(),
            Math.max(job.scheduleFrom, job.lastClosedAt ?? job.createdAt)
          );
          return at === null ||
            ports.mailbox.readInput(personalJobOccurrenceId(job.jobId, at), person.principalId)
            ? []
            : [{ job, at }];
        });
        if (due.length === 0) continue;
        // An unserved person is served through the member directory lane, which may wait for
        // running member turns; the mailbox drops an occurrence an overlapping tick already took.
        const intake = await ports.intake(person.principalId);
        for (const { job, at } of due)
          intake.acceptScheduled({
            id: personalJobOccurrenceId(job.jobId, at),
            channelKey: `job:${job.jobId}`,
            occurredAt: at,
            payload: {
              jobId: job.jobId,
              version: job.version,
              instruction: job.instruction,
              timeZone: job.timeZone,
            },
          });
      } catch (error) {
        ports.onError(
          new Error(`Personal job scheduling failed for ${person.principalId}`, { cause: error })
        );
      }
    }
  };
  return {
    tick,
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((error: unknown) => ports.onError(error));
      }, 60_000);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
/** Final product failures settle the occurrence without claiming a successful completion. */
export class PersonalJobFinalFailure extends Error {}
/** Durable native result + outbound receipt recover delivery and chat independently of model context. */
export async function deliverPersonalJobResult(
  row: MailboxRow,
  result: NativeTurnResult,
  ports: {
    store: PersonalJobStore;
    access(): JudgmentAccess;
    chat: Pick<ChatSources, 'saveJobExchange' | 'hasJobExchange'>;
    send(access: JudgmentAccess, text: string, key: string): Promise<boolean>;
    delivered(access: JudgmentAccess, key: string): boolean;
  }
) {
  const payload = personalJobPayload(row)!;
  if (ports.store.isClosed(row) || ports.chat.hasJobExchange(payload.jobId, row.occurredAt)) return;
  const job = ports.store.find(row.principalId, payload.jobId);
  if (!ports.store.isActive(row.principalId))
    throw new PersonalJobFinalFailure('Personal job person is no longer active');
  if (!job || !job.enabled || job.version !== payload.version)
    throw new PersonalJobFinalFailure('Personal job changed or deleted');
  const access = ports.access();
  const text = result.response.trim();
  if (!text)
    throw new PersonalJobFinalFailure(
      'Personal job returned no result; use [ack] when there is nothing to tell'
    );
  if (text !== '[ack]') {
    const key = personalJobOccurrenceId(job.jobId, row.occurredAt);
    const delivered = ports.delivered(access, key);
    const superseded = ports.store.isSuperseded(row);
    if (superseded && !delivered)
      throw new PersonalJobFinalFailure('Personal job occurrence superseded by a later occurrence');
    try {
      if (!delivered && !(await ports.send(access, text, key)))
        throw new Error('Personal job DM delivery was not confirmed');
    } catch (error) {
      if (isDefinitiveTelegramRejection(error))
        throw new PersonalJobFinalFailure('Personal job DM delivery was rejected', {
          cause: error,
        });
      throw error;
    }
    ports.chat.saveJobExchange({
      jobId: job.jobId,
      occurrenceAt: row.occurredAt,
      instruction: payload.instruction,
      text,
      timeZone: payload.timeZone,
    });
    if (superseded) return;
  }
  await ports.store.complete(row, access);
}
