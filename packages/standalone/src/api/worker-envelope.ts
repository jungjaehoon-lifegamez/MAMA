import type { Request } from 'express';

import type { EnvelopeAuthority } from '../envelope/authority.js';
import type { Envelope, MemoryScope, ProjectRef } from '../envelope/types.js';
import { parseEnvelopeExpiresAt } from '../envelope/expiry.js';

export interface WorkerEnvelopeVisibility {
  envelope: Envelope;
  connectors: string[];
  scopes: MemoryScope[];
  projectRefs: ProjectRef[];
  tenantId: string;
}

export class WorkerEnvelopeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function loadWorkerEnvelope(
  req: Request,
  authority: EnvelopeAuthority | undefined
): Envelope {
  if (!authority) {
    throw new WorkerEnvelopeError(
      503,
      'worker_envelope_unavailable',
      'Worker envelope authority is unavailable.'
    );
  }

  const envelopeHash = req.header('x-mama-envelope-hash')?.trim();
  if (!envelopeHash) {
    throw new WorkerEnvelopeError(
      401,
      'worker_envelope_missing',
      'x-mama-envelope-hash is required.'
    );
  }

  let envelope: Envelope | undefined;
  try {
    envelope = authority.loadVerified(envelopeHash);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkerEnvelopeError(
      403,
      'worker_envelope_invalid',
      `Worker envelope could not be verified: ${message}`
    );
  }

  if (!envelope) {
    throw new WorkerEnvelopeError(403, 'worker_envelope_invalid', 'Worker envelope was not found.');
  }

  let expiresMs: number;
  try {
    expiresMs = parseEnvelopeExpiresAt(envelope.expires_at);
  } catch {
    throw new WorkerEnvelopeError(403, 'worker_envelope_expired', 'Worker envelope is expired.');
  }
  if (expiresMs <= Date.now()) {
    throw new WorkerEnvelopeError(403, 'worker_envelope_expired', 'Worker envelope is expired.');
  }

  return envelope;
}

export function deriveWorkerEnvelopeVisibility(
  envelope: Envelope,
  requested: {
    connectors?: string[];
    scopes?: MemoryScope[];
  }
): WorkerEnvelopeVisibility {
  const envelopeConnectors = uniqueStrings(envelope.scope.raw_connectors);
  const requestedConnectors = requested.connectors
    ? uniqueStrings(requested.connectors)
    : envelopeConnectors;

  for (const connector of requestedConnectors) {
    if (!envelopeConnectors.includes(connector)) {
      throw new WorkerEnvelopeError(
        403,
        'worker_envelope_connector_denied',
        `Connector ${connector} is outside the worker envelope.`
      );
    }
  }

  const envelopeScopes = envelope.scope.memory_scopes;
  const requestedScopes = requested.scopes ?? envelopeScopes;
  for (const scope of requestedScopes) {
    if (!envelopeScopes.some((allowed) => allowed.kind === scope.kind && allowed.id === scope.id)) {
      throw new WorkerEnvelopeError(
        403,
        'worker_envelope_scope_denied',
        `Scope ${scope.kind}:${scope.id} is outside the worker envelope.`
      );
    }
  }

  return {
    envelope,
    connectors: requestedConnectors,
    scopes: requestedScopes,
    projectRefs: deriveEffectiveProjectRefs(envelope),
    tenantId: deriveEffectiveTenantId(),
  };
}

export function deriveEffectiveProjectRefs(envelope: Envelope): ProjectRef[] {
  return envelope.scope.project_refs
    .map((project) => ({ kind: project.kind, id: project.id.trim() }))
    .filter((project) => project.id.length > 0);
}

export function deriveEffectiveTenantId(): string {
  return 'default';
}

export function parseRequestedConnectors(req: Request): string[] | undefined {
  const connectorValues = [
    ...stringValues(req.query.connector),
    ...stringValues(req.query.connectors).flatMap((value) => value.split(',')),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return connectorValues.length > 0 ? uniqueStrings(connectorValues) : undefined;
}

export function parseRequestedScopes(req: Request): MemoryScope[] | undefined {
  const rawValues = stringValues(req.query.scope).concat(stringValues(req.query.scopes));
  if (rawValues.length === 0) {
    const kind = firstString(req.query.scope_kind);
    const id = firstString(req.query.scope_id);
    return kind && id ? [{ kind: parseScopeKind(kind), id }] : undefined;
  }

  const scopes: MemoryScope[] = [];
  for (const rawValue of rawValues) {
    const pieces = rawValue.trim().startsWith('[')
      ? parseJsonScopes(rawValue)
      : rawValue
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
    for (const piece of pieces) {
      const [kind, ...idParts] = piece.split(':');
      const id = idParts.join(':');
      if (kind && id) {
        scopes.push({ kind: parseScopeKind(kind), id });
      }
    }
  }
  return scopes.length > 0 ? scopes : undefined;
}

export function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseJsonScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('expected array');
    }
    return parsed.map((scope) => {
      if (
        scope === null ||
        typeof scope !== 'object' ||
        typeof (scope as Record<string, unknown>).kind !== 'string' ||
        typeof (scope as Record<string, unknown>).id !== 'string'
      ) {
        throw new Error('expected {kind,id} objects');
      }
      return `${(scope as { kind: string }).kind}:${(scope as { id: string }).id}`;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkerEnvelopeError(400, 'worker_scope_invalid', `Invalid scopes JSON: ${message}`);
  }
}

function parseScopeKind(value: string): MemoryScope['kind'] {
  if (value === 'global' || value === 'user' || value === 'channel' || value === 'project') {
    return value;
  }
  throw new WorkerEnvelopeError(400, 'worker_scope_invalid', `Invalid scope kind: ${value}`);
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return typeof value === 'string' ? [value] : [];
}
