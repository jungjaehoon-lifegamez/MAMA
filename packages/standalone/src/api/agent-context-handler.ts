import express, { type Request, type Response, type Router } from 'express';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import type { ContextCompileInput } from '@jungjaehoon/mama-core';

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
  return body as ContextCompileInput;
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
