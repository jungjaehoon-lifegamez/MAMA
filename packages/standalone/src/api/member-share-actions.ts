import {
  createPrincipalRepository,
  readMemoryRecordById,
  saveJudgmentRecord,
  type ActionRegistration,
  type DatabaseInstance,
  type JudgmentAccess,
  type MemoryRecord,
  type MemoryScopeRef,
} from '@jungjaehoon/mama-core';
import { amendedRecordIds, ownerSpeaking } from '../runtime/owner-authority.js';
import { invalidInput } from '../utils/invalid-input.js';

interface MemberSharePorts {
  adapter: DatabaseInstance;
  ownerPrincipalId: string;
  ownerDefaultScopes: readonly MemoryScopeRef[];
}

function denied(message: string): Error {
  const error = new Error(message);
  error.name = 'denied';
  return error;
}

/**
 * A member changes shared records only in a group room, where the team sees it (owner decision
 * 2026-10-09). Until group-room turns exist (P10), a member turn replaces or retires only records
 * bound to its own personal scope alone; sharing one stays allowed. A record with no binding is
 * not the member's either. The owner is unchanged; a missing record is left to core.
 */
export function guardMemberSharedRecords(
  registration: ActionRegistration,
  adapter: DatabaseInstance,
  ownerPrincipalId: string
): ActionRegistration {
  const action = registration.contract.name;
  return {
    ...registration,
    exec: async (input, context) => {
      const principalId = context.access.principalId;
      if (principalId !== ownerPrincipalId) {
        for (const id of amendedRecordIds(action, input)) {
          const bindings = adapter
            .prepare(
              `SELECT s.kind, s.external_id FROM decisions d
               LEFT JOIN memory_scope_bindings b ON b.memory_id = d.id
               LEFT JOIN memory_scopes s ON s.id = b.scope_id
               WHERE d.id = ?`
            )
            .all(id) as Array<{ kind: string | null; external_id: string | null }>;
          if (
            bindings.length > 0 &&
            !bindings.every(
              (binding) => binding.kind === 'user' && binding.external_id === principalId
            )
          )
            throw denied(
              `${id} is not only yours: shared records change in the group room, not in this ` +
                'chat. Save your own note instead, or raise it in the group room.'
            );
        }
      }
      return await registration.exec(input, context);
    },
  };
}

function revisionText(record: MemoryRecord) {
  return {
    id: record.id,
    createdAt: record.created_at,
    summary: record.summary,
    details: record.details,
    ...(record.applies_when === undefined ? {} : { appliesWhen: record.applies_when }),
    ...(record.steps === undefined ? {} : { steps: record.steps }),
    ...(record.evidence_checks === undefined ? {} : { evidenceChecks: record.evidence_checks }),
  };
}

export function memberShareActionRegistrations(ports: MemberSharePorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'memory.share',
        recallableWrite: true,
        summary:
          'Share a personal memory record and its whole revision history at sharing time with a granted project partition, only in your own message turn. A later private revision needs another share. The original stays private; returns the appended share record id.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['memory_id', 'partition_id', 'reason'],
          properties: {
            memory_id: {
              type: 'string',
              pattern: '\\S',
              description: 'Record bound only to your personal user scope.',
            },
            partition_id: {
              type: 'string',
              pattern: '\\S',
              description: 'Project partition id from your active memory read grants.',
            },
            reason: {
              type: 'string',
              pattern: '\\S',
              description: 'Why you consent to sharing this record and its history.',
            },
          },
        },
        examples: [
          {
            title: 'Share a personal review history',
            input: {
              memory_id: 'fixture-memory',
              partition_id: 'fixture-partition',
              reason: 'Share the review history with the project.',
            },
          },
        ],
      },
      exec: async (input, context) => {
        const {
          memory_id: memoryId,
          partition_id: partitionId,
          reason,
        } = input as {
          memory_id: string;
          partition_id: string;
          reason: string;
        };
        if (!context.operationId?.trim()) throw invalidInput('memory.share requires operationId');
        const repository = createPrincipalRepository(ports.adapter);
        const principal = repository.findById(context.access.principalId);
        if (
          principal?.kind !== 'member' ||
          principal.status !== 'active' ||
          principal.principalId === ports.ownerPrincipalId
        )
          throw denied('memory.share requires an active member; the owner shares by binding work');
        // The same host-stated principal, chat ref and live-turn predicate as owner chat consent.
        if (!ownerSpeaking(context, principal.principalId))
          throw denied('memory.share is available only in the member own message turn');
        if (
          ports.ownerDefaultScopes.some(
            (scope) => scope.kind === 'project' && scope.id === partitionId
          )
        )
          throw denied('The partition is an owner default scope');
        if (
          !repository
            .listActiveGrants(principal.principalId)
            .some(
              ({ scope }) =>
                scope.kind === 'memory' &&
                scope.scopeKind === 'project' &&
                scope.scopeId === partitionId
            )
        )
          throw denied('The partition requires an active project memory read grant');

        const readable = [...context.access.scopes, ...(context.access.readScopes ?? [])];
        const record = await readMemoryRecordById(ports.adapter, memoryId, readable);
        if (
          !record ||
          'state' in record ||
          record.scopes.length !== 1 ||
          record.scopes[0]!.kind !== 'user' ||
          record.scopes[0]!.id !== principal.principalId
        )
          throw denied('The record must be bound only to the member personal user scope');
        // The caller's operation id itself, so operation.get recovers a lost response.
        const commandId = context.operationId;
        // Only the current revision is shared; an earlier or stale one would reach readers as live.
        // A recorded operation goes on to core's replay, which answers it whatever came after.
        const recorded =
          ports.adapter
            .prepare('SELECT 1 FROM command_bindings WHERE command_id = ?')
            .get(commandId) !== undefined;
        if (!recorded && record.status !== 'active')
          throw invalidInput(
            'Share the current revision of the record, not a replaced or stale one'
          );
        // Enumerate ids only, including every replaces branch and legacy supersedes. Read all
        // content through the existing scope-checked record read, never through this metadata query.
        const earlier = ports.adapter
          .prepare(
            `
        WITH RECURSIVE revisions(id) AS (
          SELECT ?
          UNION
          SELECT d.supersedes FROM decisions d JOIN revisions r ON r.id = d.id
          WHERE d.supersedes IS NOT NULL
          UNION
          SELECT e.object_id FROM twin_edges e JOIN revisions r ON r.id = e.subject_id
          WHERE e.subject_kind = 'memory' AND e.object_kind = 'memory' AND e.edge_type = 'supersedes'
        ) SELECT id FROM revisions WHERE id <> ?`
          )
          .all(record.id, record.id) as Array<{ id: string }>;
        // Which revision each one replaced, and why, so branches and reasons survive in the share.
        const replaced = (id: string) => {
          const rows = ports.adapter
            .prepare(
              `
        SELECT d.supersedes AS id, NULL AS reason FROM decisions d
        WHERE d.id = ? AND d.supersedes IS NOT NULL
        UNION
        SELECT e.object_id AS id, e.reason_text AS reason FROM twin_edges e
        WHERE e.subject_kind = 'memory' AND e.subject_id = ? AND e.object_kind = 'memory'
          AND e.edge_type = 'supersedes'
        ORDER BY id`
            )
            .all(id, id) as Array<{ id: string; reason: string | null }>;
          // A replacement can be recorded both as the column and as an edge; keep one per id.
          const byId = new Map<string, string | null>();
          for (const row of rows) byId.set(row.id, byId.get(row.id) ?? row.reason);
          return [...byId].map(([predecessor, reason]) => ({ id: predecessor, reason }));
        };
        const revisions = [];
        for (const { id } of earlier) {
          const revision = await readMemoryRecordById(ports.adapter, id, readable);
          if (!revision || 'state' in revision)
            throw denied(
              'The whole revision history must be readable by the member before sharing'
            );
          revisions.push({ ...revisionText(revision), replaces: replaced(revision.id) });
        }
        // Legacy records carry ISO text timestamps; numbers and text both order by time.
        const time = (value: number | string) =>
          typeof value === 'number' ? value : Date.parse(value);
        revisions.sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id));
        const scopes: MemoryScopeRef[] = [
          { kind: 'user', id: principal.principalId },
          { kind: 'project', id: partitionId },
        ];
        // This authority exists only for the append below; the ordinary member access stays intact.
        const shareAccess: JudgmentAccess = {
          principalId: principal.principalId,
          agentId: context.access.agentId,
          scopes,
          defaultScopes: scopes,
          actions: ['memory.share'],
        };
        return saveJudgmentRecord(
          ports.adapter,
          {
            topic: record.topic,
            kind: 'fact',
            summary: record.summary,
            details: JSON.stringify({
              memoryId: record.id,
              partitionId,
              reason,
              current: { ...revisionText(record), replaces: replaced(record.id) },
              revisions,
            }),
            scopes,
            source: { package: 'mama-os', source_type: 'memory.share' },
            links: [
              {
                relation: 'mentions',
                target: { kind: 'memory', id: record.id },
                attrs: { reason },
              },
            ],
          },
          shareAccess,
          commandId,
          { ...context.session, toolName: 'memory.share' }
        );
      },
    },
  ];
}
