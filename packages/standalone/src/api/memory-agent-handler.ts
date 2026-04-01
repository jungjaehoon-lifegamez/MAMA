/**
 * Memory Agent HTTP Handler
 *
 * POST /api/memory-agent/ingest
 * Receives hook events from Claude Code Plugin, validates, and enqueues
 * for batch processing through mama-core ingestConversation.
 */

import type { Request, Response } from 'express';
import type { MemoryAgentQueue } from './memory-agent-queue.js';

export interface MemoryAgentRouteOptions {
  queue: MemoryAgentQueue;
}

/**
 * Create the memory-agent ingest route handler.
 *
 * Expects JSON body:
 *   { messages: ConversationMessage[], scopes?: MemoryScopeRef[], source?: string }
 *
 * Returns 202 Accepted on success (async processing via queue).
 */
export function createMemoryAgentRoute(
  options: MemoryAgentRouteOptions
): (req: Request, res: Response) => Promise<void> {
  const { queue } = options;

  return async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body;

      // Validate messages array
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        res.status(400).json({
          error: 'Missing or empty "messages" array',
          code: 'BAD_REQUEST',
        });
        return;
      }

      // Validate each message has role and content
      for (let i = 0; i < body.messages.length; i++) {
        const msg = body.messages[i];
        if (!msg || typeof msg.role !== 'string' || typeof msg.content !== 'string') {
          res.status(400).json({
            error: `Invalid message at index ${i}: must have "role" (string) and "content" (string)`,
            code: 'BAD_REQUEST',
          });
          return;
        }
      }

      // Validate scope entries if provided
      if (Array.isArray(body.scopes)) {
        for (let i = 0; i < body.scopes.length; i++) {
          const scope = body.scopes[i];
          if (
            !scope ||
            typeof scope !== 'object' ||
            typeof scope.kind !== 'string' ||
            typeof scope.id !== 'string'
          ) {
            res.status(400).json({
              error: `Invalid scope at index ${i}: must have "kind" (string) and "id" (string)`,
              code: 'BAD_REQUEST',
            });
            return;
          }
        }
      }

      const scopes = Array.isArray(body.scopes) ? body.scopes : [];
      const enqueued = queue.enqueue({
        messages: body.messages,
        scopes,
        timestamp: Date.now(),
      });

      res.status(202).json({
        accepted: true,
        queued: enqueued,
        queueSize: queue.size,
      });
    } catch (err) {
      console.error('[memory-agent-handler] unexpected error:', err);
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }
  };
}
