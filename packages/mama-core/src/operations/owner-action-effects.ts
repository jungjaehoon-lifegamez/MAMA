import { createHash } from 'node:crypto';

export interface OwnerActionContext {
  ownerScope: string;
  occurrenceKey: string;
  modelRunId?: string;
  operationId?: string;
  envelopeHash: string;
  workOrderAttemptId?: number;
}

export interface VerifiedOwnerActionContext {
  ownerScope: string;
  occurrenceKey: string;
  modelRunId: string | null;
  operationId: string | null;
  envelopeHash: string;
  workOrderAttemptId: number | null;
}

export type OwnerActionEffectState = 'transmitting' | 'unknown' | 'confirmed';

export interface OwnerActionPendingEffect {
  actionKey: string;
  effectKind: string;
  state: Exclude<OwnerActionEffectState, 'confirmed'>;
  originModelRunId: string | null;
  originOperationId: string | null;
}

export interface OwnerActionPendingPage {
  items: OwnerActionPendingEffect[];
  nextCursor: { createdAt: number; actionKey: string } | null;
}

export interface OwnerActionEffectStoragePort {
  begin(
    context: OwnerActionContext,
    actionKey: string,
    effectKind: string,
    intent?: Record<string, unknown>
  ): unknown;
  confirm(
    context: OwnerActionContext,
    actionKey: string,
    effectKind: string,
    result: Record<string, unknown> | null
  ): void;
  markUnknown(
    context: OwnerActionContext,
    actionKey: string,
    effectKind: string,
    error: string
  ): void;
  releaseUnstarted(context: OwnerActionContext, actionKey: string, effectKind: string): void;
  pending(
    context: OwnerActionContext,
    options?: { limit?: number; cursor?: { createdAt: number; actionKey: string } }
  ): OwnerActionPendingPage;
}

const IDENTITY_MAX_LENGTH = 512;

export function canonicalizeOwnerActionValue(value: unknown, path = '$'): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`owner action intent ${path} must be a finite number`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`owner action intent ${path} is not JSON-representable (${typeof value})`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeOwnerActionValue(item, `${path}[${index}]`));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`owner action intent ${path} must be a plain JSON object`);
  }
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        canonicalizeOwnerActionValue((value as Record<string, unknown>)[key], `${path}.${key}`),
      ])
  );
}

export function canonicalOwnerActionJson(value: Record<string, unknown>): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error('owner action intent must be a plain JSON object');
  }
  return JSON.stringify(canonicalizeOwnerActionValue(value));
}

export function ownerActionIntentSha256(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalOwnerActionJson(value)).digest('hex');
}

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`owner action ${field} must be a non-blank string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.length > IDENTITY_MAX_LENGTH) {
    throw new Error(
      `owner action ${field} must be a non-blank string without surrounding space and at most ${IDENTITY_MAX_LENGTH} characters`
    );
  }
  return trimmed;
}

function optionalIdentity(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : requireIdentity(value, field);
}

export function verifyOwnerActionContext(context: OwnerActionContext): VerifiedOwnerActionContext {
  if (context === null || typeof context !== 'object') {
    throw new Error('owner action context is required');
  }
  const workOrderAttemptId = context.workOrderAttemptId;
  if (
    workOrderAttemptId !== undefined &&
    (!Number.isSafeInteger(workOrderAttemptId) || workOrderAttemptId <= 0)
  ) {
    throw new Error('owner action workOrderAttemptId must be a positive integer when present');
  }
  const modelRunId = optionalIdentity(context.modelRunId, 'modelRunId');
  const operationId = optionalIdentity(context.operationId, 'operationId');
  if (modelRunId === null && operationId === null) {
    throw new Error('owner action context requires a modelRunId or operationId origin');
  }
  return {
    ownerScope: requireIdentity(context.ownerScope, 'ownerScope'),
    occurrenceKey: requireIdentity(context.occurrenceKey, 'occurrenceKey'),
    modelRunId,
    operationId,
    envelopeHash: requireIdentity(context.envelopeHash, 'envelopeHash'),
    workOrderAttemptId: workOrderAttemptId ?? null,
  };
}

export function ownerActionOriginMatch(context: VerifiedOwnerActionContext): {
  clause: string;
  params: string[];
} {
  if (context.operationId !== null) {
    return { clause: 'origin_operation_id = ?', params: [context.operationId] };
  }
  return {
    clause: '(origin_operation_id IS NULL AND origin_model_run_id = ?)',
    params: [context.modelRunId as string],
  };
}
