import { createHash } from 'node:crypto';

import type { DatabaseAdapter } from '../db-manager.js';

export interface PrincipalRow {
  principalId: string;
  kind: 'owner' | 'member';
  status: 'active' | 'suspended' | 'offboarded';
}

export const SHARED_MEMORY_SCOPE_KINDS = ['project', 'channel', 'global'] as const;

export type SharedMemoryScopeKind = (typeof SHARED_MEMORY_SCOPE_KINDS)[number];

export type PrincipalScopeGrantRef =
  | {
      kind: 'source';
      connector: string;
      channelId: string;
    }
  | {
      kind: 'memory';
      scopeKind: SharedMemoryScopeKind;
      scopeId: string;
    };

export interface PrincipalScopeGrantRecord {
  targetPrincipalId: string;
  scope: PrincipalScopeGrantRef;
  grantedByPrincipalId: string;
  createdAt: number;
}

export interface PrincipalScopeGrantMutationInput {
  targetPrincipalId: string;
  ownerPrincipalId: string;
  scope: PrincipalScopeGrantRef;
  now: number;
}

export interface PrincipalRepository {
  resolveByExternal(connector: string, namespace: string, externalId: string): PrincipalRow | null;
  registerMember(input: {
    displayName?: string;
    connector: string;
    namespace: string;
    externalId: string;
    now: number;
  }): string;
  /** Move only this identity, atomically; its current binding must match the expected principal. */
  moveIdentityToMember(input: {
    expectedPrincipalId: string;
    connector: string;
    namespace: string;
    externalId: string;
    now: number;
  }): string;
  bindIdentity(
    principalId: string,
    connector: string,
    namespace: string,
    externalId: string,
    now: number
  ): void;
  suspend(principalId: string, now: number): void;
  resume(principalId: string, now: number): void;
  /** Terminal transition; every retained grant is revoked in the same transaction. */
  offboard(principalId: string, now: number): void;
  /**
   * Without principalId, retain identity-based minting. A named id must be nonblank.
   * An active named owner returns exists, binding an unbound identity in the same transaction.
   * Named registration returns conflict for an identity bound elsewhere, another active
   * owner, or a named principal with a different kind/status; no rows change on conflict.
   * Keep the three result words for existing callers rather than add conflict details.
   */
  ensureOwner(input: {
    principalId?: string;
    connector: string;
    namespace: string;
    externalId: string;
    now: number;
  }): 'created' | 'exists' | 'conflict';
  findById(principalId: string): PrincipalRow | null;
  listMembers(): Array<{ principalId: string; displayName?: string; status: string }>;
  grantScope(input: PrincipalScopeGrantMutationInput): 'created' | 'exists';
  revokeScope(input: PrincipalScopeGrantMutationInput): 'revoked' | 'absent';
  listActiveGrants(principalId: string): PrincipalScopeGrantRecord[];
  /** Unrevoked grants, including those retained while the member is suspended. */
  listRetainedGrants(principalId: string): PrincipalScopeGrantRecord[];
  /**
   * Every project partition a member memory grant has ever named, revoked or not. The owner keeps
   * write authority over work it bound to a partition after the last grant on it ends.
   */
  listGrantedPartitions(): Array<{ kind: 'project'; id: string }>;
}

export type PrincipalRegistrationErrorCode =
  | 'identity_bound_to_owner'
  | 'member_not_active'
  | 'identity_binding_mismatch';

export class PrincipalRegistrationError extends Error {
  readonly code: PrincipalRegistrationErrorCode;

  constructor(code: PrincipalRegistrationErrorCode, message: string) {
    super(message);
    this.name = 'PrincipalRegistrationError';
    this.code = code;
  }
}

export type PrincipalScopeGrantErrorCode =
  | 'target_not_active_member'
  | 'grantor_not_active_owner'
  | 'invalid_scope';

export class PrincipalScopeGrantError extends Error {
  readonly code: PrincipalScopeGrantErrorCode;

  constructor(code: PrincipalScopeGrantErrorCode, message: string) {
    super(message);
    this.name = 'PrincipalScopeGrantError';
    this.code = code;
  }
}

type PrincipalKind = PrincipalRow['kind'];
type PrincipalStatus = PrincipalRow['status'];

interface PrincipalDatabaseRow {
  principal_id: string;
  kind: PrincipalKind;
  status: PrincipalStatus;
}

interface MemberDatabaseRow {
  principal_id: string;
  display_name: string | null;
  status: PrincipalStatus;
}

interface PrincipalScopeGrantDatabaseRow {
  principal_id: string;
  grant_kind: 'source' | 'memory';
  scope_kind: string;
  scope_id: string;
  granted_by_principal_id: string;
  created_at: number;
}

const MAX_SCOPE_COMPONENT_LENGTH = 512;

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function canonicalizeScopeComponent(value: unknown, label: string, lowercase = false): string {
  if (typeof value !== 'string') {
    throw new PrincipalScopeGrantError('invalid_scope', `${label} must be a string`);
  }
  const trimmed = value.trim();
  const canonical = lowercase ? trimmed.toLowerCase() : trimmed;
  if (
    canonical.length === 0 ||
    canonical.length > MAX_SCOPE_COMPONENT_LENGTH ||
    canonical === '*' ||
    containsControlCharacter(canonical)
  ) {
    throw new PrincipalScopeGrantError('invalid_scope', `${label} is not a canonical scope value`);
  }
  return canonical;
}

function canonicalizeGrantScope(scope: PrincipalScopeGrantRef): PrincipalScopeGrantRef {
  if (typeof scope !== 'object' || scope === null) {
    throw new PrincipalScopeGrantError('invalid_scope', 'Grant scope must be an object');
  }
  const candidate = scope as unknown as Record<string, unknown>;
  if (candidate.kind === 'source') {
    return {
      kind: 'source',
      connector: canonicalizeScopeComponent(candidate.connector, 'Source connector', true),
      channelId: canonicalizeScopeComponent(candidate.channelId, 'Source channel ID'),
    };
  }
  if (candidate.kind === 'memory') {
    if (
      typeof candidate.scopeKind !== 'string' ||
      !SHARED_MEMORY_SCOPE_KINDS.includes(candidate.scopeKind as SharedMemoryScopeKind)
    ) {
      throw new PrincipalScopeGrantError(
        'invalid_scope',
        'Memory grant kind must be project, channel, or global'
      );
    }
    return {
      kind: 'memory',
      scopeKind: candidate.scopeKind as SharedMemoryScopeKind,
      scopeId: canonicalizeScopeComponent(candidate.scopeId, 'Memory scope ID'),
    };
  }
  throw new PrincipalScopeGrantError('invalid_scope', 'Grant kind must be source or memory');
}

function scopeColumns(scope: PrincipalScopeGrantRef): {
  grantKind: 'source' | 'memory';
  scopeKind: string;
  scopeId: string;
} {
  if (scope.kind === 'source') {
    return {
      grantKind: 'source',
      scopeKind: scope.connector,
      scopeId: scope.channelId,
    };
  }
  return {
    grantKind: 'memory',
    scopeKind: scope.scopeKind,
    scopeId: scope.scopeId,
  };
}

function mapPrincipalScopeGrant(row: PrincipalScopeGrantDatabaseRow): PrincipalScopeGrantRecord {
  const scope: PrincipalScopeGrantRef =
    row.grant_kind === 'source'
      ? { kind: 'source', connector: row.scope_kind, channelId: row.scope_id }
      : {
          kind: 'memory',
          scopeKind: row.scope_kind as SharedMemoryScopeKind,
          scopeId: row.scope_id,
        };
  return {
    targetPrincipalId: row.principal_id,
    scope,
    grantedByPrincipalId: row.granted_by_principal_id,
    createdAt: row.created_at,
  };
}

function mintPrincipalId(
  kind: PrincipalKind,
  connector: string,
  namespace: string,
  externalId: string
): string {
  const identityKey = JSON.stringify([kind, connector, namespace, externalId]);
  const digest = createHash('sha256').update(identityKey, 'utf8').digest('hex');
  return `principal_${digest}`;
}

function mapPrincipal(row: PrincipalDatabaseRow): PrincipalRow {
  return {
    principalId: row.principal_id,
    kind: row.kind,
    status: row.status,
  };
}

export function createPrincipalRepository(
  adapter: Pick<DatabaseAdapter, 'prepare' | 'transaction'>
): PrincipalRepository {
  const resolveByExternalStatement = adapter.prepare(
    `SELECT p.principal_id, p.kind, p.status
     FROM external_identities AS e
     JOIN principals AS p ON p.principal_id = e.principal_id
     WHERE e.connector = ? AND e.namespace = ? AND e.external_id = ?`
  );
  const insertPrincipalStatement = adapter.prepare(
    `INSERT INTO principals (
       principal_id, kind, display_name, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'active', ?, ?)`
  );
  const insertIdentityStatement = adapter.prepare(
    `INSERT INTO external_identities (
       connector, namespace, external_id, principal_id, created_at
     ) VALUES (?, ?, ?, ?, ?)`
  );
  const selectPrincipalStatement = adapter.prepare(
    'SELECT principal_id, kind, status FROM principals WHERE principal_id = ?'
  );
  const updatePrincipalStatusStatement = adapter.prepare(
    'UPDATE principals SET status = ?, updated_at = ? WHERE principal_id = ?'
  );
  const selectActiveOwnerStatement = adapter.prepare(
    "SELECT principal_id FROM principals WHERE kind = 'owner' AND status = 'active' LIMIT 1"
  );
  const listMembersStatement = adapter.prepare(
    `SELECT principal_id, display_name, status
     FROM principals
     WHERE kind = 'member'
     ORDER BY created_at ASC, principal_id ASC`
  );
  const selectActiveGrantorStatement = adapter.prepare(
    `SELECT 1
     FROM principals
     WHERE principal_id = ? AND kind = 'owner' AND status = 'active'`
  );
  const insertGrantStatement = adapter.prepare(
    `INSERT INTO principal_scope_grants (
       principal_id, grant_kind, scope_kind, scope_id,
       granted_by_principal_id, created_at, revoked_at
     )
     SELECT ?, ?, ?, ?, ?, ?, NULL
     WHERE EXISTS (
       SELECT 1 FROM principals
       WHERE principal_id = ? AND kind = 'member' AND status = 'active'
     )
       AND EXISTS (
         SELECT 1 FROM principals
         WHERE principal_id = ? AND kind = 'owner' AND status = 'active'
       )
     ON CONFLICT (principal_id, grant_kind, scope_kind, scope_id)
       WHERE revoked_at IS NULL
     DO NOTHING`
  );
  // A suspended member keeps its grants, so the owner may still revoke one.
  const revokeGrantStatement = adapter.prepare(
    `UPDATE principal_scope_grants
     SET revoked_at = ?
     WHERE principal_id = ? AND grant_kind = ? AND scope_kind = ? AND scope_id = ?
       AND revoked_at IS NULL
       AND EXISTS (
         SELECT 1 FROM principals
         WHERE principal_id = ? AND kind = 'member' AND status IN ('active', 'suspended')
       )
       AND EXISTS (
         SELECT 1 FROM principals
         WHERE principal_id = ? AND kind = 'owner' AND status = 'active'
       )`
  );
  const listActiveGrantsStatement = adapter.prepare(
    `SELECT
       grants.principal_id,
       grants.grant_kind,
       grants.scope_kind,
       grants.scope_id,
       grants.granted_by_principal_id,
       grants.created_at
     FROM principal_scope_grants AS grants
     JOIN principals AS target ON target.principal_id = grants.principal_id
     WHERE grants.principal_id = ?
       AND grants.revoked_at IS NULL
       AND target.kind = 'member'
       AND target.status = 'active'
     ORDER BY grants.created_at ASC, grants.grant_kind ASC,
       grants.scope_kind ASC, grants.scope_id ASC`
  );
  const listGrantedPartitionsStatement = adapter.prepare(
    `SELECT DISTINCT scope_id AS id
     FROM principal_scope_grants
     WHERE grant_kind = 'memory' AND scope_kind = 'project'
     ORDER BY scope_id ASC`
  );
  const listRetainedGrantsStatement = adapter.prepare(
    `SELECT principal_id, grant_kind, scope_kind, scope_id, granted_by_principal_id, created_at
     FROM principal_scope_grants WHERE principal_id = ? AND revoked_at IS NULL
     ORDER BY created_at ASC, grant_kind ASC, scope_kind ASC, scope_id ASC`
  );

  function assertGrantMutationPrincipals(
    targetPrincipalId: string,
    ownerPrincipalId: string,
    revoke = false
  ): void {
    const target = selectPrincipalStatement.get(targetPrincipalId) as
      | PrincipalDatabaseRow
      | undefined;
    const allowed =
      target?.kind === 'member' &&
      (target.status === 'active' || (revoke && target.status === 'suspended'));
    if (!allowed) {
      throw new PrincipalScopeGrantError(
        'target_not_active_member',
        'Grant target must be an active member principal'
      );
    }
    if (!selectActiveGrantorStatement.get(ownerPrincipalId)) {
      throw new PrincipalScopeGrantError(
        'grantor_not_active_owner',
        'Grant mutation requires an active owner principal'
      );
    }
  }

  function resolveByExternal(
    connector: string,
    namespace: string,
    externalId: string
  ): PrincipalRow | null {
    const row = resolveByExternalStatement.get(connector, namespace, externalId) as
      | PrincipalDatabaseRow
      | undefined;
    return row ? mapPrincipal(row) : null;
  }

  function bindIdentity(
    principalId: string,
    connector: string,
    namespace: string,
    externalId: string,
    now: number
  ): void {
    insertIdentityStatement.run(connector, namespace, externalId, principalId, now);
  }

  function registerMember(input: {
    displayName?: string;
    connector: string;
    namespace: string;
    externalId: string;
    now: number;
  }): string {
    const existing = resolveByExternal(input.connector, input.namespace, input.externalId);
    if (existing) {
      if (existing.kind === 'member' && existing.status === 'active') {
        return existing.principalId;
      }
      if (existing.kind === 'owner') {
        throw new PrincipalRegistrationError(
          'identity_bound_to_owner',
          'External identity is already bound to an owner principal'
        );
      }
      throw new PrincipalRegistrationError(
        'member_not_active',
        'External identity is already bound to a non-active member principal'
      );
    }

    const principalId = mintPrincipalId(
      'member',
      input.connector,
      input.namespace,
      input.externalId
    );
    adapter.transaction(() => {
      insertPrincipalStatement.run(
        principalId,
        'member',
        input.displayName ?? null,
        input.now,
        input.now
      );
      bindIdentity(principalId, input.connector, input.namespace, input.externalId, input.now);
    });
    return principalId;
  }

  function moveIdentityToMember(input: {
    expectedPrincipalId: string;
    connector: string;
    namespace: string;
    externalId: string;
    now: number;
  }): string {
    return adapter.transaction(() => {
      const current = resolveByExternal(input.connector, input.namespace, input.externalId);
      if (!current || current.principalId !== input.expectedPrincipalId) {
        throw new PrincipalRegistrationError(
          'identity_binding_mismatch',
          'External identity does not belong to the expected principal'
        );
      }
      const principalId = mintPrincipalId(
        'member',
        input.connector,
        input.namespace,
        input.externalId
      );
      insertPrincipalStatement.run(principalId, 'member', null, input.now, input.now);
      adapter
        .prepare(
          `UPDATE external_identities SET principal_id = ?
         WHERE connector = ? AND namespace = ? AND external_id = ? AND principal_id = ?`
        )
        .run(
          principalId,
          input.connector,
          input.namespace,
          input.externalId,
          input.expectedPrincipalId
        );
      return principalId;
    });
  }

  function transitionMember(principalId: string, status: PrincipalStatus, now: number): void {
    adapter.transaction(() => {
      const principal = selectPrincipalStatement.get(principalId) as
        | PrincipalDatabaseRow
        | undefined;
      if (!principal) throw new Error(`Principal not found: ${principalId}`);
      if (principal.kind !== 'member')
        throw new Error(`Owner principals cannot transition to ${status}`);
      const legal =
        status === 'active'
          ? principal.status === 'suspended'
          : status === 'suspended'
            ? principal.status === 'active'
            : principal.status === 'active' || principal.status === 'suspended';
      if (!legal) throw new Error(`Illegal member transition: ${principal.status} -> ${status}`);
      if (status === 'offboarded') {
        adapter
          .prepare(
            'UPDATE principal_scope_grants SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL'
          )
          .run(now, principalId);
      }
      updatePrincipalStatusStatement.run(status, now, principalId);
    });
  }

  function ensureOwner(input: {
    principalId?: string;
    connector: string;
    namespace: string;
    externalId: string;
    now: number;
  }): 'created' | 'exists' | 'conflict' {
    if (input.principalId !== undefined && input.principalId.trim().length === 0) {
      throw new Error('principalId must be nonblank');
    }
    return adapter.transaction(() => {
      const existing = resolveByExternal(input.connector, input.namespace, input.externalId);
      if (input.principalId !== undefined) {
        if (existing && existing.principalId !== input.principalId) return 'conflict';
        const named = selectPrincipalStatement.get(input.principalId) as
          | PrincipalDatabaseRow
          | undefined;
        if (named && (named.kind !== 'owner' || named.status !== 'active')) return 'conflict';
        const activeOwner = selectActiveOwnerStatement.get() as
          | { principal_id: string }
          | undefined;
        if (activeOwner && activeOwner.principal_id !== input.principalId) return 'conflict';
        if (named) {
          if (!existing) {
            bindIdentity(
              input.principalId,
              input.connector,
              input.namespace,
              input.externalId,
              input.now
            );
          }
          return 'exists';
        }
        insertPrincipalStatement.run(input.principalId, 'owner', null, input.now, input.now);
        bindIdentity(
          input.principalId,
          input.connector,
          input.namespace,
          input.externalId,
          input.now
        );
        return 'created';
      }
      if (existing) {
        return existing.kind === 'owner' ? 'exists' : 'conflict';
      }
      if (selectActiveOwnerStatement.get()) {
        return 'conflict';
      }

      const principalId = mintPrincipalId(
        'owner',
        input.connector,
        input.namespace,
        input.externalId
      );
      insertPrincipalStatement.run(principalId, 'owner', null, input.now, input.now);
      bindIdentity(principalId, input.connector, input.namespace, input.externalId, input.now);
      return 'created';
    });
  }

  function listMembers(): Array<{
    principalId: string;
    displayName?: string;
    status: string;
  }> {
    return (listMembersStatement.all() as unknown as MemberDatabaseRow[]).map((row) => {
      const member = {
        principalId: row.principal_id,
        status: row.status,
      };
      return row.display_name === null ? member : { ...member, displayName: row.display_name };
    });
  }

  function grantScope(input: PrincipalScopeGrantMutationInput): 'created' | 'exists' {
    const canonicalScope = canonicalizeGrantScope(input.scope);
    const { grantKind, scopeKind, scopeId } = scopeColumns(canonicalScope);
    return adapter.transaction(() => {
      const result = insertGrantStatement.run(
        input.targetPrincipalId,
        grantKind,
        scopeKind,
        scopeId,
        input.ownerPrincipalId,
        input.now,
        input.targetPrincipalId,
        input.ownerPrincipalId
      );
      if (result.changes === 1) {
        return 'created';
      }
      assertGrantMutationPrincipals(input.targetPrincipalId, input.ownerPrincipalId);
      return 'exists';
    });
  }

  function revokeScope(input: PrincipalScopeGrantMutationInput): 'revoked' | 'absent' {
    const canonicalScope = canonicalizeGrantScope(input.scope);
    const { grantKind, scopeKind, scopeId } = scopeColumns(canonicalScope);
    return adapter.transaction(() => {
      const result = revokeGrantStatement.run(
        input.now,
        input.targetPrincipalId,
        grantKind,
        scopeKind,
        scopeId,
        input.targetPrincipalId,
        input.ownerPrincipalId
      );
      if (result.changes === 1) {
        return 'revoked';
      }
      assertGrantMutationPrincipals(input.targetPrincipalId, input.ownerPrincipalId, true);
      return 'absent';
    });
  }

  function listActiveGrants(principalId: string): PrincipalScopeGrantRecord[] {
    return (listActiveGrantsStatement.all(principalId) as PrincipalScopeGrantDatabaseRow[]).map(
      mapPrincipalScopeGrant
    );
  }

  return {
    resolveByExternal,
    registerMember,
    moveIdentityToMember,
    bindIdentity,
    suspend(principalId, now) {
      transitionMember(principalId, 'suspended', now);
    },
    resume(principalId, now) {
      transitionMember(principalId, 'active', now);
    },
    offboard(principalId, now) {
      transitionMember(principalId, 'offboarded', now);
    },
    ensureOwner,
    findById: (principalId) => {
      const row = selectPrincipalStatement.get(principalId) as PrincipalDatabaseRow | undefined;
      return row ? { principalId: row.principal_id, kind: row.kind, status: row.status } : null;
    },
    listMembers,
    grantScope,
    revokeScope,
    listActiveGrants,
    listRetainedGrants: (id) =>
      (listRetainedGrantsStatement.all(id) as PrincipalScopeGrantDatabaseRow[]).map(
        mapPrincipalScopeGrant
      ),
    listGrantedPartitions: () =>
      (listGrantedPartitionsStatement.all() as Array<{ id: string }>).map(({ id }) => ({
        kind: 'project',
        id,
      })),
  };
}
