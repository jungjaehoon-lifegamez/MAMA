import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { AgentContext, GatewayToolExecutionContext } from '../agent/types.js';
import {
  ProcedureStore,
  procedureScopeKey,
  type ProcedureAccess,
  type ProcedureOutcomeInput,
  type ProcedureRecord,
} from './procedure-store.js';
import {
  prepareConsoleBriefUpdate,
  readConsoleBriefSnapshot,
  type ConsoleBriefUpdate,
} from './console-brief.js';
import {
  hashProcedureDocument,
  publishProcedureProjection,
  type ProcedureProjectionResult,
} from './procedure-projection.js';
import {
  CONTINUE_HINT_CHARS,
  FRESH_HINT_CHARS,
  renderProcedureHints,
  selectProcedureHints,
  type ThreadHintMemory,
} from './experience-hints.js';

export type ProcedureRuntimeState = Omit<Partial<GatewayToolExecutionContext>, 'agentContext'> & {
  agentContext?: AgentContext | null;
};
const BRIEF_ID = 'owner-console-brief';
/** Kagemusha keeps the same bound on remembered session ids; older threads are forgotten first. */
const MAX_TRACKED_THREADS = 100;

export interface ProcedureTurn {
  /** Backend thread the prompt goes to; what it has been told is remembered per thread. */
  threadId: string;
  /** Opened or re-opened thread: nothing said earlier in it is visible to the model. */
  fresh: boolean;
}

/** TG-03/TG-04: metadata and body use the same host authority; never model-selected scope. */
export function deriveProcedureAccess(state: ProcedureRuntimeState | null): ProcedureAccess | null {
  const context = state?.agentContext;
  const envelope = state?.envelope;
  if (
    !context ||
    !envelope ||
    !Number.isFinite(Date.parse(envelope.expires_at)) ||
    Date.parse(envelope.expires_at) <= Date.now()
  ) {
    return null;
  }
  const projects = envelope.scope.project_refs.filter((ref) => ref.kind === 'project');
  if (projects.length !== 1 || !projects[0].id) {
    return null;
  }
  const owner = context.roleName === 'owner_console' && !state.memberScopeRequired;
  if (!owner && !context.principalId) {
    return null;
  }
  return {
    ownerScope: owner ? 'owner:runtime' : context.principalId!,
    projectId: projects[0].id,
    channelId:
      envelope.scope.memory_scopes.find((scope) => scope.kind === 'channel')?.id ??
      state.channelId ??
      envelope.channel_id,
  };
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('procedure input object required');
  }
  return input as Record<string, unknown>;
}
function text(input: Record<string, unknown>, name: string, optional = false): string {
  const value = input[name];
  if (optional && value === undefined) {
    return '';
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`procedure ${name} required`);
  }
  return value;
}
function strings(input: Record<string, unknown>, name: string, optional = false): string[] {
  const value = input[name];
  if (optional && value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`procedure ${name} must be a string array`);
  }
  return value;
}
function revision(input: Record<string, unknown>, name: string): number {
  const value = input[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`procedure ${name} must be a nonnegative integer`);
  }
  return value;
}
function metadata(record: ProcedureRecord): Record<string, unknown> {
  return {
    id: record.id,
    revision: record.revision,
    scopeKey: record.scopeKey,
    title: record.title,
    description: record.description,
    whenToUse: record.whenToUse,
    whenNotToUse: record.whenNotToUse,
  };
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** TG-05/TG-06: selection is a run snapshot; observations do not certify learning. */
export class ProcedureRuntime {
  private readonly pinned = new Map<string, Map<string, { revision: number; scopeKey: string }>>();
  private readonly threads = new Map<string, ThreadHintMemory>();
  constructor(
    private readonly store: ProcedureStore,
    private readonly homeDir: string = homedir()
  ) {}
  private requireAccess(state: ProcedureRuntimeState): ProcedureAccess {
    const access = deriveProcedureAccess(state);
    if (!access) {
      throw new Error('procedure host scope unavailable');
    }
    return access;
  }
  private runKey(state: ProcedureRuntimeState): string {
    const key = state.modelRunId || state.sourceMessageRef;
    if (!key) {
      throw new Error('procedure host run identity unavailable');
    }
    return key;
  }
  private correctionId(
    tool: string,
    id: string,
    expected: string | number,
    state: ProcedureRuntimeState
  ): string {
    const source = state.sourceMessageRef || state.modelRunId;
    if (!source) {
      throw new Error('procedure host correction source unavailable');
    }
    return `correction:${digest(JSON.stringify([source, tool, id, expected]))}`;
  }
  private original(state: ProcedureRuntimeState): string {
    if (!state.procedureStimulus?.trim()) {
      throw new Error('procedure host original instruction unavailable');
    }
    return state.procedureStimulus;
  }
  private sources(input: Record<string, unknown>, state: ProcedureRuntimeState): string[] {
    return [
      ...new Set(
        [
          state.sourceMessageRef || state.modelRunId || '',
          ...strings(input, 'source_refs', true),
        ].filter(Boolean)
      ),
    ];
  }
  /**
   * Hints for one prompt. A fresh (or untracked) thread is told the procedures most related
   * to the current stimulus once, with the catalog size; a live thread only what it has not
   * been told: new ids, revisions, or a counted procedure that now looks relevant. Reading
   * a hint proves nothing about learning; the agent still judges and reads the body.
   */
  prepareContext(
    state: ProcedureRuntimeState | null,
    turn: ProcedureTurn
  ): { text: string; hints: string[] } {
    const access = deriveProcedureAccess(state);
    if (!access) {
      return { text: '', hints: [] };
    }
    const projections = this.recoverProjections(access);
    const candidates = this.store.list(access).filter((record) => record.id !== BRIEF_ID);
    const key = `${procedureScopeKey(access)}|${turn.threadId}`;
    const fresh = turn.fresh || !this.threads.has(key);
    const memory = this.threadMemory(key, fresh);
    const hits = selectProcedureHints({
      stimulus: state?.procedureStimulus ?? '',
      candidates,
      ...(fresh ? {} : { seen: memory }),
    });
    const rendered = renderProcedureHints({
      hits,
      total: candidates.length,
      maxChars: fresh ? FRESH_HINT_CHARS : CONTINUE_HINT_CHARS,
      fresh,
    });
    if (fresh) {
      for (const candidate of candidates) memory.set(candidate.id, null);
    }
    for (const hit of rendered.rendered) memory.set(hit.id, hit.revision);
    const projectionText = projections.length
      ? `<procedure_projections>${JSON.stringify(projections)
          .replace(/</g, '\\u003c')
          .replace(/>/g, '\\u003e')
          .replace(/&/g, '\\u0026')}</procedure_projections>`
      : '';
    return {
      text: [rendered.text, projectionText].filter(Boolean).join('\n'),
      hints: rendered.rendered.map((hit) => `${hit.id}@${hit.revision}`),
    };
  }
  private threadMemory(key: string, fresh: boolean): ThreadHintMemory {
    const memory = (fresh ? undefined : this.threads.get(key)) ?? new Map();
    this.threads.delete(key);
    this.threads.set(key, memory);
    if (this.threads.size > MAX_TRACKED_THREADS) {
      const oldest = this.threads.keys().next().value;
      if (oldest !== undefined) this.threads.delete(oldest);
    }
    return memory;
  }
  canonicalBrief(state: ProcedureRuntimeState | null): string | null {
    const access = deriveProcedureAccess(state);
    return access ? (this.store.read(BRIEF_ID, access)?.body ?? null) : null;
  }
  releaseRun(state: ProcedureRuntimeState | null): void {
    const key = state?.modelRunId || state?.sourceMessageRef;
    if (key) {
      this.pinned.delete(key);
    }
  }
  assertWritable(state: ProcedureRuntimeState): void {
    const key = state.modelRunId || state.sourceMessageRef;
    if (!state.procedureRefs?.length && (!key || !this.pinned.get(key)?.size)) {
      return;
    }
    const access = this.requireAccess(state);
    const scopeKey = procedureScopeKey(access);
    const selected = new Map<string, { revision: number; scopeKey: string }>(
      state.procedureRefs?.map((ref) => [
        ref.id,
        { revision: ref.revision, scopeKey: ref.scopeKey ?? scopeKey },
      ]) ?? []
    );
    if (key) {
      for (const [id, reference] of this.pinned.get(key) ?? []) {
        selected.set(id, reference);
      }
    }
    for (const [id, reference] of selected) {
      if (reference.scopeKey !== scopeKey || !this.store.read(id, access, reference.revision)) {
        throw new Error('selected procedure unavailable: retired or access revoked');
      }
    }
  }
  private publish(record: ProcedureRecord, access: ProcedureAccess): ProcedureProjectionResult {
    if (!record.projection) {
      throw new Error('procedure projection missing');
    }
    return publishProcedureProjection({
      path: record.projection.path,
      text: record.projection.desiredText,
      expectedFileHash: record.projection.expectedFileHash,
      serialize: (publish) =>
        this.store.withWriteTransaction(() => {
          const current = this.store.read(record.id, access);
          if (current?.revision !== record.revision) {
            throw new Error('procedure projection revision conflict');
          }
          return publish();
        }),
      onPublished: (hash) => this.store.markProjected(record.id, record.revision, hash, access),
    });
  }
  private recoverProjections(
    access: ProcedureAccess
  ): Array<{ id: string; status: string; reason?: string }> {
    return this.store.pendingProjections(access).map((record) => {
      const result = this.publish(record, access);
      return {
        id: record.id,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    });
  }
  execute(tool: string, raw: unknown, state: ProcedureRuntimeState): Record<string, unknown> {
    const access = this.requireAccess(state);
    const input = object(raw);
    for (const key of [
      'scope',
      'ownerScope',
      'owner_scope',
      'projectId',
      'project_id',
      'channelIds',
      'channel_ids',
      'originalInstruction',
      'original_instruction',
      'correctionId',
      'correction_id',
      'projection',
    ]) {
      if (key in input) {
        throw new Error(`procedure ${key} is host-owned`);
      }
    }
    if (tool === 'procedure_list') {
      return { success: true, procedures: this.store.list(access).map(metadata) };
    }
    if (tool === 'console_brief_update') {
      return this.updateBrief(input, state, access);
    }
    const id = text(input, 'id');
    if (tool === 'procedure_read') {
      if (id === BRIEF_ID) {
        if (access.ownerScope !== 'owner:runtime' || state.memberScopeRequired) {
          throw new Error('console brief owner scope required');
        }
        // The first edit needs the exact legacy text/hash without importing on a read.
        // This snapshot is not a persisted revision; updateBrief checks its hash at commit.
        if (this.store.history(id, access).length === 0) {
          if (input.revision !== undefined && revision(input, 'revision') !== 0) {
            throw new Error('procedure unavailable');
          }
          const snapshot = readConsoleBriefSnapshot(this.homeDir);
          return {
            success: true,
            procedure: {
              id,
              revision: 0,
              title: 'Owner console operating brief',
              body: snapshot.text,
              scopeKey: procedureScopeKey(access),
            },
            hash: hashProcedureDocument(snapshot.text),
            status: 'legacy_snapshot',
            behaviorVerified: false,
          };
        }
      }
      const key = this.runKey(state);
      const pinned =
        this.pinned.get(key) ??
        new Map<string, { revision: number; scopeKey: string }>(
          state.procedureRefs?.map((ref) => [
            ref.id,
            { revision: ref.revision, scopeKey: ref.scopeKey ?? procedureScopeKey(access) },
          ]) ?? []
        );
      if (pinned.has(id) && pinned.get(id)!.scopeKey !== procedureScopeKey(access)) {
        throw new Error('procedure scope unavailable');
      }
      const explicit = input.revision === undefined ? undefined : revision(input, 'revision');
      if (pinned.has(id) && explicit !== undefined && pinned.get(id)?.revision !== explicit) {
        throw new Error('procedure running revision is pinned');
      }
      const record = this.store.read(id, access, pinned.get(id)?.revision ?? explicit);
      if (!record) {
        throw new Error('procedure unavailable');
      }
      pinned.set(id, { revision: record.revision, scopeKey: record.scopeKey });
      this.pinned.set(key, pinned);
      return {
        success: true,
        procedure: record,
        hash: hashProcedureDocument(record.body),
        observations: this.store.getOutcomes(id, access).slice(-20),
        behaviorVerified: false,
      };
    }
    if (
      [
        'procedure_update',
        'procedure_retire',
        'procedure_observe',
        'console_brief_update',
      ].includes(tool) &&
      state.envelope?.tier === 3
    ) {
      throw new Error('procedure write denied at read-only tier');
    }
    if (id === BRIEF_ID && (tool === 'procedure_update' || tool === 'procedure_retire')) {
      throw new Error('Use console_brief_update for operating brief corrections');
    }
    if (tool === 'procedure_update') {
      const expected = revision(input, 'expected_revision');
      const existing = expected > 0 ? this.store.read(id, access) : null;
      if (expected > 0 && !existing) {
        throw new Error('procedure unavailable');
      }
      const record = this.store.save(
        {
          id,
          expectedRevision: expected,
          correctionId: this.correctionId(tool, id, expected, state),
          title: text(input, 'title'),
          description: text(input, 'description'),
          whenToUse: text(input, 'when_to_use'),
          whenNotToUse: text(input, 'when_not_to_use'),
          body: text(input, 'body'),
          expectedResults: strings(input, 'expected_results'),
          reason: text(input, 'reason'),
          originalInstruction: this.original(state),
          sourceRefs: this.sources(input, state),
          supersededMemoryIds: strings(input, 'superseded_memory_ids', true),
          scope: existing?.scope ?? {
            ownerScope: access.ownerScope,
            projectId: access.projectId,
            ...(state.memberScopeRequired ? { channelIds: [access.channelId!] } : {}),
          },
        },
        access
      );
      return {
        success: true,
        status: 'stored',
        procedure: metadata(record),
        behaviorVerified: false,
      };
    }
    if (tool === 'procedure_retire') {
      const expected = revision(input, 'expected_revision');
      const record = this.store.retire(
        id,
        expected,
        this.correctionId(tool, id, expected, state),
        text(input, 'reason'),
        access
      );
      return {
        success: true,
        status: 'retired',
        procedure: metadata(record),
        behaviorVerified: false,
      };
    }
    if (tool === 'procedure_observe') {
      const status = text(input, 'status');
      if (
        !['selected', 'satisfied', 'failed', 'noop', 'not_performed', 'unknown'].includes(status)
      ) {
        throw new Error('procedure observation status invalid');
      }
      const observation = this.store.recordOutcome(
        {
          procedureId: id,
          revision: revision(input, 'revision'),
          receiptId: text(input, 'receipt_id'),
          status: status as ProcedureOutcomeInput['status'],
          evidenceRefs: strings(input, 'evidence_refs'),
        },
        access
      );
      return {
        success: true,
        observation,
        behaviorVerified: false,
        message:
          'Observation stored; satisfaction is an agent assessment, not independently verified learning.',
      };
    }
    throw new Error('Unknown procedure tool');
  }
  private updateBrief(
    input: Record<string, unknown>,
    state: ProcedureRuntimeState,
    access: ProcedureAccess
  ): Record<string, unknown> {
    if (access.ownerScope !== 'owner:runtime' || state.memberScopeRequired) {
      throw new Error('console brief owner scope required');
    }
    const operation = input.operation;
    if (operation === 'append') {
      throw new Error(
        'console brief update refused: append is retired; store the correction with procedure_update'
      );
    }
    if (operation !== 'replace' && operation !== 'retire') {
      throw new Error('console brief operation invalid');
    }
    if (state.envelope?.tier === 3) {
      throw new Error('procedure write denied at read-only tier');
    }
    // A committed predecessor must be acknowledged before taking the next file baseline.
    // This covers both crash-before-rename and crash-after-rename-before-ack.
    const pending = this.store.pendingProjections(access).find((record) => record.id === BRIEF_ID);
    if (pending) {
      const recovery = this.publish(pending, access);
      if (recovery.status !== 'projected') {
        throw new Error(
          `console brief prior projection unresolved: ${recovery.reason ?? recovery.status}`
        );
      }
    }
    const current = this.store.read(BRIEF_ID, access);
    const snapshot = readConsoleBriefSnapshot(this.homeDir);
    const correctionId = this.correctionId(
      'console_brief_update',
      BRIEF_ID,
      typeof input.expected_hash === 'string' ? input.expected_hash : 'none',
      state
    );
    const requestHash = digest(
      JSON.stringify(
        Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))
      )
    );
    const retry = this.store
      .history(BRIEF_ID, access)
      .find((record) => record.correctionId === correctionId);
    if (retry) {
      if (retry.correctionRequestHash !== requestHash) {
        throw new Error('procedure correction conflict');
      }
      const status =
        current?.revision === retry.revision ? this.publish(retry, access).status : 'stored';
      return {
        success: true,
        status,
        revision: retry.revision,
        hash: hashProcedureDocument(retry.body),
        behaviorVerified: false,
        message: 'Correction already stored; no duplicate change.',
      };
    }
    const base = current?.body ?? snapshot.text;
    const edit: ConsoleBriefUpdate = {
      operation,
      lesson:
        typeof (input.lesson ?? input.content) === 'string'
          ? String(input.lesson ?? input.content)
          : undefined,
      target: typeof input.target === 'string' ? input.target : undefined,
      replacement: typeof input.replacement === 'string' ? input.replacement : undefined,
      expectedHash: typeof input.expected_hash === 'string' ? input.expected_hash : undefined,
    };
    const prepared = prepareConsoleBriefUpdate(edit, base);
    const record = this.store.save(
      {
        id: BRIEF_ID,
        expectedRevision: current?.revision ?? 0,
        correctionId,
        correctionRequestHash: requestHash,
        previousBody: base,
        title: 'Owner console operating brief',
        description: 'Current owner operating instructions',
        whenToUse: 'Owner work subject to the conditions of each individual rule',
        whenNotToUse: 'Rules whose applicability excludes the current work',
        body: prepared.text,
        expectedResults: ['Preserve each rule applicability and unrelated instructions'],
        originalInstruction: this.original(state),
        sourceRefs: this.sources(input, state),
        reason: text(input, 'reason', true) || `Owner brief ${operation}`,
        supersededMemoryIds: strings(input, 'superseded_memory_ids', true),
        scope: { ownerScope: access.ownerScope, projectId: access.projectId },
        projection: {
          path: snapshot.path,
          expectedFileHash: current ? hashProcedureDocument(current.body) : snapshot.hash,
          desiredText: prepared.text,
        },
      },
      access
    );
    const projected = this.publish(record, access);
    return {
      success: true,
      status: projected.status,
      revision: record.revision,
      hash: prepared.hash,
      ...(projected.reason ? { reason: projected.reason } : {}),
      behaviorVerified: false,
      message:
        'Correction stored. Projection status is separate from evidence that future behavior satisfies the instruction.',
    };
  }
}
