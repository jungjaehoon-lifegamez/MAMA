import {
  saveJudgmentRecord,
  type ActionContext,
  type ActionRegistration,
  type DatabaseInstance,
} from '@jungjaehoon/mama-core';
import { ownerSpeaking, POLICY_UPDATE_ACTION } from '../runtime/owner-authority.js';
import {
  ownerPolicyFingerprint,
  readOwnerPolicy,
  replaceOwnerPolicy,
} from '../runtime/owner-policy.js';

export interface OwnerPolicyActionPorts {
  runtimeRoot: string;
  adapter: DatabaseInstance;
  ownerPrincipalId: string;
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function latestRevision(ports: OwnerPolicyActionPorts): { id: string; text: string } | null {
  return (
    (ports.adapter
      .prepare(
        `SELECT d.id, d.reasoning AS text FROM decisions d
     WHERE json_extract(d.provenance_json, '$.tool_name') = ?
       AND EXISTS (SELECT 1 FROM memory_scope_bindings b
                   JOIN memory_scopes s ON s.id = b.scope_id
                   WHERE b.memory_id = d.id AND s.kind = 'user' AND s.external_id = ?)
     ORDER BY d.rowid DESC LIMIT 1`
      )
      .get(POLICY_UPDATE_ACTION, ports.ownerPrincipalId) as
      | { id: string; text: string }
      | undefined) ?? null
  );
}

export function ownerPolicyActionRegistrations(
  ports: OwnerPolicyActionPorts
): ActionRegistration[] {
  let updating = false;
  const revision = async (
    text: string,
    reason: string,
    previous: string | null,
    commandId: string,
    context: ActionContext
  ): Promise<string> => {
    const saved = await saveJudgmentRecord(
      ports.adapter,
      {
        topic: 'owner-policy',
        kind: 'decision',
        summary: reason,
        details: text,
        scopes: [{ kind: 'user', id: ports.ownerPrincipalId }],
        source: { package: 'owner-agent', source_type: POLICY_UPDATE_ACTION },
        ...(previous === null ? {} : { replaces: [{ id: previous, reason }] }),
      },
      context.access,
      commandId,
      { ...context.session, toolName: POLICY_UPDATE_ACTION }
    );
    // The file must always name a durable revision receipt before it is replaced.
    if (!saved.id) throw new Error('Owner policy revision write returned no record id');
    return saved.id;
  };
  return [
    {
      contract: {
        name: 'manage.policy.read',
        summary:
          'Read the owner policy and its file fingerprint. Returns text, loaded, fingerprint, the latest revision id and fingerprint (or null), and mismatch when the file differs from that revision. Read before updating; a hand edit or interrupted update is reported, never hidden.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        examples: [{ title: 'Read the current standing rules', input: {} }],
      },
      exec: () => {
        const snapshot = readOwnerPolicy(ports.runtimeRoot);
        const latest = latestRevision(ports);
        const recorded =
          latest === null
            ? null
            : { id: latest.id, fingerprint: ownerPolicyFingerprint(latest.text) };
        return {
          text: snapshot.content,
          fingerprint: snapshot.fingerprint,
          loaded: snapshot.loaded,
          revision: recorded,
          mismatch: recorded !== null && recorded.fingerprint !== snapshot.fingerprint,
        };
      },
    },
    {
      contract: {
        name: POLICY_UPDATE_ACTION,
        recallableWrite: true,
        summary:
          'Replace the owner policy with a standing correction. Only the owner agent in an owner chat turn may update it, using the fingerprint from manage.policy.read. Saves the reason and complete text as an owner-scoped memory revision with the source message before atomically replacing the file. A file that differs from history is recorded as a base revision first; returns revisionId, baseRevisionId and the new fingerprint.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'fingerprint', 'reason'],
          properties: {
            text: {
              type: 'string',
              description: 'Complete replacement policy text, preserving rules not withdrawn.',
            },
            fingerprint: {
              type: 'string',
              minLength: 1,
              description: 'Current file sha256 from manage.policy.read.',
            },
            reason: {
              type: 'string',
              minLength: 1,
              description: 'Why the owner changed the standing rules.',
            },
          },
        },
        examples: [
          {
            title: 'Keep notices brief after an owner correction',
            input: {
              text: 'Keep notices brief.\n',
              fingerprint: 'sha256-from-manage.policy.read',
              reason: 'The owner asked for brief notices.',
            },
          },
        ],
      },
      exec: async (input, context) => {
        if (!ownerSpeaking(context, ports.ownerPrincipalId))
          throw namedError(
            'denied',
            `${POLICY_UPDATE_ACTION} is available only in an owner chat turn`
          );
        const { text, fingerprint, reason } = input as {
          text: string;
          fingerprint: string;
          reason: string;
        };
        if (
          typeof text !== 'string' ||
          typeof fingerprint !== 'string' ||
          typeof reason !== 'string' ||
          reason.trim() === ''
        )
          throw namedError(
            'invalid_input',
            'text and fingerprint must be strings and reason must be nonblank'
          );
        if (!context.operationId)
          throw namedError('invalid_input', `${POLICY_UPDATE_ACTION} requires operationId`);
        // Parallel calls must not both accept one fingerprint and fork the revision chain.
        if (updating) throw namedError('conflict', 'An owner policy update is already in progress');
        updating = true;
        try {
          const current = readOwnerPolicy(ports.runtimeRoot);
          // A lost response is retried with the same operation id.
          const recorded = ports.adapter
            .prepare(
              `SELECT d.id AS revisionId, d.reasoning AS text, b.record_id AS baseRevisionId
               FROM judgment_commands r JOIN decisions d ON d.id = r.record_id
               LEFT JOIN judgment_commands b ON b.command_id = ?
               WHERE r.command_id = ?`
            )
            .get(`${context.operationId}:base`, `${context.operationId}:revision`) as
            | { revisionId: string; text: string; baseRevisionId: string | null }
            | undefined;
          if (recorded) {
            const recordedFingerprint = ownerPolicyFingerprint(recorded.text);
            if (current.fingerprint !== recordedFingerprint) {
              if (current.fingerprint !== fingerprint)
                throw namedError(
                  'conflict',
                  'Owner policy fingerprint changed; read it again with manage.policy.read'
                );
              replaceOwnerPolicy(ports.runtimeRoot, recorded.text);
            }
            return {
              revisionId: recorded.revisionId,
              baseRevisionId: recorded.baseRevisionId,
              fingerprint: recordedFingerprint,
            };
          }
          if (fingerprint !== current.fingerprint)
            throw namedError(
              'conflict',
              'Owner policy fingerprint changed; read it again with manage.policy.read'
            );
          const latest = latestRevision(ports);
          let previous = latest?.id ?? null;
          let baseRevisionId: string | null = null;
          if (
            (latest === null && current.loaded) ||
            (latest !== null && ownerPolicyFingerprint(latest.text) !== current.fingerprint)
          ) {
            baseRevisionId = await revision(
              current.content ?? '',
              `Record current owner policy before: ${reason}`,
              previous,
              `${context.operationId}:base`,
              context
            );
            previous = baseRevisionId;
          }
          const revisionId = await revision(
            text,
            reason,
            previous,
            `${context.operationId}:revision`,
            context
          );
          // A hand edit during the asynchronous memory writes must not be overwritten.
          if (readOwnerPolicy(ports.runtimeRoot).fingerprint !== fingerprint)
            throw namedError(
              'conflict',
              'Owner policy fingerprint changed during the update; read it again with manage.policy.read'
            );
          replaceOwnerPolicy(ports.runtimeRoot, text);
          return { revisionId, baseRevisionId, fingerprint: ownerPolicyFingerprint(text) };
        } finally {
          updating = false;
        }
      },
    },
  ];
}
