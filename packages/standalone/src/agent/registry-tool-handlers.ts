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

export interface RegistryToolResult {
  success: boolean;
  [key: string]: unknown;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
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
  const aliases = (input.aliases ?? []).filter(
    (alias): alias is string => typeof alias === 'string' && alias.trim().length > 0
  );
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
