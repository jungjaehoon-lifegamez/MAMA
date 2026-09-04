import { TEMPORAL_WORKORDER_MAX_ATTEMPTS, type WorkOrderRecord } from './task-ledger.js';
import type { TemporalWorkContext } from './temporal-effect.js';

export interface TemporalWorkerPayload {
  generationKey: string;
  taskId: number;
  temporalEpoch: number;
  occurrenceKey: string;
  checkAt: number;
  sourceChannel: string | null;
  sourceEventId: string | null;
  attempts: number;
}

const TEMPORAL_PAYLOAD_KEYS = new Set<keyof TemporalWorkerPayload>([
  'generationKey',
  'taskId',
  'temporalEpoch',
  'occurrenceKey',
  'checkAt',
  'sourceChannel',
  'sourceEventId',
  'attempts',
]);

export function parseTemporalWorkerPayload(value: unknown): TemporalWorkerPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('temporal worker payload must be an object');
  }
  const payload = value as Record<string, unknown>;
  for (const key of Object.keys(payload)) {
    if (!TEMPORAL_PAYLOAD_KEYS.has(key as keyof TemporalWorkerPayload)) {
      throw new Error(`temporal worker payload: unknown field '${key}'`);
    }
  }
  const generationKey = boundedString(payload.generationKey, 'generationKey', 500);
  const occurrenceKey = boundedString(payload.occurrenceKey, 'occurrenceKey', 300);
  const taskId = boundedInteger(payload.taskId, 'taskId', 1);
  const temporalEpoch = boundedInteger(payload.temporalEpoch, 'temporalEpoch', 0);
  const checkAt = boundedInteger(payload.checkAt, 'checkAt');
  const attempts = boundedInteger(payload.attempts, 'attempts', 1);
  if (attempts > TEMPORAL_WORKORDER_MAX_ATTEMPTS) {
    throw new Error(
      `temporal worker payload: attempts must be 1-${TEMPORAL_WORKORDER_MAX_ATTEMPTS}`
    );
  }
  return {
    generationKey,
    taskId,
    temporalEpoch,
    occurrenceKey,
    checkAt,
    sourceChannel: nullableBoundedString(payload.sourceChannel, 'sourceChannel', 300),
    sourceEventId: nullableBoundedString(payload.sourceEventId, 'sourceEventId', 300),
    attempts,
  };
}

export interface TemporalContextSource {
  loadTemporalWorkContext(attemptId: number): TemporalWorkContext;
}

export function buildTemporalWorkerContext(
  source: TemporalContextSource,
  workOrder: WorkOrderRecord
): TemporalWorkContext {
  if (workOrder.workKind !== 'temporal') {
    throw new Error(`temporal worker requires a temporal workorder, got '${workOrder.workKind}'`);
  }
  const payload = parseTemporalWorkerPayload(workOrder.payload);
  const context = source.loadTemporalWorkContext(workOrder.id);
  if (
    context.attemptId !== workOrder.id ||
    context.generationKey !== payload.generationKey ||
    context.taskId !== payload.taskId ||
    context.temporalEpoch !== payload.temporalEpoch ||
    context.occurrenceKey !== payload.occurrenceKey ||
    context.checkAt !== payload.checkAt ||
    context.sourceChannel !== payload.sourceChannel ||
    context.sourceEventId !== payload.sourceEventId
  ) {
    throw new Error(`temporal worker context does not match attempt ${workOrder.id}`);
  }
  return context;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new Error(`temporal worker payload: ${field} must contain 1-${maxLength} characters`);
  }
  return value;
}

function nullableBoundedString(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  return boundedString(value, field, maxLength);
}

function boundedInteger(value: unknown, field: string, minimum?: number): number {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && Number(value) < minimum)) {
    const suffix = minimum === undefined ? '' : ` >= ${minimum}`;
    throw new Error(`temporal worker payload: ${field} must be a safe integer${suffix}`);
  }
  return Number(value);
}
