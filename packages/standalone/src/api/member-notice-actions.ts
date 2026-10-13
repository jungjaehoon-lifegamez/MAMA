import { createHash } from 'node:crypto';
import {
  createPrincipalRepository,
  type ActionContext,
  type ActionRegistration,
  type DatabaseInstance,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import type { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { NoticeRef } from '../runtime/personal-notices.js';
import { resolvePrincipalAccess } from '../runtime/principal-access.js';
import { isRecordOrderRow } from '../runtime/stimulus-delivery.js';
import { parseRecordOrder, recordOrderBatches } from '../runtime/turn-orders.js';
import type { TimeZoneSetting } from '../runtime/timezone.js';

export interface MemberNoticePorts {
  mailbox(): Mailbox;
  /** Wakes host/native delivery without waiting for any member lane in the caller. */
  wake(principalId: string): void;
}
export function memberNoticeRegistrations(ports: {
  adapter: DatabaseInstance;
  ownerPrincipalId: string;
  ownerAccess(): JudgmentAccess;
  timeZone: TimeZoneSetting;
  notices?: MemberNoticePorts;
  read(ref: NoticeRef, access: JudgmentAccess): Promise<boolean>;
}): ActionRegistration[] {
  const common = (context: ActionContext) => {
    if (context.access.principalId !== ports.ownerPrincipalId)
      throw Object.assign(new Error('Only the common session may use this action'), {
        name: 'denied',
      });
  };
  return [
    {
      contract: {
        name: 'member.directory',
        summary:
          'Read the member directory in any common turn: principal ids, display names, statuses, roles and granted partitions. No transport identities, enrollment receipts or personal records.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      },
      exec: (_input, context) => {
        common(context);
        const repo = createPrincipalRepository(ports.adapter);
        return {
          members: repo.listMembers().map(({ principalId, displayName, status }) => ({
            principalId,
            ...(displayName === undefined ? {} : { displayName }),
            status,
            roles: repo.listRoles(principalId).map(({ role }) => role),
            grants: repo
              .listRetainedGrants(principalId)
              .flatMap(({ scope }) => (scope.kind === 'memory' ? [scope] : [])),
          })),
        };
      },
    },
    {
      contract: {
        name: 'member.notice',
        summary:
          'Queue one personal notice candidate when a common fact concerns a member: assigned to them, mentions them, or in a partition they hold. Use member.directory and cite source observation refs and the work record ids you wrote. The recipient reads only refs under its own current access and privately decides whether to tell it. No reason, summary or preview; replay never queues notices. Repeated calls for the same recipient and source turn are already queued.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['principalId', 'refs'],
          properties: {
            principalId: { type: 'string', pattern: '\\S' },
            refs: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              items: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['observationRef'],
                    properties: {
                      observationRef: { type: 'string', pattern: '\\S' },
                      source: { type: 'string', pattern: '\\S' },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['memory_id'],
                    properties: { memory_id: { type: 'string', pattern: '\\S' } },
                  },
                ],
              },
            },
          },
        },
      },
      exec: async (input, context) => {
        common(context);
        const refused = (reason: string) => ({ queued: false, reason });
        if (context.session?.replaySourceEndMs !== undefined) return refused('replay');
        if (!ports.notices) return refused('notices_unavailable');
        const ref = context.session?.sourceMessageRef;
        if (!ref) return refused('source_stimulus_required');
        const mailbox = ports.notices.mailbox();
        const row = mailbox.readInput(ref, ports.ownerPrincipalId);
        if (!row) return refused('source_stimulus_required');
        const record = isRecordOrderRow(row) ? parseRecordOrder(row.payload) : null;
        const sources = record
          ? [
              row,
              ...recordOrderBatches(record).map((batch) =>
                mailbox.readInput(batch.deltaStimulusId, ports.ownerPrincipalId)
              ),
            ]
          : [row];
        if (
          sources.some(
            (source) =>
              source?.payload &&
              typeof source.payload === 'object' &&
              !Array.isArray(source.payload) &&
              source.payload.replay !== undefined
          )
        )
          return refused('replay');
        const { principalId, refs } = input as { principalId: string; refs: NoticeRef[] };
        const source = record?.deltaStimulusId ?? ref;
        const noticeId = (sourceId: string) =>
          `notice:${principalId}:${createHash('sha256').update(sourceId).digest('hex')}`;
        const id = noticeId(source);
        const alreadyQueued = (sourceId = source) => {
          const key = noticeId(sourceId);
          return (
            mailbox.readInput(key, principalId) ||
            ports.adapter.prepare('SELECT 1 FROM mailbox_seen WHERE ref_id=?').get(key) ||
            ports.adapter
              .prepare('SELECT 1 FROM command_bindings WHERE command_id=? AND principal_id=?')
              .get(`notice-close:${key}`, principalId)
          );
        };
        // Check before reading refs: core rejects a duplicate identity with changed payload.
        if (alreadyQueued()) return refused('already_queued');
        const repo = createPrincipalRepository(ports.adapter);
        const person = repo.findById(principalId);
        if (person?.kind !== 'member' || person.status !== 'active')
          return refused('recipient_not_active_member');
        const notifiedObservations = new Set(
          (record?.carried ?? [])
            .filter((batch) => alreadyQueued(batch.deltaStimulusId))
            .flatMap((batch) => batch.observationRefs)
        );
        const filtered = refs.filter(
          (evidence) =>
            !('observationRef' in evidence) ||
            record?.observationRefs.includes(evidence.observationRef) ||
            !notifiedObservations.has(evidence.observationRef)
        );
        // Work record ids accompany the observations they came from: when every cited
        // observation was already noticed, the records were too.
        const observed = (list: NoticeRef[]) =>
          list.some((evidence) => 'observationRef' in evidence);
        const freshRefs = observed(refs) && !observed(filtered) ? [] : filtered;
        if (freshRefs.length === 0) return refused('already_queued');
        const access = resolvePrincipalAccess(principalId, {
          adapter: ports.adapter,
          ownerAccess: ports.ownerAccess(),
          agentId: `member-agent:${principalId}`,
        });
        const readable: NoticeRef[] = [];
        for (const evidence of freshRefs)
          if ((await ports.read(evidence, context.access)) && (await ports.read(evidence, access)))
            readable.push(evidence);
        if (readable.length === 0) return refused('no_readable_refs');
        if (repo.findById(principalId)?.status !== 'active')
          return refused('recipient_not_active_member');
        if (alreadyQueued()) return refused('already_queued');
        const carried = (record?.carried ?? []).filter((batch) =>
          readable.some(
            (evidence) =>
              'observationRef' in evidence &&
              batch.observationRefs.includes(evidence.observationRef)
          )
        );
        const accepted = ports.adapter.transaction(() => {
          const accepted = mailbox.enqueue({
            id,
            kind: 'scheduled',
            principalId,
            channelKey: 'notice',
            occurredAt: Date.now(),
            payload: {
              refs: readable,
              timeZone: ports.timeZone.get(),
              lifecycleVersion: repo.lifecycleVersion(principalId),
            },
          });
          if (accepted === null) return null;
          // Commit carried-batch markers with the notice without spending its 500-ref budget.
          // Their input binding also keeps P9 erasure and uncertain-input retention intact.
          const seen = ports.adapter.prepare(
            'INSERT OR IGNORE INTO mailbox_seen (ref_id, seen_at, principal_id) VALUES (?, ?, ?)'
          );
          const bind = ports.adapter.prepare(
            'INSERT OR IGNORE INTO mailbox_input_refs (input_id, ref_id, observation_ref) VALUES (?, ?, NULL)'
          );
          for (const batch of carried) {
            const key = noticeId(batch.deltaStimulusId);
            seen.run(key, Date.now(), principalId);
            bind.run(accepted, key);
          }
          return accepted;
        });
        if (accepted === null) return refused('already_queued');
        ports.notices.wake(principalId);
        return { queued: true };
      },
    },
  ];
}
