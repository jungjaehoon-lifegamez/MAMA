import { createHash } from 'node:crypto';
import type { SQLiteDatabase } from '../sqlite.js';
import { applyOperatorProceduresMigration } from '../db/migrations/operator-procedures.js';

/** Host-derived authority only; sourceRefs and model input never confer access. */
export interface ProcedureAccess {
  ownerScope: string;
  projectId: string;
  channelId?: string;
}
export interface ProcedureScope {
  ownerScope: string;
  projectId: string;
  channelIds?: string[];
}
export interface ProcedureProjection {
  path: string;
  expectedFileHash: string | null;
  desiredText: string;
}
export interface ProcedureSaveInput {
  id: string;
  expectedRevision?: number;
  correctionId: string;
  title: string;
  description: string;
  whenToUse: string;
  whenNotToUse: string;
  body: string;
  expectedResults: string[];
  scope: ProcedureScope;
  sourceRefs: string[];
  originalInstruction: string;
  reason?: string;
  supersededMemoryIds?: string[];
  origin?: { id: string; hash: string };
  projection?: ProcedureProjection;
  /** Exact imported or replaced text, retained alongside the immutable new version. */
  previousBody?: string;
  /** Host retry comparison for derived document edits. */
  correctionRequestHash?: string;
}
export interface ProcedureRecord extends Omit<ProcedureSaveInput, 'expectedRevision'> {
  revision: number;
  scopeKey: string;
  status: 'active' | 'retired';
  createdAt: number;
  updatedAt: number;
}
export interface ProcedureOutcomeInput {
  procedureId: string;
  revision: number;
  receiptId: string;
  status: 'selected' | 'satisfied' | 'failed' | 'noop' | 'not_performed' | 'unknown';
  evidenceRefs: string[];
}
export interface ProcedureOutcome extends ProcedureOutcomeInput {
  observedAt: number;
}
interface Head {
  id: string;
  revision: number;
  status: 'active' | 'retired';
  owner_scope: string;
  project_id: string;
  channel_ids_json: string | null;
}
interface RevisionRow {
  record_json: string;
  intent_hash: string;
}

/** Stable scope identity for durable trigger references, independent of logical procedure ID. */
export function procedureScopeKey(
  scope: Pick<ProcedureAccess, 'ownerScope' | 'projectId'>
): string {
  return createHash('sha256')
    .update(JSON.stringify([scope.ownerScope, scope.projectId]))
    .digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
function required(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`procedure ${name} required`);
  }
}

/** TG-03/TG-05/TG-06: authorized heads, immutable instructions and receipt observations. */
export class ProcedureStore {
  constructor(private readonly db: SQLiteDatabase) {
    db.pragma('busy_timeout = 5000');
    applyOperatorProceduresMigration(db);
  }

  /** Keep projection file publication serialized with every canonical writer. */
  withWriteTransaction<T>(work: () => T): T {
    return this.db.transaction(work, 'immediate')();
  }

  private authorized(head: Head, access: ProcedureAccess): boolean {
    const channels =
      head.channel_ids_json === null ? undefined : (JSON.parse(head.channel_ids_json) as string[]);
    return (
      head.owner_scope === access.ownerScope &&
      head.project_id === access.projectId &&
      (!channels || (access.channelId !== undefined && channels.includes(access.channelId)))
    );
  }
  private head(id: string, access: ProcedureAccess): Head | null {
    const row = this.db
      .prepare(
        'SELECT * FROM operator_procedures WHERE id = ? AND owner_scope = ? AND project_id = ?'
      )
      .get(id, access.ownerScope, access.projectId) as Head | undefined;
    return row && this.authorized(row, access) ? row : null;
  }
  private revision(id: string, revision: number, access: ProcedureAccess): ProcedureRecord | null {
    const row = this.db
      .prepare(
        'SELECT record_json FROM operator_procedure_revisions WHERE procedure_id = ? AND revision = ? AND owner_scope = ? AND project_id = ?'
      )
      .get(id, revision, access.ownerScope, access.projectId) as RevisionRow | undefined;
    return row ? (JSON.parse(row.record_json) as ProcedureRecord) : null;
  }
  list(access: ProcedureAccess): ProcedureRecord[] {
    const heads = this.db
      .prepare(
        "SELECT * FROM operator_procedures WHERE owner_scope = ? AND project_id = ? AND status = 'active' ORDER BY id"
      )
      .all(access.ownerScope, access.projectId) as Head[];
    return heads
      .filter((head) => this.authorized(head, access))
      .map((head) => {
        const record = this.revision(head.id, head.revision, access);
        if (!record) {
          throw new Error('procedure head revision missing');
        }
        return record;
      });
  }
  read(id: string, access: ProcedureAccess, revision?: number): ProcedureRecord | null {
    const head = this.head(id, access);
    if (!head || head.status !== 'active') {
      return null;
    }
    return this.revision(id, revision ?? head.revision, access);
  }
  history(id: string, access: ProcedureAccess): ProcedureRecord[] {
    if (!this.head(id, access)) {
      return [];
    }
    return (
      this.db
        .prepare(
          'SELECT record_json FROM operator_procedure_revisions WHERE procedure_id = ? AND owner_scope = ? AND project_id = ? ORDER BY revision'
        )
        .all(id, access.ownerScope, access.projectId) as RevisionRow[]
    ).map((row) => JSON.parse(row.record_json) as ProcedureRecord);
  }
  private retry(
    correctionId: string,
    intentHash: string,
    access: ProcedureAccess
  ): ProcedureRecord | null {
    const row = this.db
      .prepare(
        'SELECT record_json, intent_hash FROM operator_procedure_revisions WHERE owner_scope = ? AND project_id = ? AND correction_id = ?'
      )
      .get(access.ownerScope, access.projectId, correctionId) as RevisionRow | undefined;
    if (!row) {
      return null;
    }
    const record = JSON.parse(row.record_json) as ProcedureRecord;
    if (!this.head(record.id, access)) {
      throw new Error('procedure unavailable');
    }
    if (row.intent_hash !== intentHash) {
      throw new Error('procedure correction conflict');
    }
    return record;
  }
  private append(record: ProcedureRecord, intentHash: string): void {
    this.db
      .prepare(
        'INSERT INTO operator_procedure_revisions (procedure_id, revision, owner_scope, project_id, correction_id, intent_hash, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.revision,
        record.scope.ownerScope,
        record.scope.projectId,
        record.correctionId,
        intentHash,
        JSON.stringify(record)
      );
  }
  save(input: ProcedureSaveInput, access: ProcedureAccess): ProcedureRecord {
    for (const field of ['id', 'correctionId', 'title', 'body', 'originalInstruction'] as const) {
      required(input[field], field);
    }
    if (
      input.scope.ownerScope !== access.ownerScope ||
      input.scope.projectId !== access.projectId ||
      (input.scope.channelIds &&
        (input.scope.channelIds.length === 0 ||
          input.scope.channelIds.some((channel) => channel !== access.channelId)))
    ) {
      throw new Error('procedure scope denied');
    }
    const expected = input.expectedRevision ?? 0;
    if (!Number.isInteger(expected) || expected < 0) {
      throw new Error('procedure expected revision invalid');
    }
    const intentHash = hash({ operation: 'save', ...input, expectedRevision: expected });
    // better-sqlite3 creates a SAVEPOINT when the host already owns a transaction.
    return this.db.transaction(() => {
      const retry = this.retry(input.correctionId, intentHash, access);
      if (retry) {
        return retry;
      }
      const head = this.head(input.id, access);
      if (expected !== (head?.revision ?? 0)) {
        throw new Error('procedure revision conflict');
      }
      if (head && head.status !== 'active') {
        throw new Error('procedure retired');
      }
      if (
        head &&
        head.channel_ids_json !==
          (input.scope.channelIds ? JSON.stringify(input.scope.channelIds) : null)
      ) {
        throw new Error('procedure scope change denied');
      }
      const previous = head ? this.revision(input.id, head.revision, access) : null;
      if (head && !previous) {
        throw new Error('procedure head revision missing');
      }
      const { expectedRevision: _expectedRevision, ...content } = input;
      const now = Date.now();
      const record: ProcedureRecord = {
        ...content,
        supersededMemoryIds: [
          ...new Set([
            ...(previous?.supersededMemoryIds ?? []),
            ...(input.supersededMemoryIds ?? []),
          ]),
        ],
        scopeKey: procedureScopeKey(access),
        revision: expected + 1,
        status: 'active',
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      if (head) {
        const result = this.db
          .prepare(
            'UPDATE operator_procedures SET revision = ? WHERE id = ? AND revision = ? AND owner_scope = ? AND project_id = ?'
          )
          .run(record.revision, input.id, expected, access.ownerScope, access.projectId);
        if (result.changes !== 1) {
          throw new Error('procedure revision conflict');
        }
      } else {
        this.db
          .prepare(
            'INSERT INTO operator_procedures (id, revision, status, owner_scope, project_id, channel_ids_json) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(
            input.id,
            record.revision,
            record.status,
            input.scope.ownerScope,
            input.scope.projectId,
            input.scope.channelIds ? JSON.stringify(input.scope.channelIds) : null
          );
      }
      this.append(record, intentHash);
      // Legacy operator DBs may not have trigger references yet. Never create a second truth.
      const triggerColumns = this.db.prepare('PRAGMA table_info(operator_triggers)').all() as {
        name: string;
      }[];
      if (
        triggerColumns.some((column) => column.name === 'procedure_ref_json') &&
        triggerColumns.some((column) => column.name === 'revision')
      ) {
        this.db
          .prepare(
            "UPDATE operator_triggers SET procedure_ref_json = ?, revision = revision + 1 WHERE status = 'active' AND json_extract(procedure_ref_json, '$.id') = ? AND json_extract(procedure_ref_json, '$.scopeKey') = ?"
          )
          .run(
            JSON.stringify({ id: record.id, revision: record.revision, scopeKey: record.scopeKey }),
            record.id,
            record.scopeKey
          );
        this.db
          .prepare(
            "UPDATE operator_triggers SET revision = revision + 1 WHERE status = 'active' AND id IN (SELECT trigger_id FROM operator_trigger_procedure_bindings WHERE scope_key = ? AND procedure_id = ?) AND NOT (COALESCE(json_extract(procedure_ref_json, '$.id'), '') = ? AND COALESCE(json_extract(procedure_ref_json, '$.scopeKey'), '') = ?)"
          )
          .run(record.scopeKey, record.id, record.id, record.scopeKey);
      }
      return record;
    }, 'immediate')();
  }
  /** The mapping records the original queued snapshot; current head is resolved separately. */
  getLegacyTriggerBinding(
    triggerId: string,
    access: ProcedureAccess
  ): {
    id: string;
    revision: number;
    scopeKey: string;
    snapshotHash: string;
  } | null {
    const triggerTable = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operator_triggers'")
      .get();
    const trigger = triggerTable
      ? (this.db.prepare('SELECT status FROM operator_triggers WHERE id = ?').get(triggerId) as
          | { status: string }
          | undefined)
      : undefined;
    if (trigger && trigger.status !== 'active') {
      throw new Error('legacy trigger not active');
    }
    const row = this.db
      .prepare(
        'SELECT procedure_id, procedure_revision, scope_key, snapshot_hash FROM operator_trigger_procedure_bindings WHERE trigger_id = ? AND owner_scope = ? AND project_id = ? AND channel_id = ?'
      )
      .get(triggerId, access.ownerScope, access.projectId, access.channelId ?? '') as
      | {
          procedure_id: string;
          procedure_revision: number;
          scope_key: string;
          snapshot_hash: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.procedure_id,
      revision: row.procedure_revision,
      scopeKey: row.scope_key,
      snapshotHash: row.snapshot_hash,
    };
  }

  /** TG-05: lazy legacy import never binds a global trigger to the first channel's private rule. */
  importLegacyTrigger(
    input: ProcedureSaveInput,
    access: ProcedureAccess,
    binding: { triggerId: string; snapshotHash: string }
  ): ProcedureRecord {
    required(binding.triggerId, 'triggerId');
    required(binding.snapshotHash, 'snapshotHash');
    required(access.channelId ?? '', 'legacy channelId');
    return this.withWriteTransaction(() => {
      const triggerTable = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operator_triggers'")
        .get();
      const trigger = triggerTable
        ? (this.db
            .prepare('SELECT status, revision FROM operator_triggers WHERE id = ?')
            .get(binding.triggerId) as { status: string; revision: number } | undefined)
        : undefined;
      if (trigger && trigger.status !== 'active') {
        throw new Error('legacy trigger not active');
      }
      const existing = this.getLegacyTriggerBinding(binding.triggerId, access);
      if (existing) {
        const record = this.read(existing.id, access, existing.revision);
        if (!record) {
          throw new Error('legacy bound procedure unavailable');
        }
        return record;
      }
      const record = this.save(input, access);
      this.db
        .prepare(
          'INSERT INTO operator_trigger_procedure_bindings (trigger_id, owner_scope, project_id, channel_id, procedure_id, procedure_revision, scope_key, snapshot_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          binding.triggerId,
          access.ownerScope,
          access.projectId,
          access.channelId,
          record.id,
          record.revision,
          record.scopeKey,
          binding.snapshotHash
        );
      if (trigger) {
        const changed = this.db
          .prepare(
            "UPDATE operator_triggers SET revision = revision + 1 WHERE id = ? AND status = 'active' AND revision = ?"
          )
          .run(binding.triggerId, trigger.revision);
        if (changed.changes !== 1) {
          throw new Error('legacy trigger revision conflict');
        }
      }
      return record;
    });
  }

  retire(
    id: string,
    expectedRevision: number,
    correctionId: string,
    reason: string,
    access: ProcedureAccess
  ): ProcedureRecord {
    required(correctionId, 'correctionId');
    required(reason, 'reason');
    const intentHash = hash({ operation: 'retire', id, expectedRevision, correctionId, reason });
    return this.db.transaction(() => {
      const retry = this.retry(correctionId, intentHash, access);
      if (retry) {
        return retry;
      }
      const head = this.head(id, access);
      if (!head) {
        throw new Error('procedure unavailable');
      }
      if (head.revision !== expectedRevision || head.status !== 'active') {
        throw new Error('procedure revision conflict');
      }
      const previous = this.revision(id, head.revision, access);
      if (!previous) {
        throw new Error('procedure head revision missing');
      }
      const record: ProcedureRecord = {
        ...previous,
        revision: expectedRevision + 1,
        status: 'retired',
        correctionId,
        reason,
        updatedAt: Date.now(),
      };
      this.db
        .prepare(
          "UPDATE operator_procedures SET revision = ?, status = 'retired' WHERE id = ? AND revision = ? AND owner_scope = ? AND project_id = ?"
        )
        .run(record.revision, id, expectedRevision, access.ownerScope, access.projectId);
      this.append(record, intentHash);
      return record;
    }, 'immediate')();
  }
  supersededMemoryIds(access: ProcedureAccess): string[] {
    const heads = this.db
      .prepare('SELECT * FROM operator_procedures WHERE owner_scope = ? AND project_id = ?')
      .all(access.ownerScope, access.projectId) as Head[];
    return [
      ...new Set(
        heads
          .filter((head) => this.authorized(head, access))
          .flatMap(
            (head) => this.revision(head.id, head.revision, access)?.supersededMemoryIds ?? []
          )
      ),
    ];
  }
  recordOutcome(input: ProcedureOutcomeInput, access: ProcedureAccess): ProcedureOutcome {
    required(input.receiptId, 'receiptId');
    return this.db.transaction(() => {
      if (
        !this.head(input.procedureId, access) ||
        !this.revision(input.procedureId, input.revision, access)
      ) {
        throw new Error('procedure unavailable');
      }
      const intentHash = hash(input);
      const row = this.db
        .prepare(
          'SELECT intent_hash, outcome_json FROM operator_procedure_outcomes WHERE procedure_id = ? AND receipt_id = ? AND owner_scope = ? AND project_id = ?'
        )
        .get(input.procedureId, input.receiptId, access.ownerScope, access.projectId) as
        | { intent_hash: string; outcome_json: string }
        | undefined;
      if (row) {
        if (row.intent_hash !== intentHash) {
          throw new Error('procedure receipt conflict');
        }
        return JSON.parse(row.outcome_json) as ProcedureOutcome;
      }
      const record = { ...input, observedAt: Date.now() };
      this.db
        .prepare(
          'INSERT INTO operator_procedure_outcomes (procedure_id, revision, receipt_id, intent_hash, outcome_json, owner_scope, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          input.procedureId,
          input.revision,
          input.receiptId,
          intentHash,
          JSON.stringify(record),
          access.ownerScope,
          access.projectId
        );
      return record;
    }, 'immediate')();
  }
  /** Durable intent is part of the immutable revision; publication is a separate receipt. */
  pendingProjections(access: ProcedureAccess): ProcedureRecord[] {
    return this.list(access).filter(
      (record) =>
        record.projection &&
        !this.db
          .prepare(
            'SELECT 1 FROM operator_procedure_projections WHERE procedure_id = ? AND revision = ? AND owner_scope = ? AND project_id = ?'
          )
          .get(record.id, record.revision, access.ownerScope, access.projectId)
    );
  }
  markProjected(
    id: string,
    revision: number,
    publishedHash: string,
    access: ProcedureAccess
  ): void {
    this.db.transaction(() => {
      const head = this.head(id, access);
      if (!head || head.status !== 'active') {
        throw new Error('procedure unavailable');
      }
      if (head.revision !== revision) {
        throw new Error('procedure projection revision conflict');
      }
      const record = this.revision(id, revision, access);
      if (!record?.projection) {
        throw new Error('procedure projection missing');
      }
      const expected = createHash('sha256').update(record.projection.desiredText).digest('hex');
      if (expected !== publishedHash) {
        throw new Error('procedure projection hash conflict');
      }
      this.db
        .prepare(
          'INSERT INTO operator_procedure_projections (procedure_id, revision, published_hash, owner_scope, project_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_scope, project_id, procedure_id, revision) DO NOTHING'
        )
        .run(id, revision, publishedHash, access.ownerScope, access.projectId);
    }, 'immediate')();
  }
  getOutcomes(id: string, access: ProcedureAccess): ProcedureOutcome[] {
    if (!this.head(id, access)) {
      return [];
    }
    return (
      this.db
        .prepare(
          'SELECT outcome_json FROM operator_procedure_outcomes WHERE procedure_id = ? AND owner_scope = ? AND project_id = ? ORDER BY rowid'
        )
        .all(id, access.ownerScope, access.projectId) as { outcome_json: string }[]
    ).map((row) => JSON.parse(row.outcome_json) as ProcedureOutcome);
  }
}
