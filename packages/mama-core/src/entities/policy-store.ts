import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { getAdapter, initDB } from '../db-manager.js';
import type { DatabaseAdapter } from '../db-manager.js';
import {
  createDefaultEntityPolicyBootstrap,
  isEntityPolicyKind,
  isEntityPolicyProposalStatus,
  isEntityRole,
  type EntityPolicyApprovalInput,
  type EntityPolicyBootstrapDocument,
  type EntityPolicyKind,
  type EntityPolicyProposalInput,
  type EntityPolicyProposalRow,
  type EntityPolicyRow,
  type EntityRole,
  type EntityRoleBinding,
  type EntityRoleBindingInput,
} from './policy-types.js';

type PolicyStoreAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

function now(): number {
  return Date.now();
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parsePolicyRow(row: Record<string, unknown>): EntityPolicyRow {
  const policyKind = String(row.policy_kind);
  if (!isEntityPolicyKind(policyKind)) {
    throw new Error(`Invalid entity policy row: policy_kind=${policyKind}`);
  }

  const valueJson = String(row.value_json);
  return {
    policy_key: String(row.policy_key),
    policy_kind: policyKind,
    value_json: valueJson,
    value: parseJsonObject(valueJson, 'entity_policy.value_json'),
    version: Number(row.version),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function parseRoleBindingRow(row: Record<string, unknown>): EntityRoleBinding {
  const role = String(row.role);
  if (!isEntityRole(role)) {
    throw new Error(`Invalid entity role binding row: role=${role}`);
  }

  return {
    actor_id: String(row.actor_id),
    role,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function parseProposalRow(row: Record<string, unknown>): EntityPolicyProposalRow {
  const policyKind = String(row.policy_kind);
  if (!isEntityPolicyKind(policyKind)) {
    throw new Error(`Invalid entity policy proposal row: policy_kind=${policyKind}`);
  }

  const status = String(row.status);
  if (!isEntityPolicyProposalStatus(status)) {
    throw new Error(`Invalid entity policy proposal row: status=${status}`);
  }

  const proposedValueJson = String(row.proposed_value_json);
  return {
    proposal_id: String(row.proposal_id),
    policy_key: String(row.policy_key),
    policy_kind: policyKind,
    proposed_value_json: proposedValueJson,
    proposed_value: parseJsonObject(
      proposedValueJson,
      'entity_policy_proposals.proposed_value_json'
    ),
    proposer_actor: String(row.proposer_actor),
    approver_actor: typeof row.approver_actor === 'string' ? row.approver_actor : null,
    reason: String(row.reason),
    status,
    created_at: Number(row.created_at),
    approved_at: typeof row.approved_at === 'number' ? row.approved_at : null,
  };
}

function readBootstrapDocument(bootstrapPath: string): EntityPolicyBootstrapDocument {
  const raw = fs.readFileSync(bootstrapPath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<EntityPolicyBootstrapDocument>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Entity policy bootstrap must be a JSON object');
  }
  if (typeof parsed.version !== 'number') {
    throw new Error('Entity policy bootstrap must include numeric version');
  }
  if (!Array.isArray(parsed.policies)) {
    throw new Error('Entity policy bootstrap must include policies[]');
  }
  if (!Array.isArray(parsed.role_bindings)) {
    throw new Error('Entity policy bootstrap must include role_bindings[]');
  }

  for (const policy of parsed.policies) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new Error('Entity policy bootstrap policies must be objects');
    }
    if (
      typeof policy.policy_key !== 'string' ||
      typeof policy.policy_kind !== 'string' ||
      !isEntityPolicyKind(policy.policy_kind) ||
      !policy.value ||
      typeof policy.value !== 'object' ||
      Array.isArray(policy.value)
    ) {
      throw new Error('Entity policy bootstrap policy rows are invalid');
    }
  }

  for (const binding of parsed.role_bindings) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new Error('Entity policy bootstrap role_bindings must be objects');
    }
    if (
      typeof binding.actor_id !== 'string' ||
      typeof binding.role !== 'string' ||
      !isEntityRole(binding.role)
    ) {
      throw new Error('Entity policy bootstrap role binding rows are invalid');
    }
  }

  return parsed as EntityPolicyBootstrapDocument;
}

function countRows(
  tableName: 'entity_policy' | 'entity_role_bindings' | 'entity_policy_proposals',
  adapter: PolicyStoreAdapter
): number {
  const row = adapter.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get() as {
    total: number;
  };
  return Number(row.total ?? 0);
}

export async function ensureEntityPolicyBootstrap(args: {
  bootstrapPath: string;
  now?: () => number;
}): Promise<void> {
  await initDB();
  const adapter = getAdapter();
  const document = readBootstrapDocument(args.bootstrapPath);
  const timestamp = args.now?.() ?? now();

  adapter.transaction(() => {
    if (countRows('entity_policy', adapter) === 0) {
      for (const policy of document.policies) {
        adapter
          .prepare(
            `
              INSERT INTO entity_policy (
                policy_key, policy_kind, value_json, version, created_at, updated_at
              ) VALUES (?, ?, ?, 1, ?, ?)
            `
          )
          .run(
            policy.policy_key,
            policy.policy_kind,
            JSON.stringify(policy.value),
            timestamp,
            timestamp
          );
      }
    }

    if (countRows('entity_role_bindings', adapter) === 0) {
      for (const binding of document.role_bindings) {
        adapter
          .prepare(
            `
              INSERT INTO entity_role_bindings (
                actor_id, role, created_at, updated_at
              ) VALUES (?, ?, ?, ?)
            `
          )
          .run(binding.actor_id, binding.role, timestamp, timestamp);
      }
    }
  });
}

export function listEntityPolicies(adapter: PolicyStoreAdapter = getAdapter()): EntityPolicyRow[] {
  const rows = adapter
    .prepare('SELECT * FROM entity_policy ORDER BY policy_key ASC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(parsePolicyRow);
}

export function getEntityPolicy(
  policyKey: string,
  adapter: PolicyStoreAdapter = getAdapter()
): EntityPolicyRow | null {
  const row = adapter
    .prepare('SELECT * FROM entity_policy WHERE policy_key = ? LIMIT 1')
    .get(policyKey) as Record<string, unknown> | undefined;
  return row ? parsePolicyRow(row) : null;
}

export function listEntityRoleBindings(
  adapter: PolicyStoreAdapter = getAdapter()
): EntityRoleBinding[] {
  const rows = adapter
    .prepare('SELECT * FROM entity_role_bindings ORDER BY actor_id ASC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(parseRoleBindingRow);
}

export function upsertEntityRoleBinding(
  input: EntityRoleBindingInput,
  adapter: PolicyStoreAdapter = getAdapter()
): void {
  const timestamp = now();
  const existing = adapter
    .prepare('SELECT created_at FROM entity_role_bindings WHERE actor_id = ? LIMIT 1')
    .get(input.actor_id) as { created_at: number } | undefined;

  adapter
    .prepare(
      `
        INSERT INTO entity_role_bindings (
          actor_id, role, created_at, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(actor_id) DO UPDATE SET
          role = excluded.role,
          updated_at = excluded.updated_at
      `
    )
    .run(input.actor_id, input.role, existing?.created_at ?? timestamp, timestamp);
}

export function resolveEntityRoleForActor(
  actorId: string,
  adapter: PolicyStoreAdapter = getAdapter()
): EntityRole {
  const row = adapter
    .prepare('SELECT role FROM entity_role_bindings WHERE actor_id = ? LIMIT 1')
    .get(actorId) as { role?: string } | undefined;
  return row?.role && isEntityRole(row.role) ? row.role : 'viewer';
}

export function createEntityPolicyProposal(
  input: EntityPolicyProposalInput,
  adapter: PolicyStoreAdapter = getAdapter()
): string {
  const proposalId = input.proposal_id ?? `epol_${randomUUID()}`;
  const createdAt = input.created_at ?? now();
  adapter
    .prepare(
      `
        INSERT INTO entity_policy_proposals (
          proposal_id, policy_key, policy_kind, proposed_value_json, proposer_actor,
          approver_actor, reason, status, created_at, approved_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'pending', ?, NULL)
      `
    )
    .run(
      proposalId,
      input.policy_key,
      input.policy_kind,
      JSON.stringify(input.proposed_value),
      input.proposer_actor,
      input.reason,
      createdAt
    );
  return proposalId;
}

export function getEntityPolicyProposal(
  proposalId: string,
  adapter: PolicyStoreAdapter = getAdapter()
): EntityPolicyProposalRow | null {
  const row = adapter
    .prepare('SELECT * FROM entity_policy_proposals WHERE proposal_id = ? LIMIT 1')
    .get(proposalId) as Record<string, unknown> | undefined;
  return row ? parseProposalRow(row) : null;
}

export function approveEntityPolicyProposal(
  input: EntityPolicyApprovalInput,
  adapter: PolicyStoreAdapter = getAdapter()
): EntityPolicyProposalRow {
  const approvedAt = input.approved_at ?? now();

  return adapter.transaction(() => {
    const proposal = getEntityPolicyProposal(input.proposal_id, adapter);
    if (!proposal) {
      throw new Error(`Entity policy proposal not found: ${input.proposal_id}`);
    }
    if (proposal.status !== 'pending') {
      throw new Error(`Entity policy proposal is not pending: ${input.proposal_id}`);
    }
    if (proposal.proposer_actor === input.approver_actor) {
      throw new Error('Entity policy proposal requires a different approver');
    }
    const approverRole = resolveEntityRoleForActor(input.approver_actor, adapter);
    if (approverRole !== 'admin') {
      throw new Error('Entity policy proposal approval requires an admin approver');
    }

    const existingPolicy = getEntityPolicy(proposal.policy_key, adapter);
    const version = existingPolicy ? existingPolicy.version + 1 : 1;
    const createdAt = existingPolicy?.created_at ?? approvedAt;

    adapter
      .prepare(
        `
          INSERT INTO entity_policy (
            policy_key, policy_kind, value_json, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(policy_key) DO UPDATE SET
            policy_kind = excluded.policy_kind,
            value_json = excluded.value_json,
            version = excluded.version,
            updated_at = excluded.updated_at
        `
      )
      .run(
        proposal.policy_key,
        proposal.policy_kind,
        proposal.proposed_value_json,
        version,
        createdAt,
        approvedAt
      );

    adapter
      .prepare(
        `
          UPDATE entity_policy_proposals
          SET approver_actor = ?,
              status = 'approved',
              approved_at = ?
          WHERE proposal_id = ?
        `
      )
      .run(input.approver_actor, approvedAt, input.proposal_id);

    const approved = getEntityPolicyProposal(input.proposal_id, adapter);
    if (!approved) {
      throw new Error(`Failed to reload approved entity policy proposal: ${input.proposal_id}`);
    }
    return approved;
  });
}

export {
  createDefaultEntityPolicyBootstrap,
  type EntityPolicyApprovalInput,
  type EntityPolicyBootstrapDocument,
  type EntityPolicyKind,
  type EntityPolicyProposalInput,
  type EntityPolicyProposalRow,
  type EntityPolicyRow,
  type EntityRole,
  type EntityRoleBinding,
  type EntityRoleBindingInput,
};
