/**
 * /api/operator -- read-mostly operator surface for the /ui board.
 *
 * Reads the trigger loop's own store (~/.mama/operator/triggers.db by default)
 * through a second in-process connection. triggers.db uses the default rollback
 * journal (TriggerRegistry sets no WAL pragma), so this connection sets an
 * explicit busy_timeout: reads and the rare owner disable() retry instead of
 * throwing SQLITE_BUSY when the loop holds the file.
 *
 * The dbPath is injection-only: tests pass a temp path; the production path is
 * resolved solely at the mount site in api/index.ts (never inside this module).
 */

import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from '../sqlite.js';
import { TriggerRegistry } from '../operator/trigger-registry.js';
import type { TriggerRecord } from '../operator/trigger-types.js';

/** TriggerRecord nests counters (stats.*) -- flatten explicitly, never spread. */
function toWire(t: TriggerRecord) {
  return {
    id: t.id,
    kind: t.kind,
    memoryQuery: t.memoryQuery,
    status: t.status,
    authoredBy: t.authoredBy,
    createdAt: t.createdAt,
    fired: t.stats.fired,
    succeeded: t.stats.succeeded,
    failed: t.stats.failed,
    disabledReason: t.disabledReason ?? null,
  };
}

export function createOperatorRouter(opts: { dbPath: string }): Router {
  // Lazy open on first request: createApiServer mounts this router in ~30
  // existing tests that never call /api/operator -- an eager open would touch
  // the real ~/.mama path from every one of them (the PR #126 pollution class)
  // and crash on fresh installs where the parent directory does not exist yet.
  let registry: TriggerRegistry | null = null;
  const getRegistry = (): TriggerRegistry => {
    if (!registry) {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
      const db = new Database(opts.dbPath);
      db.prepare('PRAGMA busy_timeout = 5000').get();
      registry = new TriggerRegistry(db);
    }
    return registry;
  };
  const router = Router();

  router.get('/summary', (_req, res) => {
    const all = getRegistry().listAll();
    const active = all.filter((t) => t.status === 'active');
    const disabled = all.filter((t) => t.status === 'disabled');
    res.json({
      triggers: {
        active: active.length,
        disabled: disabled.length,
        fired: all.reduce((n, t) => n + t.stats.fired, 0),
        succeeded: all.reduce((n, t) => n + t.stats.succeeded, 0),
        failed: all.reduce((n, t) => n + t.stats.failed, 0),
      },
    });
  });

  router.get('/triggers', (_req, res) => {
    res.json({ triggers: getRegistry().listAll().map(toWire) });
  });

  router.post('/triggers/:id/disable', (req, res) => {
    const reason = (req.body as { reason?: string } | undefined)?.reason?.trim();
    if (!reason) {
      return res.status(400).json({ error: 'reason required' });
    }
    const id = req.params.id as string;
    if (!getRegistry().getById(id)) {
      return res.status(404).json({ error: 'trigger not found' });
    }
    const trigger = getRegistry().disable(id, reason);
    // Owner veto is loud by design (observability over restriction).
    console.log(`[operator-api] trigger ${id} disabled by owner: ${reason}`);
    return res.json({ ok: true, trigger: toWire(trigger) });
  });

  return router;
}
