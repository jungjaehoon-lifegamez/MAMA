import { createHash } from 'node:crypto';

import { MEMORY_SCOPE_KINDS, type MemoryScopeRef } from '../memory/types.js';
import type { ContextBoundary, ContextProjectRef, ContextRef } from './types.js';
import { normalizeContextRef, normalizeContextRefs } from './ref.js';

const SCOPE_ORDER: Record<MemoryScopeRef['kind'], number> = {
  project: 0,
  channel: 1,
  user: 2,
  global: 3,
};

type BoundaryCheckInput = {
  boundary: ContextBoundary;
  requestedScopes?: readonly MemoryScopeRef[];
  requestedConnectors?: readonly string[];
  requestedProjectRefs?: readonly ContextProjectRef[];
  requestedTenantId?: string | null;
  seedRefs?: readonly unknown[];
};

function assertScope(scope: MemoryScopeRef): MemoryScopeRef {
  if (!MEMORY_SCOPE_KINDS.includes(scope.kind)) {
    throw new Error(`Unsupported memory scope kind: ${scope.kind}`);
  }
  const id = scope.id.trim();
  if (id.length === 0) {
    throw new Error('Memory scope id must not be empty');
  }
  return { kind: scope.kind, id };
}

function scopeKey(scope: MemoryScopeRef): string {
  return `${scope.kind}\0${scope.id}`;
}

function connectorKey(connector: string): string {
  const trimmed = connector.trim();
  if (trimmed.length === 0) {
    throw new Error('Connector must not be empty');
  }
  return trimmed;
}

function projectKey(project: ContextProjectRef): string {
  const kind = project.kind.trim();
  const id = project.id.trim();
  if (kind.length === 0 || id.length === 0) {
    throw new Error('Project ref kind and id must not be empty');
  }
  return `${kind}\0${id}`;
}

function sortScopes(scopes: MemoryScopeRef[]): MemoryScopeRef[] {
  return [...scopes].sort((left, right) => {
    const orderDiff = SCOPE_ORDER[left.kind] - SCOPE_ORDER[right.kind];
    if (orderDiff !== 0) {
      return orderDiff;
    }
    return left.id.localeCompare(right.id);
  });
}

export function canonicalizeContextScopes(scopes: readonly MemoryScopeRef[] | undefined): {
  scopes: MemoryScopeRef[];
  scopeJson: string;
  scopeHash: string;
} {
  const unique = new Map<string, MemoryScopeRef>();
  for (const scope of scopes ?? []) {
    const normalized = assertScope(scope);
    unique.set(scopeKey(normalized), normalized);
  }
  const canonicalScopes = sortScopes([...unique.values()]);
  const scopeJson = JSON.stringify(canonicalScopes);
  const scopeHash = createHash('sha256').update(scopeJson).digest('hex');
  return {
    scopes: canonicalScopes,
    scopeJson,
    scopeHash,
  };
}

export function derivePrimaryContextScope(scopes: readonly MemoryScopeRef[]): MemoryScopeRef {
  const canonical = canonicalizeContextScopes(scopes).scopes;
  const primary = canonical.find((scope) => scope.kind === 'project') ?? canonical[0];
  return primary ?? { kind: 'global', id: 'default' };
}

export function assertContextBoundaryAllowsInput(input: BoundaryCheckInput): void {
  const boundaryScopes = canonicalizeContextScopes(input.boundary.scopes).scopes;
  const requestedScopes = canonicalizeContextScopes(input.requestedScopes).scopes;
  if (boundaryScopes.length > 0 && requestedScopes.length > 0) {
    const allowed = new Set(boundaryScopes.map(scopeKey));
    const disallowed = requestedScopes.find((scope) => !allowed.has(scopeKey(scope)));
    if (disallowed) {
      throw new Error(
        `Requested scope is outside the context boundary: ${disallowed.kind}:${disallowed.id}`
      );
    }
  }

  const hasConnectorBoundary = Array.isArray(input.boundary.connectors);
  const boundaryConnectors = new Set((input.boundary.connectors ?? []).map(connectorKey));
  const requestedConnectors = (input.requestedConnectors ?? []).map(connectorKey);
  if (hasConnectorBoundary) {
    const disallowedConnector = requestedConnectors.find(
      (connector) => !boundaryConnectors.has(connector)
    );
    if (disallowedConnector) {
      throw new Error(
        `Requested connector is outside the context boundary: ${disallowedConnector}`
      );
    }
  }

  const boundaryProjects = new Set((input.boundary.project_refs ?? []).map(projectKey));
  const requestedProjects = (input.requestedProjectRefs ?? []).map(projectKey);
  if (boundaryProjects.size > 0) {
    const disallowedProject = requestedProjects.find((project) => !boundaryProjects.has(project));
    if (disallowedProject) {
      const [kind, id] = disallowedProject.split('\0');
      throw new Error(`Requested project ref is outside the context boundary: ${kind}:${id}`);
    }
  }

  const boundaryTenantId = input.boundary.tenant_id;
  if (
    typeof boundaryTenantId === 'string' &&
    boundaryTenantId.length > 0 &&
    input.requestedTenantId !== undefined &&
    input.requestedTenantId !== null &&
    input.requestedTenantId !== boundaryTenantId
  ) {
    throw new Error('Requested tenant is outside the context boundary');
  }

  const seedRefs = normalizeContextRefs(input.seedRefs);
  assertSeedRefsAllowed(seedRefs, boundaryConnectors, hasConnectorBoundary);
}

function assertSeedRefsAllowed(
  seedRefs: readonly ContextRef[],
  boundaryConnectors: Set<string>,
  hasConnectorBoundary: boolean
): void {
  for (const ref of seedRefs) {
    if (ref.kind === 'raw' && hasConnectorBoundary && !boundaryConnectors.has(ref.connector)) {
      throw new Error(`Seed raw ref connector is outside the context boundary: ${ref.connector}`);
    }
  }
}

type HiddenValue = Record<string, unknown> & { visible?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectHiddenIdentifiers(value: unknown, hidden: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectHiddenIdentifiers(item, hidden);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const maybeHidden = value as HiddenValue;
  if (maybeHidden.visible === false) {
    for (const field of ['id', 'raw_id', 'source_id', 'channel_id']) {
      const fieldValue = value[field];
      if (typeof fieldValue === 'string' && fieldValue.length > 0) {
        hidden.add(fieldValue);
      }
    }
  }

  for (const child of Object.values(value)) {
    collectHiddenIdentifiers(child, hidden);
  }
}

function sanitizeValue(value: unknown, hidden: Set<string>): unknown {
  if (typeof value === 'string') {
    return [...hidden].some((identifier) => value.includes(identifier)) ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeValue(item, hidden))
      .filter((item): item is Exclude<unknown, undefined> => item !== undefined);
  }
  if (!isRecord(value)) {
    return value;
  }
  if ((value as HiddenValue).visible === false) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = sanitizeValue(child, hidden);
    if (next !== undefined) {
      sanitized[key] = next;
    }
  }
  return sanitized;
}

export function sanitizeContextPacketForVisibility<T>(packet: T): T {
  const hidden = new Set<string>();
  collectHiddenIdentifiers(packet, hidden);
  return sanitizeValue(packet, hidden) as T;
}

export function normalizeSeedRefs(seedRefs: readonly unknown[] | undefined): ContextRef[] {
  return normalizeContextRefs(seedRefs).map((ref) => normalizeContextRef(ref));
}
