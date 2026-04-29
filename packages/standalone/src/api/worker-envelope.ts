import type { Request } from 'express';

import type { EnvelopeAuthority } from '../envelope/authority.js';
import type { Envelope, MemoryScope } from '../envelope/types.js';
import { parseEnvelopeExpiresAt } from '../envelope/expiry.js';

export interface WorkerEnvelopeVisibility {
  envelope: Envelope;
  connectors: string[];
  scopes: MemoryScope[];
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
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
