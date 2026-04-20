export const ENTITY_POLICY_ROLES = ['viewer', 'operator', 'admin'] as const;
export type EntityRole = (typeof ENTITY_POLICY_ROLES)[number];

export const ENTITY_POLICY_KINDS = [
  'entity_kind',
  'merge_guardrails',
  'review_thresholds',
  'connector_policy',
] as const;
export type EntityPolicyKind = (typeof ENTITY_POLICY_KINDS)[number];

export const ENTITY_POLICY_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type EntityPolicyProposalStatus = (typeof ENTITY_POLICY_PROPOSAL_STATUSES)[number];

export interface EntityPolicyRow {
  policy_key: string;
  policy_kind: EntityPolicyKind;
  value_json: string;
  value: Record<string, unknown>;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface EntityRoleBinding {
  actor_id: string;
  role: EntityRole;
  created_at: number;
  updated_at: number;
}

export interface EntityRoleBindingInput {
  actor_id: string;
  role: EntityRole;
}

export interface EntityPolicyProposalRow {
  proposal_id: string;
  policy_key: string;
  policy_kind: EntityPolicyKind;
  proposed_value_json: string;
  proposed_value: Record<string, unknown>;
  proposer_actor: string;
  approver_actor: string | null;
  reason: string;
  status: EntityPolicyProposalStatus;
  created_at: number;
  approved_at: number | null;
}

export interface EntityPolicyProposalInput {
  policy_key: string;
  policy_kind: EntityPolicyKind;
  proposed_value: Record<string, unknown>;
  proposer_actor: string;
  reason: string;
  proposal_id?: string;
  created_at?: number;
}

export interface EntityPolicyApprovalInput {
  proposal_id: string;
  approver_actor: string;
  approved_at?: number;
}

export interface EntityPolicyBootstrapPolicy {
  policy_key: string;
  policy_kind: EntityPolicyKind;
  value: Record<string, unknown>;
}

export interface EntityPolicyBootstrapRoleBinding {
  actor_id: string;
  role: EntityRole;
}

export interface EntityPolicyBootstrapDocument {
  version: number;
  policies: EntityPolicyBootstrapPolicy[];
  role_bindings: EntityPolicyBootstrapRoleBinding[];
}

export const ENTITY_ROLE_ORDER: Record<EntityRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

export function isEntityRole(value: string): value is EntityRole {
  return ENTITY_POLICY_ROLES.includes(value as EntityRole);
}

export function isEntityPolicyKind(value: string): value is EntityPolicyKind {
  return ENTITY_POLICY_KINDS.includes(value as EntityPolicyKind);
}

export function isEntityPolicyProposalStatus(value: string): value is EntityPolicyProposalStatus {
  return ENTITY_POLICY_PROPOSAL_STATUSES.includes(value as EntityPolicyProposalStatus);
}

export function createDefaultEntityPolicyBootstrap(
  adminActor = 'local:viewer'
): EntityPolicyBootstrapDocument {
  return {
    version: 1,
    policies: [
      {
        policy_key: 'merge_guardrails.default',
        policy_kind: 'merge_guardrails',
        value: {
          max_false_merge_rate: 0.02,
          require_review_for_cross_scope: true,
        },
      },
      {
        policy_key: 'review_thresholds.default',
        policy_kind: 'review_thresholds',
        value: {
          approve_score_min: 0.92,
          defer_score_min: 0.78,
        },
      },
    ],
    role_bindings: [
      {
        actor_id: adminActor,
        role: 'admin',
      },
    ],
  };
}
