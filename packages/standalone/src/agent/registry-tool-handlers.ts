/**
 * Registry tools: how the agent asks "what do I already know this by" and records what it
 * decided identity is.
 *
 * The split matters. `registry_lookup` answers from what is stored and says plainly when
 * nothing is registered, so the agent creates a node instead of inventing a spelling that
 * only this turn will use. `registry_upsert` records the agent's decision, and stops at the
 * one thing a tool must not decide: when an alias already belongs to another node, it
 * returns the conflict rather than moving identity out from under existing records. Merging
 * two nodes is a separate, owner-confirmed act.
 */

export interface RegistryNodeView {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  mergedInto: string | null;
}

/** The slice of the core registry these handlers need; the executor supplies the real one. */
export interface RegistryPort {
  resolveAlias(
    alias: string,
    kind?: string,
    scopes?: readonly RegistryScopeRef[]
  ): RegistryNodeView | null;
  createNode(input: {
    kind: string;
    name: string;
    aliases?: readonly string[];
    parentId?: string | null;
    note?: string | null;
    scopes?: readonly RegistryScopeRef[];
  }): string;
  addAlias(nodeId: string, alias: string): void;
  upsertNode(input: {
    kind: string;
    name: string;
    aliases?: readonly string[];
    note?: string | null;
    scopes?: readonly RegistryScopeRef[];
    children?: ReadonlyArray<{ name: string; aliases?: readonly string[] }>;
  }): { id: string; created: boolean; children: string[] };
  listNodes(filter?: {
    kind?: string;
    parentId?: string | null;
    scopes?: readonly RegistryScopeRef[];
  }): RegistryNodeView[];
  mergeNodes(input: { loser: string; survivor: string; reason: string }): void;
  splitNode(input: {
    parent: string;
    children: ReadonlyArray<{ name: string; aliases?: readonly string[] }>;
    reason: string;
  }): string[];
  appendIdentityCorrection(
    correction: RegistryCorrectionCommand,
    trusted: RegistryCorrectionAuthority
  ): RegistryCorrectionReceiptView;
}

export interface RegistryScopeRef {
  kind: 'global' | 'user' | 'channel' | 'project';
  id: string;
}

export interface RegistryLookupInput {
  name?: string;
  kind?: string;
}

export interface RegistryUpsertInput {
  kind?: string;
  name?: string;
  aliases?: readonly string[];
  parent_of?: ReadonlyArray<{ name: string; aliases?: readonly string[] }>;
  note?: string;
}

export interface RegistryCorrectionAuthority {
  principalId: string;
  agentId: string;
  scopes: readonly RegistryScopeRef[];
  connectors: readonly string[];
  channels?: Readonly<Record<string, readonly string[]>>;
}

export interface RegistryCorrectionReceiptView {
  commandId: string;
  identityRevision: number;
  children: Array<{ clientKey: string; ref: { kind: 'registry'; id: string } }>;
  changedSlots: Array<{ edgeId: string; endpoint: 'from' | 'to' }>;
  unresolved: Array<{ edgeId: string; endpoint: 'from' | 'to' }>;
}

export interface RegistryCorrectionInput {
  command_id?: string;
  expected_revision?: number;
  reason?: string;
  operation?: 'add_alias' | 'merge' | 'split' | 'assign_refs';
  node_id?: string;
  alias?: string;
  survivor_id?: string;
  member_ids?: readonly string[];
  parent_id?: string;
  children?: ReadonlyArray<{ client_key?: string; name: string; aliases?: readonly string[] }>;
  assignments?: ReadonlyArray<{
    edge_id: string;
    endpoint: 'from' | 'to';
    target_node_id?: string | null;
    target_client_key?: string;
  }>;
  evidence?: ReadonlyArray<{ kind: 'observation'; id: string }>;
  scopes?: readonly RegistryScopeRef[];
}

export type RegistryCorrectionCommand =
  | {
      commandId: string;
      expectedRevision: number;
      reason: string;
      operation: 'add_alias';
      nodeId: string;
      alias: string;
      scopes: readonly RegistryScopeRef[];
      evidence?: ReadonlyArray<{ kind: 'observation'; id: string }>;
    }
  | {
      commandId: string;
      expectedRevision: number;
      reason: string;
      operation: 'merge';
      survivorId: string;
      memberIds: readonly string[];
      scopes: readonly RegistryScopeRef[];
      evidence?: ReadonlyArray<{ kind: 'observation'; id: string }>;
    }
  | {
      commandId: string;
      expectedRevision: number;
      reason: string;
      operation: 'split';
      parentId: string;
      children: ReadonlyArray<{ clientKey?: string; name: string; aliases?: readonly string[] }>;
      assignments: ReadonlyArray<{
        edgeId: string;
        endpoint: 'from' | 'to';
        targetNodeId?: string | null;
        targetClientKey?: string;
      }>;
      scopes: readonly RegistryScopeRef[];
      evidence?: ReadonlyArray<{ kind: 'observation'; id: string }>;
    }
  | {
      commandId: string;
      expectedRevision: number;
      reason: string;
      operation: 'assign_refs';
      parentId: string;
      assignments: ReadonlyArray<{
        edgeId: string;
        endpoint: 'from' | 'to';
        targetNodeId?: string | null;
        targetClientKey?: string;
      }>;
      scopes: readonly RegistryScopeRef[];
      evidence?: ReadonlyArray<{ kind: 'observation'; id: string }>;
    };

export interface RegistryToolResult {
  success: boolean;
  [key: string]: unknown;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleRegistryLookup(
  registry: RegistryPort,
  input: RegistryLookupInput,
  scopes?: readonly RegistryScopeRef[]
): Promise<RegistryToolResult> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    return { success: false, code: 'missing_name', error: 'registry_lookup requires a name' };
  }
  try {
    const node = registry.resolveAlias(name, input.kind, scopes);
    if (!node) {
      // An explicit "nothing registered" beats an empty list: it tells the agent the next
      // move is registry_upsert, not a broader search for a spelling that is not stored.
      return { success: true, found: false, name, kind: input.kind ?? null };
    }
    const children = registry.listNodes({ kind: node.kind, parentId: node.id, scopes });
    return {
      success: true,
      found: true,
      node: {
        id: node.id,
        kind: node.kind,
        name: node.name,
        parentId: node.parentId,
        children: children.map((child) => ({ id: child.id, name: child.name })),
      },
    };
  } catch (error) {
    return { success: false, code: errorCode(error) ?? 'registry_error', error: message(error) };
  }
}

export async function handleRegistryUpsert(
  registry: RegistryPort,
  input: RegistryUpsertInput,
  scopes?: readonly RegistryScopeRef[]
): Promise<RegistryToolResult> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  if (!name || !kind) {
    return {
      success: false,
      code: 'missing_field',
      error: 'registry_upsert requires kind and name',
    };
  }
  if (
    input.aliases !== undefined &&
    (!Array.isArray(input.aliases) ||
      input.aliases.some((alias) => typeof alias !== 'string' || !alias.trim()))
  ) {
    return { success: false, code: 'invalid_alias', error: 'aliases must be nonblank strings' };
  }
  const aliases = input.aliases ?? [];
  try {
    const result = registry.upsertNode({
      kind,
      name,
      aliases,
      note: typeof input.note === 'string' ? input.note : null,
      scopes,
      children: input.parent_of,
    });
    return {
      success: true,
      id: result.id,
      created: result.created,
      name,
      children: result.children,
      added: aliases,
    };
  } catch (error) {
    return { success: false, code: errorCode(error) ?? 'registry_error', error: message(error) };
  }
}

export async function handleRegistryCorrect(
  registry: RegistryPort,
  input: RegistryCorrectionInput,
  trusted: RegistryCorrectionAuthority
): Promise<RegistryToolResult> {
  const commandId = typeof input.command_id === 'string' ? input.command_id.trim() : '';
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!commandId || !reason || !Number.isSafeInteger(input.expected_revision)) {
    return {
      success: false,
      code: 'invalid_correction',
      error: 'registry_correct requires command_id, expected_revision, operation, and reason',
    };
  }
  const common = {
    commandId,
    expectedRevision: input.expected_revision as number,
    reason,
    scopes: input.scopes ?? trusted.scopes,
    evidence: input.evidence,
  };
  let command: RegistryCorrectionCommand;
  if (input.operation === 'add_alias') {
    command = {
      ...common,
      operation: input.operation,
      nodeId: input.node_id ?? '',
      alias: input.alias ?? '',
    };
  } else if (input.operation === 'merge') {
    command = {
      ...common,
      operation: input.operation,
      survivorId: input.survivor_id ?? '',
      memberIds: input.member_ids ?? [],
    };
  } else if (input.operation === 'split') {
    command = {
      ...common,
      operation: input.operation,
      parentId: input.parent_id ?? '',
      children: (input.children ?? []).map((child) => ({
        clientKey: child.client_key,
        name: child.name,
        aliases: child.aliases,
      })),
      assignments: (input.assignments ?? []).map((assignment) => ({
        edgeId: assignment.edge_id,
        endpoint: assignment.endpoint,
        ...(assignment.target_client_key === undefined
          ? { targetNodeId: assignment.target_node_id }
          : { targetClientKey: assignment.target_client_key }),
      })),
    };
  } else if (input.operation === 'assign_refs') {
    command = {
      ...common,
      operation: input.operation,
      parentId: input.parent_id ?? '',
      assignments: (input.assignments ?? []).map((assignment) => ({
        edgeId: assignment.edge_id,
        endpoint: assignment.endpoint,
        targetNodeId: assignment.target_node_id,
      })),
    };
  } else {
    return { success: false, code: 'invalid_correction', error: 'Unknown correction operation' };
  }
  try {
    return { success: true, ...registry.appendIdentityCorrection(command, trusted) };
  } catch (error) {
    return { success: false, code: errorCode(error) ?? 'registry_error', error: message(error) };
  }
}
