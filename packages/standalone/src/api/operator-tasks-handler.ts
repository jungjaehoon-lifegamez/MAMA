import type { Express, Request, Response } from 'express';
import { requireAuth } from './auth-middleware.js';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskLedger,
  type TaskPriority,
  type TaskRecord,
  type TaskStatus,
  type UpdateTaskInput,
} from '../operator/task-ledger.js';

export interface OperatorTaskRouteDeps {
  getTaskLedger: () => TaskLedger | null;
}

const ALLOWED_PATCH_FIELDS = new Set(['status', 'priority', 'assignee', 'due_date', 'confirmed']);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function serializeTask(task: TaskRecord) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    due_date: task.deadlineIso,
    source_channel: task.sourceChannel,
    latest_event: task.latestEvent,
    auto_created: task.autoCreated,
    confirmed: task.confirmed,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function isValidDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function readStringQuery(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function readLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('limit must be an integer from 1 to 200');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('limit must be an integer from 1 to 200');
  }
  return limit;
}

function validatePatchBody(body: unknown): UpdateTaskInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body must be a non-empty object');
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0) {
    throw new Error('body must be a non-empty object');
  }
  const unknownFields = keys.filter((key) => !ALLOWED_PATCH_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new Error(`unknown fields: ${unknownFields.join(', ')}`);
  }

  const patch: UpdateTaskInput = {};
  if ('status' in input) {
    if (typeof input.status !== 'string' || !TASK_STATUSES.includes(input.status as TaskStatus)) {
      throw new Error(`status must be one of ${TASK_STATUSES.join('|')}`);
    }
    patch.status = input.status as TaskStatus;
  }
  if ('priority' in input) {
    if (
      typeof input.priority !== 'string' ||
      !TASK_PRIORITIES.includes(input.priority as TaskPriority)
    ) {
      throw new Error(`priority must be one of ${TASK_PRIORITIES.join('|')}`);
    }
    patch.priority = input.priority as TaskPriority;
  }
  if ('assignee' in input) {
    if (input.assignee !== null && typeof input.assignee !== 'string') {
      throw new Error('assignee must be a string or null');
    }
    patch.assignee = input.assignee === null ? null : input.assignee.trim();
  }
  if ('due_date' in input) {
    if (input.due_date !== null && typeof input.due_date !== 'string') {
      throw new Error('due_date must be a YYYY-MM-DD date or null');
    }
    if (typeof input.due_date === 'string' && !isValidDate(input.due_date)) {
      throw new Error('due_date must be a real YYYY-MM-DD calendar date or null');
    }
    patch.deadline = input.due_date;
  }
  if ('confirmed' in input) {
    if (typeof input.confirmed !== 'boolean') {
      throw new Error('confirmed must be a boolean');
    }
    patch.confirmed = input.confirmed;
  }
  return patch;
}

function getLedgerOr503(deps: OperatorTaskRouteDeps, res: Response): TaskLedger | null {
  const ledger = deps.getTaskLedger();
  if (!ledger) {
    res.status(503).json({ error: 'task ledger unavailable' });
    return null;
  }
  return ledger;
}

export function registerOperatorTaskRoutes(app: Express, deps: OperatorTaskRouteDeps): void {
  app.get('/api/operator/tasks', requireAuth, (req: Request, res: Response) => {
    const ledger = getLedgerOr503(deps, res);
    if (!ledger) return;

    try {
      const status = readStringQuery(req.query.status, 'status');
      if (status !== undefined && !TASK_STATUSES.includes(status as TaskStatus)) {
        res.status(400).json({
          error: `status must be one of ${TASK_STATUSES.join('|')}`,
        });
        return;
      }
      const sourceChannel = readStringQuery(req.query.source_channel, 'source_channel');
      const limit = readLimit(req.query.limit);
      const tasks = ledger.list({
        status: status as TaskStatus | undefined,
        channel: sourceChannel,
        limit,
        order: 'deadline_priority',
      });
      res.json({ tasks: tasks.map(serializeTask) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch('/api/operator/tasks/:id', requireAuth, (req: Request, res: Response) => {
    const ledger = getLedgerOr503(deps, res);
    if (!ledger) return;

    const rawId = req.params.id;
    if (typeof rawId !== 'string' || !/^[1-9]\d*$/.test(rawId)) {
      res.status(400).json({ error: 'id must be a positive base-10 integer' });
      return;
    }
    const id = Number(rawId);
    if (!Number.isSafeInteger(id)) {
      res.status(400).json({ error: 'id must be a positive base-10 integer' });
      return;
    }
    if (!ledger.getById(id)) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    try {
      const patch = validatePatchBody(req.body);
      const task = ledger.update(id, patch);
      res.json({ ok: true, task: serializeTask(task) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
