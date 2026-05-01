import crypto from 'node:crypto';

import {
  assertContextBoundaryAllowsInput,
  beginModelRunInAdapter,
  canonicalizeContextScopes,
  commitModelRunInAdapter,
  compileContext as defaultCompileContext,
  derivePrimaryContextScope,
  failModelRunInAdapter,
  getModelRunInAdapter,
  insertContextPacket,
  normalizeContextRefs,
  sanitizeContextPacketForVisibility,
  type ContextBoundary,
  type ContextCompileInput,
  type ContextPacket,
  type ContextPacketRecord,
} from '@jungjaehoon/mama-core';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';

import type { Envelope } from '../envelope/types.js';
import { deriveWorkerEnvelopeVisibility, WorkerEnvelopeError } from '../api/worker-envelope.js';

type CoreAdapter = Pick<DatabaseAdapter, 'prepare'>;

export interface ContextCompileStatement {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}

export interface ContextCompileServiceAdapter {
  prepare: (sql: string) => ContextCompileStatement;
  transaction?: <T>(fn: () => T) => T;
}

export type ContextCompileCaller = 'http' | 'gateway' | string;

export interface CompileAndPersistContextRequest {
  caller: ContextCompileCaller;
  envelope: Envelope;
  input: ContextCompileInput;
  modelRunId?: string | null;
  parentModelRunId?: string | null;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface CompileAndPersistContextResult {
  packet: ContextPacket;
  record: ContextPacketRecord;
  modelRunId: string;
  parentModelRunId: string | null;
}

export interface ContextCompileService {
  compileAndPersistContext(
    request: CompileAndPersistContextRequest
  ): Promise<CompileAndPersistContextResult>;
}

export interface ContextCompileServiceOptions {
  memoryAdapter: ContextCompileServiceAdapter;
  compileContext?: typeof defaultCompileContext;
  now?: () => number;
  childModelRunId?: (request: CompileAndPersistContextRequest) => string;
  packetId?: (request: CompileAndPersistContextRequest) => string;
  logger?: {
    error: (...args: unknown[]) => void;
  };
}

export class ContextCompileServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function generatedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function asCoreAdapter(adapter: ContextCompileServiceAdapter): CoreAdapter {
  return adapter as unknown as CoreAdapter;
}

function trimOptional(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function contextCompileInvalid(message: string): ContextCompileServiceError {
  return new ContextCompileServiceError(400, 'context_compile_input_invalid', message);
}

function normalizeCompileScopes(
  scopes: ContextCompileInput['scopes']
): ContextCompileInput['scopes'] {
  if (scopes === undefined) {
    return undefined;
  }
  try {
    return canonicalizeContextScopes(scopes).scopes;
  } catch (error) {
    throw contextCompileInvalid(error instanceof Error ? error.message : String(error));
  }
}

function normalizeCompileStringList(
  values: string[] | undefined,
  field: string
): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw contextCompileInvalid(`${field} must not contain empty values.`);
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }
  return normalized;
}

function normalizeCompileProjectRefs(
  projectRefs: ContextCompileInput['project_refs']
): ContextCompileInput['project_refs'] {
  if (projectRefs === undefined) {
    return undefined;
  }
  const normalized: NonNullable<ContextCompileInput['project_refs']> = [];
  const seen = new Set<string>();
  for (const projectRef of projectRefs) {
    if (projectRef.kind !== 'project') {
      throw contextCompileInvalid('project_refs must contain project refs.');
    }
    const id = projectRef.id.trim();
    if (id.length === 0) {
      throw contextCompileInvalid('project_refs must not contain empty ids.');
    }
    const key = `${projectRef.kind}:${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ kind: projectRef.kind, id });
    }
  }
  return normalized;
}

function normalizeCompileSeedRefs(
  seedRefs: ContextCompileInput['seed_refs']
): ContextCompileInput['seed_refs'] {
  try {
    return normalizeContextRefs(seedRefs);
  } catch (error) {
    throw contextCompileInvalid(error instanceof Error ? error.message : String(error));
  }
}

function normalizeCompileTenantId(
  tenantId: ContextCompileInput['tenant_id']
): ContextCompileInput['tenant_id'] {
  if (tenantId === undefined || tenantId === null) {
    return tenantId;
  }
  const trimmed = tenantId.trim();
  if (trimmed.length === 0) {
    throw contextCompileInvalid('tenant_id must not be empty.');
  }
  return trimmed;
}

function normalizeCompileFilters(
  input: ContextCompileInput
): Pick<ContextCompileInput, 'scopes' | 'connectors' | 'project_refs' | 'seed_refs' | 'tenant_id'> {
  return {
    scopes: normalizeCompileScopes(input.scopes),
    connectors: normalizeCompileStringList(input.connectors, 'connectors'),
    project_refs: normalizeCompileProjectRefs(input.project_refs),
    seed_refs: normalizeCompileSeedRefs(input.seed_refs),
    tenant_id: normalizeCompileTenantId(input.tenant_id),
  };
}

function requiredTask(input: ContextCompileInput): string {
  if (typeof input.task !== 'string' || input.task.trim().length === 0) {
    throw new ContextCompileServiceError(400, 'context_compile_input_invalid', 'task is required.');
  }
  return input.task.trim();
}

function parseAsOfMs(value: string | number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new ContextCompileServiceError(
        400,
        'context_compile_input_invalid',
        `Invalid context_compile ${field}.`
      );
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
  throw new ContextCompileServiceError(
    400,
    'context_compile_input_invalid',
    `Invalid context_compile ${field}.`
  );
}

function clampAsOfToBoundary(
  requested: ContextCompileInput['as_of'],
  boundaryAsOf: ContextBoundary['as_of']
): ContextCompileInput['as_of'] {
  const requestedMs = parseAsOfMs(requested, 'as_of');
  const boundaryMs = parseAsOfMs(boundaryAsOf, 'envelope as_of');
  if (requestedMs === null) {
    return boundaryAsOf ?? null;
  }
  if (boundaryMs === null) {
    return requested ?? null;
  }
  return requestedMs <= boundaryMs ? (requested ?? null) : (boundaryAsOf ?? null);
}

function validateRange(range: ContextCompileInput['range']): void {
  if (range === undefined) {
    return;
  }
  if (range === null || typeof range !== 'object' || Array.isArray(range)) {
    throw new ContextCompileServiceError(
      400,
      'context_compile_input_invalid',
      'Invalid context_compile range.'
    );
  }
  for (const field of ['start_ms', 'end_ms'] as const) {
    const value = range[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new ContextCompileServiceError(
        400,
        'context_compile_input_invalid',
        `Invalid context_compile range.${field}.`
      );
    }
  }
}

function validateStrictness(strictness: ContextCompileInput['strictness']): void {
  if (
    strictness !== undefined &&
    strictness !== 'low' &&
    strictness !== 'medium' &&
    strictness !== 'high'
  ) {
    throw new ContextCompileServiceError(
      400,
      'context_compile_input_invalid',
      'Invalid context_compile strictness.'
    );
  }
}

const NUMERIC_COMPILE_FIELDS = ['limit', 'max_tool_calls', 'max_ms', 'max_tokens'] as const;
type NumericCompileField = (typeof NUMERIC_COMPILE_FIELDS)[number];

function normalizeNumericCompileField(
  input: ContextCompileInput,
  field: NumericCompileField
): number | undefined {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContextCompileServiceError(
      400,
      'context_compile_input_invalid',
      `Invalid context_compile ${field}.`
    );
  }
  const max = field === 'limit' ? 100 : Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

function normalizeNumericCompileOptions(
  input: ContextCompileInput
): Partial<Pick<ContextCompileInput, NumericCompileField>> {
  const normalized: Partial<Pick<ContextCompileInput, NumericCompileField>> = {};
  for (const field of NUMERIC_COMPILE_FIELDS) {
    const value = normalizeNumericCompileField(input, field);
    if (value !== undefined) {
      normalized[field] = value;
    }
  }
  return normalized;
}

function validateParentModelRun(
  adapter: CoreAdapter,
  modelRunId: string,
  envelope: Envelope
): void {
  const modelRun = getModelRunInAdapter(adapter, modelRunId);
  if (!modelRun) {
    throw new ContextCompileServiceError(
      404,
      'context_compile_parent_model_run_not_found',
      'The supplied parent model run was not found.'
    );
  }
  if (
    modelRun.envelope_hash !== envelope.envelope_hash ||
    modelRun.agent_id !== envelope.agent_id ||
    modelRun.instance_id !== envelope.instance_id
  ) {
    throw new ContextCompileServiceError(
      403,
      'context_compile_parent_model_run_denied',
      'The supplied parent model run is outside the worker envelope.'
    );
  }
  if (modelRun.status !== 'running') {
    throw new ContextCompileServiceError(
      409,
      'context_compile_parent_model_run_not_running',
      'The supplied parent model run is no longer running.'
    );
  }
}

function validateProjectRefs(input: {
  requested: NonNullable<ContextCompileInput['project_refs']>;
  allowed: NonNullable<ContextBoundary['project_refs']>;
}): void {
  if (input.allowed.length === 0) {
    if (input.requested.length === 0) {
      return;
    }
    throw new ContextCompileServiceError(
      403,
      'context_compile_project_ref_denied',
      'Requested project refs are outside the worker envelope.'
    );
  }

  const allowed = new Set(input.allowed.map((project) => `${project.kind}:${project.id}`));
  for (const project of input.requested) {
    if (!allowed.has(`${project.kind}:${project.id}`)) {
      throw new ContextCompileServiceError(
        403,
        'context_compile_project_ref_denied',
        `Project ${project.kind}:${project.id} is outside the worker envelope.`
      );
    }
  }
}

function validateTenant(input: { requested: string | null; allowed: string }): void {
  if (input.requested !== null && input.requested !== input.allowed) {
    throw new ContextCompileServiceError(
      403,
      'context_compile_tenant_denied',
      'Requested tenant is outside the worker envelope.'
    );
  }
}

function coerceCompileInput(
  request: CompileAndPersistContextRequest,
  boundary: ContextBoundary
): ContextCompileInput {
  const requestFilters = normalizeCompileFilters(request.input);
  const normalizedScopes = normalizeCompileScopes(requestFilters.scopes ?? boundary.scopes);
  const normalizedConnectors = normalizeCompileStringList(
    requestFilters.connectors ?? boundary.connectors,
    'connectors'
  );
  const normalizedProjectRefs = normalizeCompileProjectRefs(
    requestFilters.project_refs ?? boundary.project_refs
  );
  const normalizedTenantId = requestFilters.tenant_id ?? boundary.tenant_id ?? 'default';
  const normalizedSeedRefs = requestFilters.seed_refs ?? [];
  try {
    assertContextBoundaryAllowsInput({
      boundary,
      requestedScopes: normalizedScopes,
      requestedConnectors: normalizedConnectors,
      requestedProjectRefs: normalizedProjectRefs,
      requestedTenantId: normalizedTenantId,
      seedRefs: normalizedSeedRefs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ContextCompileServiceError(400, 'context_compile_input_invalid', message);
  }

  const task = requiredTask(request.input);
  validateRange(request.input.range);
  validateStrictness(request.input.strictness);
  const numericOptions = normalizeNumericCompileOptions(request.input);
  return {
    ...request.input,
    ...numericOptions,
    task,
    scopes: normalizedScopes,
    connectors: normalizedConnectors,
    project_refs: normalizedProjectRefs,
    seed_refs: normalizedSeedRefs,
    tenant_id: normalizedTenantId,
    as_of: clampAsOfToBoundary(request.input.as_of, boundary.as_of),
  };
}

function packetWithServiceIdentity(packet: ContextPacket, packetId: string): ContextPacket {
  const canonicalScopes = canonicalizeContextScopes(packet.scopes);
  return {
    ...packet,
    packet_id: packetId,
    scopes: canonicalScopes.scopes,
    scope_hash: canonicalScopes.scopeHash,
  };
}

function buildPacketRecord(input: {
  packet: ContextPacket;
  envelope: Envelope;
  modelRunId: string;
  createdAt: number;
  tenantId: string;
  projectId?: string | null;
  inputSnapshotRef: string;
}): ContextPacketRecord {
  const canonicalScopes = canonicalizeContextScopes(input.packet.scopes);
  const primaryScope = derivePrimaryContextScope(canonicalScopes.scopes);
  const packetJson = JSON.stringify(input.packet);
  const sourceRefsJson = JSON.stringify(input.packet.source_refs);
  return {
    packet_id: input.packet.packet_id,
    task: input.packet.task,
    packet_json: packetJson,
    packet: input.packet,
    scope_json: canonicalScopes.scopeJson,
    scopes: canonicalScopes.scopes,
    scope_hash: canonicalScopes.scopeHash,
    envelope_hash: input.envelope.envelope_hash,
    model_run_id: input.modelRunId,
    agent_id: input.envelope.agent_id,
    input_snapshot_ref: input.inputSnapshotRef,
    source_refs_json: sourceRefsJson,
    source_refs: input.packet.source_refs,
    tenant_id: input.tenantId,
    project_id: input.projectId ?? '',
    memory_scope_kind: primaryScope.kind,
    memory_scope_id: primaryScope.id,
    created_at: input.createdAt,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failRunningChild(
  adapter: CoreAdapter,
  modelRunId: string,
  reason: string,
  logger?: ContextCompileServiceOptions['logger']
): void {
  try {
    const current = getModelRunInAdapter(adapter, modelRunId);
    if (!current || current.status !== 'running') {
      return;
    }
    failModelRunInAdapter(adapter, modelRunId, reason);
  } catch (error) {
    logger?.error('Failed to mark context_compile model run as failed:', error);
  }
}

export function createContextCompileService(
  options: ContextCompileServiceOptions
): ContextCompileService {
  const adapter = asCoreAdapter(options.memoryAdapter);
  const compileContext = options.compileContext ?? defaultCompileContext;
  const now = options.now ?? Date.now;

  return {
    async compileAndPersistContext(
      request: CompileAndPersistContextRequest
    ): Promise<CompileAndPersistContextResult> {
      const parentModelRunId =
        trimOptional(request.modelRunId) ?? trimOptional(request.parentModelRunId);
      if (parentModelRunId) {
        validateParentModelRun(adapter, parentModelRunId, request.envelope);
      }

      const envelopeVisibility = deriveWorkerEnvelopeVisibility(request.envelope, {});
      const requestFilters = normalizeCompileFilters(request.input);
      deriveWorkerEnvelopeVisibility(request.envelope, {
        scopes: requestFilters.scopes,
        connectors: requestFilters.connectors,
      });
      const requestedProjectRefs = requestFilters.project_refs ?? envelopeVisibility.projectRefs;
      validateProjectRefs({
        requested: requestedProjectRefs,
        allowed: envelopeVisibility.projectRefs,
      });
      validateTenant({
        requested: requestFilters.tenant_id ?? null,
        allowed: envelopeVisibility.tenantId,
      });

      const boundary: ContextBoundary = {
        scopes: envelopeVisibility.scopes,
        connectors: envelopeVisibility.connectors,
        project_refs: envelopeVisibility.projectRefs,
        tenant_id: envelopeVisibility.tenantId,
        as_of: request.envelope.scope.as_of ?? null,
      };
      const compileInput = coerceCompileInput(request, boundary);
      const packetId = options.packetId?.(request) ?? generatedId('ctxp');
      const modelRunId = options.childModelRunId?.(request) ?? generatedId('mr');
      const inputSnapshotRef = `context_compile:${packetId}`;

      beginModelRunInAdapter(adapter, {
        model_run_id: modelRunId,
        agent_id: request.envelope.agent_id,
        instance_id: request.envelope.instance_id,
        envelope_hash: request.envelope.envelope_hash,
        parent_model_run_id: parentModelRunId ?? undefined,
        input_snapshot_ref: inputSnapshotRef,
        input_refs: {
          tool: 'context_compile',
          caller: request.caller,
          packet_id: packetId,
          parent_model_run_id: parentModelRunId,
          task: compileInput.task,
          scopes: compileInput.scopes,
          connectors: compileInput.connectors,
          project_refs: compileInput.project_refs,
          tenant_id: compileInput.tenant_id,
          seed_refs: compileInput.seed_refs ?? [],
          range: compileInput.range ?? null,
          as_of: compileInput.as_of ?? null,
        },
        created_at: now(),
      });

      let inserted = false;
      try {
        const compiled = await compileContext(compileInput, {
          adapter,
          boundary,
          deadlineMs: request.deadlineMs,
          signal: request.signal,
          now,
          packetId: () => packetId,
        });
        const packet = sanitizeContextPacketForVisibility(
          packetWithServiceIdentity(compiled, packetId)
        );
        const projectId =
          requestedProjectRefs.find((project) => project.kind === 'project')?.id ?? null;
        const record = insertContextPacket(
          adapter,
          buildPacketRecord({
            packet,
            envelope: request.envelope,
            modelRunId,
            createdAt: now(),
            tenantId: envelopeVisibility.tenantId,
            projectId,
            inputSnapshotRef,
          })
        );
        inserted = true;
        try {
          commitModelRunInAdapter(adapter, modelRunId, `context_compile packet ${packetId}`);
        } catch (error) {
          failRunningChild(adapter, modelRunId, getErrorMessage(error), options.logger);
          throw error;
        }
        return {
          packet: record.packet,
          record,
          modelRunId,
          parentModelRunId: parentModelRunId ?? null,
        };
      } catch (error) {
        if (!inserted) {
          failRunningChild(adapter, modelRunId, getErrorMessage(error), options.logger);
        }
        if (error instanceof WorkerEnvelopeError || error instanceof ContextCompileServiceError) {
          throw error;
        }
        throw error;
      }
    },
  };
}
