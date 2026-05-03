import type { ContextBoundary, ContextProjectRef, ContextRange } from './types.js';
import type { MemoryScopeRef } from '../memory/types.js';

export type ContextBoundaryReadableInput = {
  scopes?: MemoryScopeRef[];
  connectors?: string[];
  project_refs?: ContextProjectRef[];
  tenant_id?: string | null;
  range?: ContextRange;
  as_of?: string | number | null;
};

function parseBoundaryTimeMs(
  value: string | number | null | undefined,
  field: string
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`Invalid context boundary ${field}: ${String(value)}`);
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return Math.floor(numeric);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`Invalid context boundary ${field}: ${String(value)}`);
}

function rangeBoundaryMs(value: unknown, field: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  throw new Error(`Invalid context boundary ${field}: ${String(value)}`);
}

function intersectRange(
  range: ContextRange | undefined,
  boundaryRange: ContextRange | undefined
): ContextRange | undefined {
  if (!boundaryRange) {
    return range;
  }
  const requestedStartMs = rangeBoundaryMs(range?.start_ms, 'range.start_ms');
  const requestedEndMs = rangeBoundaryMs(range?.end_ms, 'range.end_ms');
  const boundaryStartMs = rangeBoundaryMs(boundaryRange.start_ms, 'boundary.range.start_ms');
  const boundaryEndMs = rangeBoundaryMs(boundaryRange.end_ms, 'boundary.range.end_ms');
  const startMs =
    requestedStartMs === null
      ? boundaryStartMs
      : boundaryStartMs === null
        ? requestedStartMs
        : Math.max(requestedStartMs, boundaryStartMs);
  const endMs =
    requestedEndMs === null
      ? boundaryEndMs
      : boundaryEndMs === null
        ? requestedEndMs
        : Math.min(requestedEndMs, boundaryEndMs);
  if (startMs === null && endMs === null) {
    return undefined;
  }
  if (startMs !== null && endMs !== null && startMs > endMs) {
    throw new RangeError(
      `Context boundary range is empty after intersection: start_ms ${startMs} > end_ms ${endMs}`
    );
  }
  return {
    ...(startMs !== null ? { start_ms: startMs } : {}),
    ...(endMs !== null ? { end_ms: endMs } : {}),
  };
}

function clampAsOf(
  requested: string | number | null | undefined,
  boundaryAsOf: string | number | null | undefined
): string | number | null {
  const requestedMs = parseBoundaryTimeMs(requested, 'as_of');
  const boundaryMs = parseBoundaryTimeMs(boundaryAsOf, 'boundary.as_of');
  if (requestedMs === null) {
    return boundaryAsOf ?? null;
  }
  if (boundaryMs === null) {
    return requested ?? null;
  }
  return requestedMs <= boundaryMs ? (requested ?? null) : (boundaryAsOf ?? null);
}

export function applyContextBoundaryReadDefaults<T extends ContextBoundaryReadableInput>(
  input: T,
  boundary: ContextBoundary | undefined
): T {
  if (!boundary) {
    return input;
  }
  const requestedTenantId = input.tenant_id;
  const boundaryTenantId = boundary.tenant_id;
  if (
    requestedTenantId !== undefined &&
    requestedTenantId !== null &&
    boundaryTenantId !== undefined &&
    boundaryTenantId !== null &&
    requestedTenantId !== boundaryTenantId
  ) {
    throw new Error('Requested tenant is outside the context boundary');
  }
  const scopedInput = {
    ...input,
    scopes: input.scopes === undefined ? boundary.scopes : input.scopes,
    connectors: input.connectors === undefined ? boundary.connectors : input.connectors,
    project_refs: input.project_refs === undefined ? boundary.project_refs : input.project_refs,
    range: intersectRange(input.range, boundary.range),
    as_of: clampAsOf(input.as_of, boundary.as_of),
  } as T;

  if (boundaryTenantId !== undefined || requestedTenantId !== undefined) {
    return {
      ...scopedInput,
      tenant_id: boundaryTenantId !== undefined ? boundaryTenantId : requestedTenantId,
    };
  }
  return scopedInput;
}
