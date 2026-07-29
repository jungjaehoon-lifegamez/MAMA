import { getAdapter } from '../db-manager.js';
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

export function getEntityPolicy(
  policyKey: string,
  adapter: PolicyStoreAdapter = getAdapter()
): EntityPolicyRow | null {
  const row = adapter
    .prepare('SELECT * FROM entity_policy WHERE policy_key = ? LIMIT 1')
    .get(policyKey) as Record<string, unknown> | undefined;
  return row ? parsePolicyRow(row) : null;
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

export function getEntityPolicyProposal(
  proposalId: string,
  adapter: PolicyStoreAdapter = getAdapter()
): EntityPolicyProposalRow | null {
  const row = adapter
    .prepare('SELECT * FROM entity_policy_proposals WHERE proposal_id = ? LIMIT 1')
    .get(proposalId) as Record<string, unknown> | undefined;
  return row ? parseProposalRow(row) : null;
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
