import crypto from 'node:crypto';

import { getAdapter, initDB, insertPreparedDecision } from '../db-manager.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { canonicalizeJSON } from '../canonicalize.js';
import { insertMemoryEventInTransaction } from '../memory/event-store.js';
import type {
  JudgmentCommand,
  JudgmentReceipt,
  OwnerWorkPatch,
  RecordLink,
  WorkReference,
  WorkAssignment,
} from '../memory/judgment-types.js';
import type { MemoryScopeRef } from '../memory/types.js';

export interface JudgmentAccess {
  principalId: string;
  agentId: string;
  scopes: readonly MemoryScopeRef[];
}

export interface JudgmentKnowledgeOptions {
  adapter: DatabaseAdapter;
  embedder?: {
    embed(text: string, role: 'query' | 'passage'): Promise<Float32Array>;
  };
}

export class JudgmentError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'JudgmentError';
  }
}

function commandHash(command: JudgmentCommand): string {
  return crypto.createHash('sha256').update(canonicalizeJSON(command)).digest('hex');
}

function recordIdForCommand(command: JudgmentCommand): string {
  return `judgment_${crypto.createHash('sha256').update(command.commandId).digest('hex').slice(0, 24)}`;
}

function commitmentIdForCommand(command: JudgmentCommand): string {
  return `commitment_${crypto
    .createHash('sha256')
    .update(command.commandId)
    .digest('hex')
    .slice(0, 24)}`;
}

function requireText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JudgmentError('INVALID_COMMAND', `${field} must be nonblank`);
  }
}

function scopeIds(access: JudgmentAccess, command: JudgmentCommand): string[] {
  const scopes = command.scopes ?? access.scopes;
  if (scopes.length === 0) {
    throw new JudgmentError('INVALID_SCOPE', 'At least one judgment scope is required');
  }
  const admitted = new Set(access.scopes.map((scope) => `${scope.kind}\0${scope.id}`));
  const seen = new Set<string>();
  return scopes.map((scope) => {
    if (!['global', 'user', 'channel', 'project'].includes(scope.kind)) {
      throw new JudgmentError('INVALID_SCOPE', 'scope kind is invalid');
    }
    requireText(scope.kind, 'scope kind');
    requireText(scope.id, 'scope id');
    const key = `${scope.kind}\0${scope.id}`;
    if (seen.has(key)) {
      throw new JudgmentError('INVALID_SCOPE', 'Judgment scopes must be unique');
    }
    seen.add(key);
    if (!admitted.has(key)) {
      throw new JudgmentError('SCOPE_DENIED', 'Judgment scope is outside the admitted access');
    }
    return `scope_${scope.kind}_${Buffer.from(scope.id).toString('base64url')}`;
  });
}

function validateBounds(command: JudgmentCommand): void {
  for (const [name, value] of [
    ['appliesFrom', command.appliesFrom],
    ['appliesUntil', command.appliesUntil],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new JudgmentError('INVALID_TIME', `${name} must be a finite nonnegative epoch`);
    }
  }
  if (
    command.appliesFrom !== undefined &&
    command.appliesUntil !== undefined &&
    command.appliesFrom > command.appliesUntil
  ) {
    throw new JudgmentError('INVALID_TIME', 'appliesFrom cannot be after appliesUntil');
  }
}

function referenceExists(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  reference: WorkReference,
  allowedScopeIds: readonly string[]
): boolean {
  if (reference.kind === 'memory') {
    if (allowedScopeIds.length === 0) return false;
    const placeholders = allowedScopeIds.map(() => '?').join(', ');
    return (
      adapter
        .prepare(
          `SELECT 1 FROM decisions d
           JOIN memory_scope_bindings b ON b.memory_id = d.id
           WHERE d.id = ? AND b.scope_id IN (${placeholders}) LIMIT 1`
        )
        .get(reference.id, ...allowedScopeIds) !== undefined
    );
  }
  if (reference.kind === 'registry') {
    const node =
      adapter.prepare('SELECT 1 FROM registry_nodes WHERE id = ?').get(reference.id) !== undefined;
    if (!node) return false;
    const bindings = adapter
      .prepare('SELECT scope_kind, scope_id FROM registry_scope_bindings WHERE node_id = ?')
      .all(reference.id) as Array<{ scope_kind: string; scope_id: string }>;
    return (
      bindings.length === 0 ||
      bindings.some((binding) =>
        allowedScopeIds.includes(
          `scope_${binding.scope_kind}_${Buffer.from(binding.scope_id).toString('base64url')}`
        )
      )
    );
  }
  if (reference.kind === 'observation') {
    return (
      adapter
        .prepare('SELECT 1 FROM observation_versions WHERE observation_id = ?')
        .get(reference.id) !== undefined
    );
  }
  if (reference.kind === 'edge') {
    return (
      adapter.prepare('SELECT 1 FROM twin_edges WHERE edge_id = ?').get(reference.id) !== undefined
    );
  }
  return true;
}

function validateLinks(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  links: readonly RecordLink[],
  allowedScopeIds: readonly string[]
): void {
  const keys = new Set<string>();
  for (const link of links) {
    requireText(link.relation, 'link relation');
    requireText(link.target.id, 'link target id');
    const attrs = link.attrs ?? {};
    const key = canonicalizeJSON({
      relation: link.relation,
      target: link.target,
      role: attrs.role ?? null,
      slot: attrs.slot ?? null,
    });
    if (keys.has(key)) {
      throw new JudgmentError(
        'DUPLICATE_LINK',
        'A judgment cannot repeat the same relation target slot'
      );
    }
    keys.add(key);
    if (!referenceExists(adapter, link.target, allowedScopeIds)) {
      throw new JudgmentError('REFERENCE_NOT_FOUND', 'A judgment reference is unavailable');
    }
  }
}

function parseReceipt(value: string): JudgmentReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('judgment_commands.receipt_json is malformed', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('judgment_commands.receipt_json must contain an object');
  }
  return parsed as JudgmentReceipt;
}

function assertReplay(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  command: JudgmentCommand,
  access: JudgmentAccess,
  hash: string
): JudgmentReceipt | null {
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
    binding.action !== 'judgment.append' ||
    binding.payload_hash !== hash
  ) {
    throw new JudgmentError(
      'COMMAND_CONFLICT',
      'The command id is already bound to another request'
    );
  }
  const row = adapter
    .prepare('SELECT receipt_json FROM judgment_commands WHERE command_id = ?')
    .get(command.commandId) as { receipt_json: string } | undefined;
  if (!row) {
    throw new Error('Command binding has no judgment receipt');
  }
  return parseReceipt(row.receipt_json);
}

function edgeId(commandId: string, index: number, relation: string, target: WorkReference): string {
  return `edge_${crypto
    .createHash('sha256')
    .update(canonicalizeJSON({ commandId, index, relation, target }))
    .digest('hex')
    .slice(0, 24)}`;
}

function insertLink(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  command: JudgmentCommand,
  recordId: string,
  link: RecordLink,
  index: number,
  access: JudgmentAccess,
  now: number
): string {
  const id = edgeId(command.commandId, index, link.relation, link.target);
  const attrs = link.attrs ?? {};
  const contentHash = crypto
    .createHash('sha256')
    .update(canonicalizeJSON({ id, recordId, link }))
    .digest();
  adapter
    .prepare(
      `INSERT INTO twin_edges (
         edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
         relation_attrs_json, confidence, source, agent_id, evidence_refs_json,
         content_hash, created_at
       ) VALUES (?, ?, 'memory', ?, ?, ?, ?, 1.0, 'agent', ?, ?, ?, ?)`
    )
    .run(
      id,
      link.relation,
      recordId,
      link.target.kind,
      link.target.id,
      canonicalizeJSON(attrs),
      access.agentId,
      command.replaces?.length ? canonicalizeJSON(command.replaces) : null,
      contentHash,
      now
    );
  return id;
}

function workPatch(value: WorkAssignment | undefined): OwnerWorkPatch {
  return value?.set ?? {};
}

async function appendJudgmentOnAdapter(
  adapter: DatabaseAdapter,
  command: JudgmentCommand,
  access: JudgmentAccess,
  embedder?: JudgmentKnowledgeOptions['embedder']
): Promise<JudgmentReceipt> {
  requireText(command.commandId, 'commandId');
  requireText(command.topic, 'topic');
  requireText(command.summary, 'summary');
  requireText(access.principalId, 'principalId');
  requireText(access.agentId, 'agentId');
  if (command.recordKind !== 'judgment' && command.recordKind !== 'commitment') {
    throw new JudgmentError('INVALID_COMMAND', 'recordKind is invalid');
  }
  if ((command.recordKind === 'commitment') !== (command.work !== undefined)) {
    throw new JudgmentError('INVALID_COMMAND', 'Commitment records require a work assignment');
  }
  validateBounds(command);
  const allowedScopeIds = scopeIds(access, command);
  const hash = commandHash(command);
  const replay = assertReplay(adapter, command, access, hash);
  if (replay) {
    validateLinks(adapter, command.links ?? [], allowedScopeIds);
    for (const replacement of command.replaces ?? []) {
      if (!referenceExists(adapter, { kind: 'memory', id: replacement.id }, allowedScopeIds)) {
        throw new JudgmentError('REFERENCE_NOT_FOUND', 'A replacement target is unavailable');
      }
    }
    return replay;
  }
  validateLinks(adapter, command.links ?? [], allowedScopeIds);

  const recordId = recordIdForCommand(command);
  const now = Date.now();
  const embedding = embedder
    ? await embedder.embed(`${command.topic}\n${command.summary}`, 'passage')
    : null;
  const edgeIds: string[] = [];
  let workReceipt: JudgmentReceipt['work'];
  adapter.transaction(() => {
    const decisionRowId = insertPreparedDecision(
      adapter,
      {
        id: recordId,
        topic: command.topic,
        decision: command.summary,
        reasoning: command.reasoning ?? null,
        created_at: now,
        updated_at: now,
        agent_id: access.agentId,
      },
      embedding
    );
    if (!Number.isSafeInteger(decisionRowId) || decisionRowId <= 0) {
      throw new Error('Judgment decision row was not inserted');
    }
    adapter
      .prepare(
        `UPDATE decisions SET record_kind = ?, payload_json = ?, applies_from = ?, applies_until = ?
         WHERE id = ?`
      )
      .run(
        command.recordKind,
        canonicalizeJSON(command.payload ?? {}),
        command.appliesFrom ?? null,
        command.appliesUntil ?? null,
        recordId
      );
    for (const [index, scopeId] of allowedScopeIds.entries()) {
      const scope = (command.scopes ?? access.scopes)[index]!;
      adapter
        .prepare('INSERT OR IGNORE INTO memory_scopes (id, kind, external_id) VALUES (?, ?, ?)')
        .run(scopeId, scope.kind, scope.id);
      adapter
        .prepare(
          'INSERT INTO memory_scope_bindings (memory_id, scope_id, is_primary) VALUES (?, ?, ?)'
        )
        .run(recordId, scopeId, index === 0 ? 1 : 0);
    }
    for (const [index, link] of (command.links ?? []).entries()) {
      edgeIds.push(insertLink(adapter, command, recordId, link, index, access, now));
    }
    for (const replacement of command.replaces ?? []) {
      if (!referenceExists(adapter, { kind: 'memory', id: replacement.id }, allowedScopeIds)) {
        throw new JudgmentError('REFERENCE_NOT_FOUND', 'A replacement target is unavailable');
      }
      adapter
        .prepare(
          "UPDATE decisions SET superseded_by = ?, status = 'superseded', updated_at = ? WHERE id = ?"
        )
        .run(recordId, now, replacement.id);
      edgeIds.push(
        insertLink(
          adapter,
          { ...command, links: [] },
          recordId,
          { relation: 'supersedes', target: { kind: 'memory', id: replacement.id } },
          edgeIds.length,
          access,
          now
        )
      );
    }
    if (command.recordKind === 'commitment' && command.work) {
      const work = command.work;
      if (work.operation === 'create') {
        const commitmentId = commitmentIdForCommand(command);
        adapter
          .prepare(
            `INSERT INTO commitments
             (commitment_id, current_revision, head_record_id, withdrawn, created_at, updated_at)
             VALUES (?, 1, ?, 0, ?, ?)`
          )
          .run(commitmentId, recordId, now, now);
        adapter
          .prepare(
            `INSERT INTO commitment_assignments
             (commitment_id, revision, record_id, operation, set_json, clear_json, created_at)
             VALUES (?, 1, ?, 'create', ?, '[]', ?)`
          )
          .run(commitmentId, recordId, canonicalizeJSON(workPatch(work)), now);
        workReceipt = { commitmentId, revision: 1 };
      } else {
        const current = adapter
          .prepare('SELECT current_revision FROM commitments WHERE commitment_id = ?')
          .get(work.commitmentId) as { current_revision: number } | undefined;
        if (!current) {
          throw new JudgmentError('REFERENCE_NOT_FOUND', 'Commitment is unavailable');
        }
        if (current.current_revision !== work.expectedRevision) {
          throw new JudgmentError('STALE_REVISION', 'Commitment revision is stale');
        }
        const revision = current.current_revision + 1;
        adapter
          .prepare(
            `INSERT INTO commitment_assignments
             (commitment_id, revision, record_id, operation, set_json, clear_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            work.commitmentId,
            revision,
            recordId,
            work.operation,
            canonicalizeJSON(workPatch(work)),
            canonicalizeJSON(work.clear ?? []),
            now
          );
        if (work.operation === 'withdraw') {
          adapter.prepare("UPDATE decisions SET status = 'withdrawn' WHERE id = ?").run(recordId);
        }
        adapter
          .prepare(
            'UPDATE commitments SET current_revision = ?, head_record_id = ?, withdrawn = ?, updated_at = ? WHERE commitment_id = ?'
          )
          .run(revision, recordId, work.operation === 'withdraw' ? 1 : 0, now, work.commitmentId);
        workReceipt = { commitmentId: work.commitmentId, revision };
      }
    }
    insertMemoryEventInTransaction(adapter, {
      event_type: 'save',
      actor: `actor:${access.principalId}`,
      memory_id: recordId,
      topic: command.topic,
      scope_refs: command.scopes ?? [...access.scopes],
      reason: 'agent judgment command',
      created_at: now,
    });
    const receipt: JudgmentReceipt = {
      status: 'committed',
      recordId,
      commandId: command.commandId,
      edgeIds,
      watermark: now,
      ...(workReceipt ? { work: workReceipt } : {}),
      diagnostics: [],
    };
    adapter
      .prepare(
        `INSERT INTO command_bindings
         (command_id, principal_id, action, payload_hash, receipt_kind, receipt_key, created_at)
         VALUES (?, ?, 'judgment.append', ?, ?, ?, ?)`
      )
      .run(command.commandId, access.principalId, hash, 'judgment', recordId, now);
    adapter
      .prepare(
        `INSERT INTO judgment_commands (command_id, record_id, committed_watermark, receipt_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(command.commandId, recordId, receipt.watermark, canonicalizeJSON(receipt), now);
  });
  return {
    status: 'committed',
    recordId,
    commandId: command.commandId,
    edgeIds,
    watermark: now,
    ...(workReceipt ? { work: workReceipt } : {}),
    diagnostics: [],
  };
}

export async function appendJudgment(
  command: JudgmentCommand,
  access: JudgmentAccess,
  options?: Partial<JudgmentKnowledgeOptions>
): Promise<JudgmentReceipt> {
  if (options?.adapter) {
    return appendJudgmentOnAdapter(options.adapter, command, access, options.embedder);
  }
  await initDB();
  return appendJudgmentOnAdapter(getAdapter(), command, access, options?.embedder);
}

export function createJudgmentWriter(options: JudgmentKnowledgeOptions) {
  return {
    appendJudgment: (command: JudgmentCommand, access: JudgmentAccess) =>
      appendJudgmentOnAdapter(options.adapter, command, access, options.embedder),
  };
}
