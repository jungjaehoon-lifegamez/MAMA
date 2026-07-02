import type { GatewayToolName } from '../agent/types.js';

export type VNextCommitRuntimeMode = 'legacy' | 'vnext';
export type VNextCommitActorKind =
  | 'primary_operator'
  | 'worker'
  | 'viewer_admin'
  | 'legacy_agent'
  | 'unknown';
export type VNextCommitEffect =
  | 'legacy'
  | 'commit'
  | 'manual'
  | 'delegate'
  | 'projection'
  | 'proposal_required'
  | 'denied';

export interface VNextCommitActor {
  kind: VNextCommitActorKind;
  agentId?: string;
}

export interface VNextCommitAuthorityInput {
  runtimeMode: VNextCommitRuntimeMode;
  toolName: GatewayToolName | string;
  actor: VNextCommitActor;
}

export type VNextCommitAuthorityDecision =
  | {
      allowed: true;
      effect: VNextCommitEffect;
      reason: string;
    }
  | {
      allowed: false;
      effect: VNextCommitEffect;
      code: string;
      reason: string;
    };

const DURABLE_WRITE_TOOLS = new Set<string>([
  'mama_save',
  'mama_update',
  'mama_add',
  'mama_ingest',
  'wiki_publish',
  'obsidian',
  'report_publish',
  'task_create',
  'task_update',
  'delegate',
]);

const FILESYSTEM_WRITE_TOOLS = new Set<string>(['Write', 'Bash']);

function allow(effect: VNextCommitEffect, reason: string): VNextCommitAuthorityDecision {
  return { allowed: true, effect, reason };
}

function deny(
  effect: VNextCommitEffect,
  code: string,
  reason: string
): VNextCommitAuthorityDecision {
  return { allowed: false, effect, code, reason };
}

export function resolveCommitAuthority(
  input: VNextCommitAuthorityInput
): VNextCommitAuthorityDecision {
  if (input.runtimeMode === 'legacy') {
    return allow('legacy', 'Legacy runtime preserves existing tool behavior.');
  }

  if (input.toolName === 'obsidian') {
    return deny(
      'denied',
      'vnext_obsidian_disabled',
      'Direct Obsidian mutation is disabled in vNext; use source-linked wiki_publish instead.'
    );
  }

  if (FILESYSTEM_WRITE_TOOLS.has(input.toolName)) {
    if (input.actor.kind === 'viewer_admin') {
      return allow('manual', 'Viewer/admin filesystem writes continue to follow viewer policy.');
    }
    return deny(
      'denied',
      'vnext_filesystem_write_denied',
      'vNext agents must not write files directly; workers return proposals and viewers use viewer policy.'
    );
  }

  if (!DURABLE_WRITE_TOOLS.has(input.toolName)) {
    return allow('legacy', 'Tool has no vNext durable-write authority rule.');
  }

  if (input.toolName === 'report_publish') {
    return deny(
      'projection',
      'vnext_report_projection_only',
      'report_publish is not canonical in vNext; dashboard state is served from projections.'
    );
  }

  if (input.toolName === 'delegate') {
    if (input.actor.kind === 'primary_operator') {
      return allow('delegate', 'Primary operator may delegate bounded worker jobs.');
    }
    return deny(
      'denied',
      'vnext_worker_delegation_denied',
      'vNext workers must return proposals instead of delegating.'
    );
  }

  if (input.actor.kind === 'primary_operator') {
    return allow('commit', 'Primary operator owns vNext durable writes.');
  }

  if (
    input.actor.kind === 'viewer_admin' &&
    (input.toolName === 'mama_save' || input.toolName === 'wiki_publish')
  ) {
    return allow('manual', 'Viewer/admin may manually commit source-linked artifacts.');
  }

  if (input.actor.kind === 'worker') {
    return deny(
      'proposal_required',
      'vnext_worker_proposal_required',
      'vNext workers must submit proposals; the primary operator commits durable state.'
    );
  }

  return deny(
    'denied',
    'vnext_commit_authority_denied',
    'vNext durable writes require the primary operator or an explicitly allowed admin path.'
  );
}
