import { createHash } from 'node:crypto';

import type { DatabaseAdapter as DBManagerAdapter } from '../db-manager.js';

export interface PrincipalRow {
  principalId: string;
  kind: 'owner' | 'member';
  status: 'active' | 'suspended' | 'offboarded';
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
  bindIdentity(
    principalId: string,
    connector: string,
    namespace: string,
    externalId: string,
    now: number
  ): void;
  suspend(principalId: string, now: number): void;
  offboard(principalId: string, now: number): void;
  ensureOwner(input: {
    connector: string;
    namespace: string;
    externalId: string;
    now: number;
  }): 'created' | 'exists' | 'conflict';
  listMembers(): Array<{ principalId: string; displayName?: string; status: string }>;
}

export type PrincipalRegistrationErrorCode = 'identity_bound_to_owner' | 'member_not_active';

export class PrincipalRegistrationError extends Error {
  readonly code: PrincipalRegistrationErrorCode;

  constructor(code: PrincipalRegistrationErrorCode, message: string) {
    super(message);
    this.name = 'PrincipalRegistrationError';
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

interface PrincipalKindRow {
  kind: PrincipalKind;
}

interface MemberDatabaseRow {
  principal_id: string;
  display_name: string | null;
  status: PrincipalStatus;
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
  adapter: Pick<DBManagerAdapter, 'prepare' | 'transaction'>
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
  const selectPrincipalKindStatement = adapter.prepare(
    'SELECT kind FROM principals WHERE principal_id = ?'
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

  function transitionMember(
    principalId: string,
    status: Extract<PrincipalStatus, 'suspended' | 'offboarded'>,
    now: number
  ): void {
    const principal = selectPrincipalKindStatement.get(principalId) as PrincipalKindRow | undefined;
    if (!principal) {
      throw new Error(`Principal not found: ${principalId}`);
    }
    if (principal.kind === 'owner') {
      throw new Error(`Owner principals cannot be ${status}`);
    }
    updatePrincipalStatusStatement.run(status, now, principalId);
  }

  function ensureOwner(input: {
    connector: string;
    namespace: string;
    externalId: string;
    now: number;
  }): 'created' | 'exists' | 'conflict' {
    return adapter.transaction(() => {
      const existing = resolveByExternal(input.connector, input.namespace, input.externalId);
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

  return {
    resolveByExternal,
    registerMember,
    bindIdentity,
    suspend(principalId, now) {
      transitionMember(principalId, 'suspended', now);
    },
    offboard(principalId, now) {
      transitionMember(principalId, 'offboarded', now);
    },
    ensureOwner,
    listMembers,
  };
}
