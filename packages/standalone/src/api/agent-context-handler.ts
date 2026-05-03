import express, { type Request, type Response, type Router } from 'express';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import {
  MEMORY_SCOPE_KINDS,
  normalizeContextRefs,
  type ContextCompileInput,
} from '@jungjaehoon/mama-core';

import type { EnvelopeAuthority } from '../envelope/authority.js';
import {
  ContextCompileServiceError,
  createContextCompileService,
  type ContextCompileService,
  type ContextCompileServiceAdapter,
} from '../agent/context-compile-service.js';
import { firstString, loadWorkerEnvelope, WorkerEnvelopeError } from './worker-envelope.js';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    error: (...args: unknown[]) => void;
  };
};

const contextApiLogger = new DebugLogger('AgentContextAPI');
const MEMORY_SCOPE_KIND_SET = new Set<string>(MEMORY_SCOPE_KINDS);

export interface AgentContextRouterOptions {
  memoryAdapter: ContextCompileServiceAdapter;
  envelopeAuthority?: EnvelopeAuthority;
  contextCompileService?: ContextCompileService;
}

export function createAgentContextRouter(options: AgentContextRouterOptions): Router {
  const router = express.Router();
  const service =
    options.contextCompileService ??
    createContextCompileService({
      memoryAdapter: options.memoryAdapter,
      logger: contextApiLogger,
    });

  router.post('/compile', async (req, res) => {
    await handleContextCompileRequest(req, res, options, service);
  });

  return router;
}

async function handleContextCompileRequest(
  req: Request,
  res: Response,
  options: AgentContextRouterOptions,
  service: ContextCompileService
): Promise<void> {
  try {
    const envelope = loadWorkerEnvelope(req, options.envelopeAuthority);
    if (envelope.tier === 3) {
      throw new ContextCompileServiceError(
        403,
        'context_compile_tier_denied',
        'context_compile is not allowed for Tier 3 agents.'
      );
    }
    const input = parseContextCompileInput(req.body);
    const modelRunId = firstString(req.header('x-mama-model-run-id'))?.trim();
    const result = await service.compileAndPersistContext({
      caller: 'http',
      envelope,
      modelRunId,
      input,
    });
    res.json({ packet: result.packet });
  } catch (error) {
    sendContextError(res, error);
  }
}

function parseContextCompileInput(body: unknown): ContextCompileInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ContextCompileServiceError(
      400,
      'context_compile_input_invalid',
      'Request body must be a JSON object.'
    );
  }
  const input = body as Record<string, unknown>;
  validateStringArrayField(input, 'connectors');
  validateScopeArrayField(input);
  validateProjectRefArrayField(input);
  validateSeedRefsField(input);
  validateRangeField(input);
  validateStrictnessField(input);
  validateNumericCompileFields(input);
  return body as ContextCompileInput;
}

function validateStringArrayField(input: Record<string, unknown>, field: string): void {
  const value = input[field];
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throwInvalidInput(`${field} must be an array.`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throwInvalidInput(`${field} must contain only strings.`);
    }
  }
}

function validateScopeArrayField(input: Record<string, unknown>): void {
  const value = input.scopes;
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throwInvalidInput('scopes must be an array.');
  }
  for (const scope of value) {
    if (!isRecord(scope) || typeof scope.kind !== 'string' || typeof scope.id !== 'string') {
      throwInvalidInput('scopes must contain { kind, id } objects.');
    }
    if (!MEMORY_SCOPE_KIND_SET.has(scope.kind)) {
      throwInvalidInput(`Invalid scope kind: ${scope.kind}`);
    }
  }
}

function validateProjectRefArrayField(input: Record<string, unknown>): void {
  const value = input.project_refs;
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throwInvalidInput('project_refs must be an array.');
  }
  for (const projectRef of value) {
    if (
      !isRecord(projectRef) ||
      projectRef.kind !== 'project' ||
      typeof projectRef.id !== 'string'
    ) {
      throwInvalidInput('project_refs must contain { kind: "project", id } objects.');
    }
  }
}

function validateSeedRefsField(input: Record<string, unknown>): void {
  const value = input.seed_refs;
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throwInvalidInput('seed_refs must be an array.');
  }
  try {
    normalizeContextRefs(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throwInvalidInput(message);
  }
}

function validateRangeField(input: Record<string, unknown>): void {
  const value = input.range;
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throwInvalidInput('range must be an object.');
  }
  for (const field of ['start_ms', 'end_ms'] as const) {
    const boundary = value[field];
    if (boundary !== undefined && (typeof boundary !== 'number' || !Number.isFinite(boundary))) {
      throwInvalidInput(`range.${field} must be a finite number.`);
    }
  }
}

function validateStrictnessField(input: Record<string, unknown>): void {
  const value = input.strictness;
  if (value === undefined) {
    return;
  }
  if (
    value !== 'recall' &&
    value !== 'balanced' &&
    value !== 'strict' &&
    value !== 'low' &&
    value !== 'medium' &&
    value !== 'high'
  ) {
    throwInvalidInput('strictness must be one of recall, balanced, or strict.');
  }
}

function validateNumericCompileFields(input: Record<string, unknown>): void {
  for (const field of ['limit', 'max_tool_calls', 'max_ms', 'max_tokens'] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throwInvalidInput(`${field} must be a finite number.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function throwInvalidInput(message: string): never {
  throw new ContextCompileServiceError(400, 'context_compile_input_invalid', message);
}

function sendContextError(res: Response, error: unknown): void {
  if (error instanceof WorkerEnvelopeError || error instanceof ContextCompileServiceError) {
    res.status(error.status).json({
      error: true,
      code: error.code,
      message: error.message,
    });
    return;
  }

  contextApiLogger.error('Unexpected agent context API error:', error);
  res.status(500).json({
    error: true,
    code: 'agent_context_api_error',
    message: 'Internal server error',
  });
}
