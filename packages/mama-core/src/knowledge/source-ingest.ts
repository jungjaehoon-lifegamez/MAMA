import crypto from 'node:crypto';

import { getAdapter, initDB } from '../db-manager.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { canonicalizeJSON } from '../canonicalize.js';
import {
  appendObservationVersion,
  observationVersionId,
} from '../connectors/observation-versions.js';
import { insertMemoryEventInTransaction } from '../memory/event-store.js';
import type { JsonValue } from '../memory/judgment-types.js';
import type { MemoryEventRecord, MemoryScopeRef } from '../memory/types.js';
import {
  JudgmentError,
  admittedScopeIds,
  boundScopeIdsFor,
  type JudgmentAccess,
} from './judgments.js';

/**
 * `source.ingest` — the raw-evidence half of the command boundary.
 *
 * One command stores exactly one immutable `observation_versions` row plus its
 * provenance event. Observations are evidence, not judgments: no decisions row
 * is created, no edges are inferred, and nothing is extracted. The command id
 * binds the request through `command_bindings` so a retried ingest replays the
 * recorded receipt instead of writing a second observation.
 */
export interface SourceIngestCommand {
  /** Idempotency key. A repeated id replays the stored receipt; the same id
   * bound to different content fails with COMMAND_CONFLICT. */
  commandId: string;
  /** Producing connector and the source-side identity of what was captured. */
  source: { connector: string; id: string };
  producerVersionId?: string | null;
  /** The raw payload as observed. Never rewritten or summarized. */
  body: string;
  author?: string | null;
  /** Source-side event time (ms epoch) when known. */
  sourceAt?: number | null;
  /** Capture time (ms epoch); defaults to commit time. */
  observedAt?: number;
  /** sha256 of body when omitted. */
  contentHash?: string;
  metadata?: Record<string, JsonValue>;
  /** Free-form scope metadata persisted on the observation row. */
  scope?: Record<string, JsonValue>;
  /**
   * Memory scopes this ingest is bound to. An explicit `[]` stores an unscoped
   * observation; an omitted field inherits the access scope.
   */
  scopes?: MemoryScopeRef[];
  /** Provenance metadata for the observation's memory_events row. */
  event?: {
    eventType?: MemoryEventRecord['event_type'];
    actor?: MemoryEventRecord['actor'];
    sourceTurnId?: string;
    reason?: string;
    evidenceRefs?: string[];
  };
}

export interface SourceIngestReceipt {
  status: 'committed';
  commandId: string;
  observationId: string;
  eventId: string;
  watermark: number;
  diagnostics: Array<{ stage: string; code: string; message: string }>;
}

function requireNonblank(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JudgmentError('INVALID_COMMAND', `${field} must be nonblank`);
  }
}

function commandHash(command: SourceIngestCommand): string {
  return crypto.createHash('sha256').update(canonicalizeJSON(command)).digest('hex');
}

function parseReceipt(value: string): SourceIngestReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('source_commands.receipt_json is malformed', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('source_commands.receipt_json must contain an object');
  }
  return parsed as SourceIngestReceipt;
}

function assertReplay(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  command: SourceIngestCommand,
  access: JudgmentAccess,
  hash: string
): SourceIngestReceipt | null {
  const binding = adapter
    .prepare(
      'SELECT principal_id, action, payload_hash, receipt_key FROM command_bindings WHERE command_id = ?'
    )
    .get(command.commandId) as
    | { principal_id: string; action: string; payload_hash: string; receipt_key: string }
    | undefined;
  if (!binding) return null;
  if (
    binding.principal_id !== access.principalId ||
    binding.action !== 'source.ingest' ||
    binding.payload_hash !== hash
  ) {
    throw new JudgmentError(
      'COMMAND_CONFLICT',
      'The command id is already bound to another request'
    );
  }
  const row = adapter
    .prepare('SELECT receipt_json FROM source_commands WHERE command_id = ?')
    .get(command.commandId) as { receipt_json: string } | undefined;
  if (!row) {
    throw new Error('Command binding has no source ingest receipt');
  }
  return parseReceipt(row.receipt_json);
}

async function ingestSourceOnAdapter(
  adapter: DatabaseAdapter,
  command: SourceIngestCommand,
  access: JudgmentAccess
): Promise<SourceIngestReceipt> {
  requireNonblank(command.commandId, 'commandId');
  requireNonblank(command.source?.connector, 'source.connector');
  requireNonblank(command.source?.id, 'source.id');
  requireNonblank(command.body, 'body');
  requireNonblank(access.principalId, 'principalId');
  requireNonblank(access.agentId, 'agentId');
  if (
    command.sourceAt !== undefined &&
    command.sourceAt !== null &&
    (!Number.isFinite(command.sourceAt) || command.sourceAt < 0)
  ) {
    throw new JudgmentError('INVALID_TIME', 'sourceAt must be a finite nonnegative epoch');
  }
  if (
    command.observedAt !== undefined &&
    (!Number.isFinite(command.observedAt) || command.observedAt < 0)
  ) {
    throw new JudgmentError('INVALID_TIME', 'observedAt must be a finite nonnegative epoch');
  }

  // Admission is validated before any write: every scope the command claims
  // must already be inside the caller's admitted access.
  admittedScopeIds(access);
  const boundScopes = boundScopeIdsFor(access, command);
  const effectiveScopes = command.scopes ?? [...access.scopes];
  const effectiveCommand: SourceIngestCommand = command.scopes
    ? command
    : { ...command, scopes: [...access.scopes] };
  const hash = commandHash(effectiveCommand);
  const replay = assertReplay(adapter, command, access, hash);
  if (replay) {
    return replay;
  }

  const observedAt = command.observedAt ?? Date.now();
  const contentHash =
    command.contentHash ?? crypto.createHash('sha256').update(command.body).digest('hex');
  const observationInput = {
    sourceConnector: command.source.connector,
    sourceId: command.source.id,
    producerVersionId: command.producerVersionId ?? null,
    body: command.body,
    author: command.author ?? null,
    sourceAt: command.sourceAt ?? null,
    observedAt,
    contentHash,
    metadata: command.metadata ?? {},
    scope: {
      ...(command.scope ?? {}),
      scopes: boundScopes.map((scopeId, index) => ({
        scopeId,
        kind: effectiveScopes[index]?.kind,
        externalId: effectiveScopes[index]?.id,
        primary: index === 0,
      })),
    },
  };
  const boundObservationId = observationVersionId(observationInput);

  let replayedReceipt: SourceIngestReceipt | null = null;
  let committed: { observationId: string; eventId: string } | null = null;
  const now = Date.now();
  const transaction = adapter.transactionImmediate
    ? adapter.transactionImmediate.bind(adapter)
    : adapter.transaction.bind(adapter);
  transaction(() => {
    const bindingResult = adapter
      .prepare(
        `INSERT OR IGNORE INTO command_bindings
         (command_id, principal_id, action, payload_hash, receipt_kind, receipt_key, created_at)
         VALUES (?, ?, 'source.ingest', ?, 'observation', ?, ?)`
      )
      .run(command.commandId, access.principalId, hash, boundObservationId, now);
    if (bindingResult.changes === 0) {
      replayedReceipt = assertReplay(adapter, command, access, hash);
      if (!replayedReceipt) {
        throw new Error('Command binding was not readable after a conflict-free insert');
      }
      return;
    }
    const observation = appendObservationVersion(adapter, observationInput);
    const eventId = insertMemoryEventInTransaction(adapter, {
      event_type: command.event?.eventType ?? 'observed_conversation',
      actor: command.event?.actor ?? `actor:${access.principalId}`,
      source_turn_id: command.event?.sourceTurnId,
      memory_id: observation.observationId,
      topic: command.source.id,
      scope_refs: effectiveScopes,
      evidence_refs: command.event?.evidenceRefs,
      reason: command.event?.reason ?? 'source ingest command',
      created_at: observedAt,
    });
    const receipt: SourceIngestReceipt = {
      status: 'committed',
      commandId: command.commandId,
      observationId: observation.observationId,
      eventId,
      watermark: now,
      diagnostics: [],
    };
    adapter
      .prepare(
        `INSERT INTO source_commands
         (command_id, observation_id, event_id, committed_watermark, receipt_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        command.commandId,
        observation.observationId,
        eventId,
        receipt.watermark,
        canonicalizeJSON(receipt),
        now
      );
    committed = { observationId: observation.observationId, eventId };
  });
  if (replayedReceipt) {
    return replayedReceipt;
  }
  if (!committed) {
    throw new Error('source.ingest committed no observation');
  }
  const committedRef: { observationId: string; eventId: string } = committed;
  return {
    status: 'committed',
    commandId: command.commandId,
    observationId: committedRef.observationId,
    eventId: committedRef.eventId,
    watermark: now,
    diagnostics: [],
  };
}

export async function ingestSource(
  command: SourceIngestCommand,
  access: JudgmentAccess,
  options?: { adapter?: DatabaseAdapter }
): Promise<SourceIngestReceipt> {
  if (options?.adapter) {
    return ingestSourceOnAdapter(options.adapter, command, access);
  }
  await initDB();
  return ingestSourceOnAdapter(getAdapter(), command, access);
}
