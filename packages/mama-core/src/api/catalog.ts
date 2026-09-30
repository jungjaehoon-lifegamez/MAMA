/**
 * Action catalog — one contract bound to its implementation.
 *
 * §4.2: each entry carries schema, description, examples and exec together; an
 * action that is not implemented is not listed. Legacy name translation lives
 * here exactly once, in the alias table — a retired tool never survives as an
 * alias that calls the old implementation.
 */
import type {
  ActionContract,
  ActionSchemaObject,
  ActionSessionFacts,
} from '../action-contracts.js';
import { JudgmentError, type JudgmentAccess } from '../knowledge/judgments.js';
import type { TextCompletion } from '../runtime/text-completion.js';
import type { DatabaseInstance } from '../db-manager.js';
import {
  boundReadScopesFor,
  readMemoryRecordById,
  recallMemory,
  retireMemoryRecord,
  saveJudgmentRecord,
} from '../memory/api.js';
import { resolveMemoryProvenanceLive } from '../memory/provenance-live.js';
import {
  readDecisionListing,
  readProjectDecisions,
  readProjectRollups,
} from '../memory/dashboard-read.js';
import { countGraphNodes, readGraphEdges, readGraphNodes } from '../memory/graph-read.js';
import { sanitizeRecallBundle, sanitizeRecallText } from '../memory/recall-sanitize.js';
import { ingestSource } from '../knowledge/source-ingest.js';
import { upsertNode, type RegistryScopeRef } from '../registry/store.js';
import {} from '../mama-api.js';
import {
  listCheckpointsInAdapter,
  listDecisionsInAdapter,
  suggestInAdapter,
  loadCheckpointInAdapter,
  readMemoryStatsInAdapter,
  saveCheckpointInAdapter,
  updateOutcomeInAdapter,
} from '../memory/api.js';
import type { MemoryScopeRef } from '../memory/types.js';
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  MEMORY_SCOPE_KINDS,
  type PublicSaveMemoryInput,
} from '../memory/types.js';
import type { WorkRead } from '../knowledge/commitments.js';
import type { Knowledge } from '../knowledge/index.js';
import type { IdentityCorrection, JsonValue, WorkGraphQuery } from '../memory/judgment-types.js';
import { TWIN_REF_KINDS } from '../knowledge/twin-edge-types.js';
import {
  readOperation,
  readChanges,
  CHANGES_READ_TARGET_TYPES,
  CHANGES_READ_CAUSE_STATES,
  type ChangesLedger,
  type ChangesReadInput,
  isUsableCause,
  recordEffect,
  recordUnattributedChange,
  type EffectAdapter,
} from '../runtime/operations.js';
import { listToolTraces, readToolTrace } from '../runtime/tool-trace-store.js';

/**
 * Server-side authority for one call — from the session credential, never
 * input. `operationId` is the id the common client issued for this call; for
 * knowledge commands it becomes the commandId, so a command action cannot run
 * without one. `session` carries the call-site facts only the host can
 * truthfully state (model run, tool call id, context packet) — provenance is
 * composed from these plus `access`, never trusted from the payload.
 */
export interface ActionContext {
  access: JudgmentAccess;
  operationId?: string;
  session?: ActionSessionFacts;
  /**
   * The host-composed read window for citation reads — connector grant,
   * project/tenant filters, and the observation-time clamp the envelope states.
   * Like `access` and `session` it is server-stated, never caller input: the
   * caller can only narrow within it through `input.scopes`, and an absent
   * window fails closed (no connectors means no raw events).
   */
  readAllowance?: MemoryReadAllowance;
  /**
   * Host-bound cancellation handle for long reads/downloads. Absent over
   * transports that cannot carry it — actions must run without it.
   */
  signal?: AbortSignal;
}

/**
 * Host-composed visibility window for reads that cite raw events. Every field
 * is derived from envelope state by the host, the same way the reader derives
 * it — the action consumes it as-is rather than trusting payload claims.
 */
export interface MemoryReadAllowance {
  /** Raw connectors this call may read. Empty means NO raw events, never all. */
  connectors: readonly string[];
  /** Explicit connector-wide reads stated by the principal, independent of tenant scoping. */
  wideConnectors?: readonly string[];
  /** Per-connector channel grant, already narrowed to the envelope's scopes. */
  channels?: Record<string, readonly string[]>;
  /** Project window, mirroring the reader's filter on the same column. */
  projectIds?: readonly string[];
  /** Tenant window for narrower reads; an explicit connector-wide owner grant is separate. */
  tenantId?: string | null;
  /** Observation-time clamp (envelope `as_of`), epoch ms. */
  minObservedMs?: number | null;
  maxObservedMs?: number | null;
  /** Inclusive source/event-time ceiling stated by an active replay turn. */
  maxSourceMs?: number | null;
}

export type ActionExec = (input: unknown, context: ActionContext) => unknown | Promise<unknown>;

export interface ActionRegistration {
  contract: ActionContract;
  exec: ActionExec;
}

export class UnknownActionError extends Error {
  readonly code = 'unknown_action';
  constructor(name: string) {
    super(`Unknown action: ${name}`);
    this.name = 'UnknownActionError';
  }
}

export interface ActionCatalog {
  /** Every registered contract — the executable surface, nothing more. */
  list(): ActionContract[];
  /** One contract by name or alias; throws UnknownActionError. */
  describe(name: string): ActionContract;
  /** The exec binding by name or alias; throws UnknownActionError. */
  entry(name: string): ActionRegistration;
}

export function createCatalog(
  registrations: readonly ActionRegistration[],
  aliases: Readonly<Record<string, string>> = {}
): ActionCatalog {
  const entries = new Map<string, ActionRegistration>();
  for (const registration of registrations) {
    const name = registration.contract.name;
    if (entries.has(name)) {
      throw new Error(`Duplicate action registration: ${name}`);
    }
    entries.set(name, registration);
  }
  const canonicalName = (name: string): string => aliases[name] ?? name;
  const entry = (name: string): ActionRegistration => {
    const found = entries.get(canonicalName(name));
    if (!found) {
      throw new UnknownActionError(name);
    }
    return found;
  };
  return {
    list: () => [...entries.values()].map((registration) => registration.contract),
    describe: (name) => entry(name).contract,
    entry,
  };
}

const refSchema: ActionSchemaObject = {
  type: 'object',
  required: ['kind', 'id'],
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: TWIN_REF_KINDS,
      description:
        'Referenced graph kind, e.g. "memory" (a work item\'s revision record) or "registry".',
    },
    id: {
      type: 'string',
      minLength: 1,
      description: 'Stable id within the kind, e.g. "work_123".',
    },
  },
};

const msRangeSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: {
      type: 'number',
      description: 'Inclusive epoch-millisecond start, e.g. 1760000000000.',
    },
    end: {
      type: 'number',
      description: 'Inclusive epoch-millisecond end, e.g. 1760086400000.',
    },
  },
};

export const scopeRefSchema: ActionSchemaObject = {
  type: 'object',
  required: ['kind', 'id'],
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: MEMORY_SCOPE_KINDS,
      description: 'Scope kind, e.g. "project".',
    },
    id: { type: 'string', minLength: 1, description: 'Scope identifier, e.g. "project_123".' },
  },
};

export const recordLinkSchema: ActionSchemaObject = {
  type: 'object',
  required: ['relation', 'target'],
  additionalProperties: false,
  properties: {
    relation: {
      type: 'string',
      description: 'Relationship to the target, e.g. "derived_from".',
      enum: [
        'supersedes',
        'refines',
        'contradicts',
        'mentions',
        'derived_from',
        'builds_on',
        'debates',
        'synthesizes',
        'blocks',
        'next_action_for',
        'case_member',
        'amends',
      ],
    },
    target: {
      ...refSchema,
      description: 'Target graph reference, e.g. {"kind":"observation","id":"obs_123"}.',
    },
    attrs: {
      type: 'object',
      description: 'Optional relationship metadata, e.g. {"confidence":0.8}.',
    },
  },
};

/** Fields every work command shares; required-ness lives on each action. */

/** The lifecycle fields a reclassification states; callers may not repeat them. */

function requiredOperationId(context: ActionContext, action: string): string {
  if (typeof context.operationId !== 'string' || context.operationId.trim().length === 0) {
    throw new JudgmentError(
      'INVALID_COMMAND',
      `${action} requires operationId: it becomes the command id, and a retry reuses it.`
    );
  }
  return context.operationId;
}

/** Topic/summary a revision needs when the caller did not restate them. */

const workGraphQuerySchema: ActionSchemaObject = {
  type: 'object',
  required: ['view'],
  additionalProperties: false,
  properties: {
    view: {
      type: 'string',
      enum: ['overview', 'browse', 'neighbors', 'timeline', 'paths', 'detail'],
      description: 'Graph view to execute, e.g. "neighbors".',
    },
    seeds: {
      type: 'array',
      description: 'Starting graph references, e.g. [{"kind":"memory","id":"judgment_123"}].',
      items: refSchema,
    },
    search: {
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      description: 'Optional registered-name search, e.g. {"text":"release"}.',
      properties: {
        text: {
          type: 'string',
          minLength: 1,
          description: 'Name text to resolve, e.g. "release".',
        },
        kinds: {
          type: 'array',
          description: 'Kinds to restrict the search, e.g. ["registry"].',
          items: { type: 'string', enum: TWIN_REF_KINDS },
        },
      },
    },
    section: {
      type: 'string',
      enum: ['summary', 'reasoning', 'payload'],
      description: 'Detail section to expand, e.g. "summary".',
    },
    textOffset: {
      type: 'integer',
      minimum: 0,
      description: 'Character offset for detail text, e.g. 0.',
    },
    textLimit: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum detail characters, e.g. 4000.',
    },
    from: {
      ...refSchema,
      description: 'Path/timeline start reference, e.g. {"kind":"memory","id":"judgment_123"}.',
    },
    to: {
      ...refSchema,
      description: 'Path/timeline end reference, e.g. {"kind":"memory","id":"mem_123"}.',
    },
    maxDepth: {
      type: 'integer',
      minimum: 0,
      description: 'Maximum graph traversal depth, e.g. 2.',
    },
    direction: {
      type: 'string',
      enum: ['in', 'out', 'both'],
      description: 'Edge direction, e.g. "both".',
    },
    relations: {
      type: 'array',
      description: 'Relationship names to include, e.g. ["derived_from"].',
      items: { type: 'string', minLength: 1 },
    },
    history: {
      type: 'string',
      enum: ['current', 'all'],
      description: 'History mode, e.g. "current".',
    },
    eventRange: {
      ...msRangeSchema,
      description: 'Occurrence-time window, e.g. {"start":1760000000000}.',
    },
    recordedRange: {
      ...msRangeSchema,
      description: 'Recorded-time window, e.g. {"end":1760086400000}.',
    },
    asOf: {
      type: 'number',
      description: 'Read state at epoch milliseconds, e.g. 1760000000000.',
    },
    limit: { type: 'integer', minimum: 1, description: 'Maximum returned graph rows, e.g. 25.' },
    cursor: {
      type: 'string',
      minLength: 1,
      description: 'Opaque page cursor, e.g. "cursor_25".',
    },
  },
};

/** Read knobs every work read shares; show adds the identity filters. */
const workReadFields: Record<string, ActionSchemaObject> = {
  asOf: {
    type: 'integer',
    minimum: 0,
    description: 'Read work as of epoch milliseconds, e.g. 1760000000000.',
  },
  history: {
    type: 'string',
    enum: ['current', 'all'],
    description: 'Revision view, e.g. "all".',
  },
  limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum work rows, e.g. 25.' },
  cursor: {
    type: 'string',
    minLength: 1,
    description: 'Opaque work page cursor, e.g. "cursor_25".',
  },
};

const workListSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: workReadFields,
};

const workShowSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...workReadFields,
    commitmentId: {
      type: 'string',
      minLength: 1,
      description: 'Stable commitmentId citation handle, e.g. "commitment_123".',
    },
    rowId: {
      type: 'integer',
      minimum: 0,
      description: 'Legacy numeric commitment row id, e.g. 123.',
    },
  },
};

const observationEvidenceSchema: ActionSchemaObject = {
  type: 'object',
  required: ['kind', 'id'],
  additionalProperties: false,
  properties: {
    kind: { const: 'observation', description: 'Evidence kind; use "observation".' },
    id: {
      type: 'string',
      minLength: 1,
      description: 'Stable observationRef citation handle, e.g. "obs_123".',
    },
  },
};

/** One endpoint reassignment — by existing node id (or null to release) or by a new child's clientKey. */
const identityAssignmentSchema: ActionSchemaObject = {
  oneOf: [
    {
      type: 'object',
      required: ['edgeId', 'endpoint', 'targetNodeId'],
      additionalProperties: false,
      properties: {
        edgeId: { type: 'string', minLength: 1 },
        endpoint: { type: 'string', enum: ['from', 'to'] },
        targetNodeId: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
      },
    },
    {
      type: 'object',
      required: ['edgeId', 'endpoint', 'targetClientKey'],
      additionalProperties: false,
      properties: {
        edgeId: { type: 'string', minLength: 1 },
        endpoint: { type: 'string', enum: ['from', 'to'] },
        targetClientKey: { type: 'string', minLength: 1 },
      },
    },
  ],
};

const splitChildSchema: ActionSchemaObject = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    clientKey: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    aliases: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};

function correctionVariant(
  operation: 'add_alias' | 'merge' | 'split' | 'assign_refs',
  extra: Record<string, ActionSchemaObject>,
  extraRequired: readonly string[]
): ActionSchemaObject {
  return {
    type: 'object',
    required: ['expectedRevision', 'reason', 'operation', ...extraRequired],
    additionalProperties: false,
    properties: {
      operation: { const: operation },
      expectedRevision: { type: 'integer', minimum: 0 },
      reason: { type: 'string', minLength: 1 },
      // An explicitly empty scopes array is not "use the authority's" - that
      // is what omitting the field means. The store refuses it too, one layer
      // in; saying it here refuses it before the transaction opens, which is
      // what the deleted tool schema did.
      scopes: { type: 'array', minItems: 1, items: scopeRefSchema },
      evidence: { type: 'array', items: observationEvidenceSchema },
      ...extra,
    },
  };
}

const identityCorrectSchema: ActionSchemaObject = {
  type: 'object',
  oneOf: [
    correctionVariant(
      'add_alias',
      {
        nodeId: { type: 'string', minLength: 1 },
        alias: { type: 'string', minLength: 1 },
      },
      ['nodeId', 'alias']
    ),
    correctionVariant(
      'merge',
      {
        survivorId: { type: 'string', minLength: 1 },
        memberIds: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
      ['survivorId', 'memberIds']
    ),
    correctionVariant(
      'split',
      {
        parentId: { type: 'string', minLength: 1 },
        children: { type: 'array', items: splitChildSchema },
        assignments: { type: 'array', items: identityAssignmentSchema },
      },
      ['parentId', 'children', 'assignments']
    ),
    correctionVariant(
      'assign_refs',
      {
        parentId: { type: 'string', minLength: 1 },
        assignments: { type: 'array', items: identityAssignmentSchema },
      },
      ['parentId', 'assignments']
    ),
  ],
};

const memorySearchSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'Memory text to recall, e.g. "release decision".',
    },
    limit: { type: 'integer', minimum: 1, description: 'Maximum memory results, e.g. 5.' },
    kind: {
      type: 'string',
      enum: MEMORY_KINDS,
      description: 'Optional memory record kind filter, e.g. "lesson".',
    },
    scopes: {
      type: 'array',
      description: 'Optional admitted scope filter, e.g. [{"kind":"project","id":"project_123"}].',
      items: scopeRefSchema,
    },
    threshold: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Minimum relevance score, e.g. 0.7.',
    },
    strict: { type: 'boolean', description: 'Use strict legacy filtering, e.g. true.' },
    strictness: {
      type: 'string',
      enum: ['recall', 'balanced', 'strict'],
      description: 'Recall strictness mode, e.g. "balanced".',
    },
    disableRecency: { type: 'boolean', description: 'Disable recency weighting, e.g. true.' },
    includeRelated: { type: 'boolean', description: 'Include related graph records, e.g. true.' },
    topicPrefix: {
      type: 'string',
      minLength: 1,
      description: 'Exact topic prefix for ledger listing, e.g. "work/".',
    },
    minLexicalSupport: {
      type: 'boolean',
      description: 'Require lexical query support, e.g. true.',
    },
    diagnostics: { type: 'boolean', description: 'Include search diagnostics, e.g. true.' },
    rerankWithLearned: { type: 'boolean', description: 'Apply the learned ranker, e.g. true.' },
    useReranking: { type: 'boolean', description: 'Allow host-provided reranking, e.g. true.' },
  },
};

const memoryCheckpointLoadSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const operationGetSchema: ActionSchemaObject = {
  type: 'object',
  required: ['operationId'],
  additionalProperties: false,
  properties: {
    operationId: { type: 'string', minLength: 1 },
  },
};

const memorySourceSchema: ActionSchemaObject = {
  type: 'object',
  required: ['package', 'source_type'],
  additionalProperties: false,
  properties: {
    // No enum. The core does not hold a list of who may use it.
    package: {
      type: 'string',
      minLength: 1,
      description: 'Producer package name, e.g. "owner-agent".',
    },
    source_type: {
      type: 'string',
      minLength: 1,
      description: 'Producer action/source type, e.g. "memory.save".',
    },
    user_id: {
      type: 'string',
      minLength: 1,
      description: 'User scope identifier, e.g. "user_123".',
    },
    channel_id: {
      type: 'string',
      minLength: 1,
      description: 'Channel scope identifier, e.g. "channel_123".',
    },
    project_id: {
      type: 'string',
      minLength: 1,
      description: 'Project scope identifier, e.g. "project_123".',
    },
  },
};

const memorySaveSchema: ActionSchemaObject = {
  type: 'object',
  required: ['topic', 'kind', 'summary', 'details', 'source'],
  additionalProperties: false,
  properties: {
    topic: {
      type: 'string',
      minLength: 1,
      description: 'Memory topic key, e.g. "release_window".',
    },
    kind: {
      type: 'string',
      enum: MEMORY_KINDS,
      description: 'Memory record kind, e.g. "decision".',
    },
    summary: {
      type: 'string',
      minLength: 1,
      description: 'Short durable statement, e.g. "Release is Tuesday".',
    },
    details: {
      type: 'string',
      minLength: 1,
      description: 'Supporting explanation, e.g. "Owner confirmed after review".',
    },
    appliesWhen: {
      type: 'string',
      minLength: 1,
      description: 'One line saying when this lesson, preference, constraint, or workflow applies.',
    },
    steps: {
      type: 'array',
      minItems: 1,
      description:
        'Ordered steps for a workflow memory, e.g. ["Read the checklist", "Confirm the result"].',
      items: { type: 'string', minLength: 1 },
    },
    evidenceChecks: {
      type: 'array',
      description: 'Optional evidence a workflow must check, e.g. ["Read the current checklist"].',
      items: { type: 'string', minLength: 1 },
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Confidence from 0 to 1, e.g. 0.9.',
    },
    status: {
      type: 'string',
      enum: MEMORY_STATUSES,
      description: 'Lifecycle status, e.g. "active".',
    },
    scopes: {
      type: 'array',
      description:
        "Visibility scopes are global, user, channel, or project; omit to use the caller's admitted scopes.",
      items: scopeRefSchema,
    },
    source: {
      ...memorySourceSchema,
      description: 'Origin metadata, e.g. {"package":"owner-agent","source_type":"memory.save"}.',
    },
    eventDate: { type: 'string', minLength: 1, description: 'Event date text, e.g. "2026-09-25".' },
    eventDateTime: {
      type: 'number',
      description: 'Event time as epoch milliseconds, e.g. 1760000000000.',
    },
    itemId: {
      description: 'Optional related item id, e.g. "work_123" or null.',
      oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
    },
    actors: {
      type: 'array',
      description:
        'People and roles evidenced by the memory, e.g. [{"personId":"person_123","role":"reviewer"}].',
      items: {
        type: 'object',
        required: ['personId', 'role'],
        additionalProperties: false,
        properties: {
          personId: {
            type: 'string',
            minLength: 1,
            description: 'Actor person handle, e.g. "person_123".',
          },
          role: {
            type: 'string',
            minLength: 1,
            description: 'Role in the memory event, e.g. "reviewer".',
          },
        },
      },
    },
    links: {
      type: 'array',
      description:
        'Evidence or graph links, e.g. [{"relation":"derived_from","target":{"kind":"observation","id":"obs_123"}}].',
      items: recordLinkSchema,
    },
    replaces: {
      type: 'array',
      description:
        'Earlier records this one supersedes, e.g. [{"id":"mem_old","reason":"corrected"}].',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason'],
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            description: 'Existing memory id to replace, e.g. "mem_old".',
          },
          reason: {
            type: 'string',
            minLength: 1,
            description: 'Why the old record is replaced, e.g. "owner corrected it".',
          },
        },
      },
    },
  },
};

/**
 * The actions this build actually implements. `graph.query` reads the twin-edge
 * graph and `graph.identity.correct` is the registry_corrections transaction —
 * the action behind `registry_correct`; the `work.*` commands are the
 * commitment log's public write/read surface — the actions behind `task_create`
 * / `task_update` / `task_reclassify` / `task_list`; `operation.get` is how a
 * caller settles a call whose reply was lost.
 */
export function coreActionRegistrations(
  knowledge: Knowledge,
  adapter: DatabaseInstance,
  deps?: {
    /**
     * The host's effect-ledger read port for `work.changes`. The
     * `evidence_effects` store is host-opened, so the catalog takes the port —
     * absent means the action is absent (the catalog never lists an action it
     * cannot execute).
     */
    effects?: ChangesLedger;
    /**
     * The host's effect-ledger WRITE handle. A recallable write leaves a
     * receipt naming what caused it, so a crash between the write and the
     * batch ACK does not re-run the batch and save the same thing twice. The
     * store is host-opened like the read port above; absent means the write
     * still happens and leaves no receipt, which the coverage count shows.
     */
    effectLedger?: () => EffectAdapter | undefined;
    /**
     * The model the runtime opened, read at call time.
     *
     * A lookup rather than a value because the runtime opens after the catalog
     * is built — the same late binding every other host-opened dependency
     * uses. Absent means this host states no model, and the one action that
     * would ask for one (`memory.search` with `useReranking`) says so instead
     * of opening its own (§2.1).
     */
    runner?: () => TextCompletion | undefined;
  }
): ActionRegistration[] {
  const effects = deps?.effects;
  const effectLedger = deps?.effectLedger;
  const runner = deps?.runner;

  /** One receipt for a write recall can return. */
  const recordWriteReceipt = (context: ActionContext, action: string, ref: string | null): void => {
    const ledger = effectLedger?.();
    if (ledger === undefined || ref === null) {
      return;
    }
    const session = context.session;
    const change = {
      runId: session?.modelRunId ?? null,
      channelId: session?.channelId ?? null,
      kind: 'memory_write' as const,
      targetType: 'memory' as const,
      targetId: `${action}:${ref}`,
      payload: { action, ref },
      atMs: Date.now(),
    };
    const causes = (session?.causeEventIds ?? []).filter(isUsableCause);
    if (causes.length > 0) {
      recordEffect(ledger, { ...change, sourceEventIds: [...causes] });
    } else {
      // A run with no batch honestly records an unattributed change rather
      // than inventing a cause for it.
      recordUnattributedChange(ledger, change, 'owner_message');
    }
  };
  return [
    {
      contract: {
        name: 'graph.query',
        summary:
          'Read the work graph: overview roots, neighbors, paths, timelines, and hydrated details under the caller authority. Each view takes its own inputs: browse pages every visible edge and accepts only history, relations, asOf, limit and cursor; paths requires from and to; neighbors, timeline and detail need seeds or a search. search resolves a name spelling to its registered node or alias; an empty page with coverage.search_no_match means nothing is registered under that spelling. Ref kinds are memory, case, report, edge, raw, registry and observation; a work item is reached through its memory (revision) records.',
        inputSchema: workGraphQuerySchema,
        examples: [
          {
            title: 'Current neighbors of an item',
            input: { view: 'neighbors', seeds: [{ kind: 'registry', id: 'item_1' }] },
          },
          {
            title: 'Everything ever known about a memory, including what replaced it',
            input: {
              view: 'timeline',
              seeds: [{ kind: 'memory', id: 'judgment_…' }],
              history: 'all',
            },
          },
        ],
      },
      exec: (input, context) => {
        const maxSourceMs = context.readAllowance?.maxSourceMs;
        const access =
          maxSourceMs === undefined ? context.access : { ...context.access, maxSourceMs };
        return knowledge.queryGraph(input as WorkGraphQuery, access);
      },
    },
    {
      contract: {
        name: 'graph.node.put',
        summary:
          'Upsert one registry node: resolve by (kind, name, scopes) or create, then attach aliases and scope bindings. Alias resolution makes a retried put land on the same node — a store write bound to the caller authority, not a judgment command.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string' },
            name: { type: 'string' },
            // A blank alias is not a spelling, and neither is whitespace. The
            // deleted host tool trimmed and refused it ('invalid_alias'); the
            // contract says it now, so a caller reaching the action directly
            // meets the same rule instead of finding out from the store.
            aliases: { type: 'array', items: { type: 'string', pattern: '\\S' } },
            note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            parent_of: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  aliases: { type: 'array', items: { type: 'string', pattern: '\\S' } },
                },
                required: ['name'],
              },
            },
          },
          required: ['kind', 'name'],
        },
        examples: [
          {
            title: 'Register an item the agent named',
            input: { kind: 'item', name: 'ops channel', aliases: ['ops'] },
          },
        ],
      },
      exec: (input, context) => {
        const body = input as {
          kind?: string;
          name?: string;
          aliases?: string[];
          note?: string | null;
          parent_of?: Array<{ name: string; aliases?: string[] }>;
        };
        const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!kind || !name) {
          throw new JudgmentError('INVALID_INPUT', 'graph.node.put requires kind and name');
        }
        // Scope bindings come from the caller authority alone — the payload
        // carries no scopes, so a put can never self-grant visibility. Which
        // makes an authority stating NO scope the one case a put must refuse:
        // the node would be bound to nothing, and whether that reads as
        // invisible or as unfiltered is the reader's accident, not a decision
        // anyone made. graph.identity.correct already refuses it
        // (registry/corrections.ts, 'At least one signed scope is required');
        // this said the same thing one layer out, in the host tool case that
        // called this action, where a caller reaching the action directly
        // never met it.
        if (context.access.scopes.length === 0) {
          throw new JudgmentError(
            'INVALID_SCOPE',
            'graph.node.put requires at least one scope on the caller authority'
          );
        }
        return upsertNode(adapter, {
          kind,
          name,
          aliases: body.aliases ?? [],
          note: body.note ?? null,
          scopes: context.access.scopes as RegistryScopeRef[],
          children: body.parent_of,
        });
      },
    },
    {
      contract: {
        name: 'graph.identity.correct',
        summary:
          'Append one identity correction — alias, merge, split, or edge-endpoint reassignment — inside the registry_corrections transaction. operationId is the command id; the caller authority scopes the result, input never grants it.',
        inputSchema: identityCorrectSchema,
        examples: [
          {
            title: 'Attach the name the owner actually uses',
            input: {
              expectedRevision: 3,
              reason: 'owner calls it the ops channel',
              operation: 'add_alias',
              nodeId: 'item_1',
              alias: 'ops channel',
            },
          },
          {
            title: 'Fold a duplicate into its survivor',
            input: {
              expectedRevision: 4,
              reason: 'two rows name the same vendor',
              operation: 'merge',
              survivorId: 'item_1',
              memberIds: ['item_2'],
            },
          },
        ],
      },
      exec: (input, context) =>
        knowledge.correctIdentity(
          {
            ...(input as Omit<IdentityCorrection, 'commandId'>),
            commandId: requiredOperationId(context, 'graph.identity.correct'),
          } as IdentityCorrection,
          context.access
        ),
    },
    {
      contract: {
        name: 'memory.save',
        // What this writes, recall can return.
        recallableWrite: true,
        summary:
          "Append one judgment record. Explicit links attach visible evidence; replaces supersedes named visible records while preserving history. Matching topic alone never replaces. Access is the only authority — scopes in input are checked against it, and provenance comes from call authority and host-stated session facts. Scopes are global, user, channel, or project; omitted scopes use the caller's admitted scopes. operationId is the command id; a retry replays the original receipt.",
        inputSchema: memorySaveSchema,
        examples: [
          {
            title: 'Record a decision the owner made',
            input: {
              topic: 'deploy_window',
              kind: 'decision',
              summary: 'Deploys happen Tuesday 10:00 KST',
              details: 'Owner confirmed the fixed window after the June freeze.',
              source: { package: 'my-app', source_type: 'mama_save' },
            },
          },
          {
            title: 'Correct an earlier memory after reading preserved evidence',
            input: {
              topic: 'source_access',
              kind: 'fact',
              summary: 'The preserved source is readable',
              details: 'A source.read call returned the original observation.',
              source: { package: 'my-app', source_type: 'mama_save' },
              links: [{ relation: 'derived_from', target: { kind: 'observation', id: 'obs_123' } }],
              replaces: [{ id: 'judgment_old', reason: 'the original was read successfully' }],
            },
          },
          {
            title: 'Record an approved workflow',
            input: {
              topic: 'release_review',
              kind: 'workflow',
              summary: 'Review a release before sending it',
              details: 'A short procedure the owner approved.',
              appliesWhen: 'When preparing a release for review',
              steps: ['Read the checklist', 'Confirm the build', 'Send the summary'],
              evidenceChecks: ['Read the current checklist'],
              source: { package: 'my-app', source_type: 'mama_save' },
            },
          },
        ],
      },
      exec: async (input, context) => {
        const saved = await saveJudgmentRecord(
          adapter,
          input as PublicSaveMemoryInput,
          context.access,
          requiredOperationId(context, 'memory.save'),
          context.session
        );
        recordWriteReceipt(context, 'memory.save', saved.id ?? null);
        return saved;
      },
    },
    {
      contract: {
        name: 'memory.update',
        // What this writes, recall can return.
        recallableWrite: true,
        summary:
          'Append one outcome amendment to a memory record — the append-only judgment row and the maintained decisions projection move in one transaction. Outcome is SUCCESS, FAILED, or PARTIAL (case-insensitive).',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Memory id to amend, e.g. "mem_123".' },
            outcome: { type: 'string', description: 'Outcome label, e.g. "SUCCESS".' },
            failure_reason: {
              type: 'string',
              description: 'Why the outcome failed, e.g. "missing review".',
            },
            limitation: {
              type: 'string',
              description: 'Known limitation, e.g. "only one channel checked".',
            },
          },
          required: ['id', 'outcome'],
        },
        examples: [
          {
            title: 'Mark a decision as having failed in the field',
            input: {
              id: 'decision_deploy_window_1',
              outcome: 'failed',
              failure_reason: 'the Tuesday window collided with the provider maintenance',
            },
          },
        ],
      },
      exec: async (input, context) => {
        const body = input as {
          id?: string;
          outcome?: string;
          failure_reason?: string;
          limitation?: string;
        };
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        const outcome = typeof body.outcome === 'string' ? body.outcome.trim().toUpperCase() : '';
        if (!id) {
          throw new JudgmentError('INVALID_INPUT', 'memory.update requires id');
        }
        if (!['SUCCESS', 'FAILED', 'PARTIAL'].includes(outcome)) {
          throw new JudgmentError(
            'INVALID_INPUT',
            'memory.update outcome must be SUCCESS, FAILED, or PARTIAL'
          );
        }
        const bindings = adapter
          .prepare(
            `SELECT s.kind, s.external_id AS id FROM memory_scope_bindings b
           JOIN memory_scopes s ON s.id = b.scope_id WHERE b.memory_id = ?`
          )
          .all(id) as MemoryScopeRef[];
        if (
          bindings.length > 0 &&
          !bindings.some((binding) =>
            context.access.scopes.some(
              (scope) => scope.kind === binding.kind && scope.id === binding.id
            )
          )
        ) {
          throw new JudgmentError(
            'SCOPE_DENIED',
            'Memory record is outside the admitted write scopes'
          );
        }
        await updateOutcomeInAdapter(adapter, id, {
          outcome,
          failure_reason: body.failure_reason ?? null,
          limitation: body.limitation ?? null,
        });
        recordWriteReceipt(context, 'memory.update', id);
        return { id, outcome };
      },
    },
    {
      contract: {
        name: 'memory.checkpoint.save',
        summary:
          'Write one session checkpoint — the durable hand-off record a later turn restores work from. Not a judgment and not scope-bound; the row is what it says.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: {
              type: 'string',
              description: 'Checkpoint summary, e.g. "Projection handle is wired".',
            },
            open_files: {
              type: 'array',
              description: 'Files to reopen, e.g. ["src/runtime.ts"].',
              items: { type: 'string' },
            },
            next_steps: {
              type: 'string',
              description: 'Next work to resume, e.g. "run the integration test".',
            },
          },
          required: ['summary'],
        },
        examples: [
          {
            title: 'Save the session state before stopping',
            input: {
              summary: 'Goal: migrate the socket owner. Evidence: runtime.ts mounted.',
              next_steps: 'convert the last direct caller to the client path',
            },
          },
        ],
      },
      exec: async (input, context) => {
        const body = input as {
          summary?: string;
          open_files?: string[];
          next_steps?: string;
        };
        const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
        if (!summary) {
          throw new JudgmentError('INVALID_INPUT', 'memory.checkpoint.save requires summary');
        }
        const id = await saveCheckpointInAdapter(
          adapter,
          summary,
          body.open_files ?? [],
          body.next_steps ?? '',
          // The transcript is the host's to state; a caller that has none saves a
          // checkpoint without one rather than inventing it.
          [...(context.session?.recentConversation ?? [])]
        );
        return { id: String(id) };
      },
    },
    {
      contract: {
        name: 'memory.search',
        summary:
          'Search or list memory records under the caller authority. Omitted scopes read the admitted corpus; explicit scopes must be a subset of it. With a query this is the semantic recall path (vector + lexical fusion, learned ranker when enabled), each hit lists the records its stated links reach (links: id, topic, relation, reason, corrected_by), and a result reached through a link names the hit it came from (related_to), the relation (graph_source), the reason (edge_reason) and any correction (edge_corrected_by); a hit that is one revision of a work item names it (work_item: commitment_id, revision, head_revision), and an earlier revision can rank above the head that corrected it, so open the head before answering from it; without one it is the exact topic-prefix ledger read.',
        inputSchema: memorySearchSchema,
        examples: [
          {
            title: 'Recall what was decided about deploys',
            input: { query: 'deploy window decision', limit: 5 },
          },
          {
            title: 'Every record filed under one item key',
            input: { topicPrefix: 'item_0001', limit: 30 },
          },
        ],
      },
      exec: async (input, context) => {
        const query = input as {
          query?: string;
          limit?: number;
          kind?: (typeof MEMORY_KINDS)[number];
          scopes?: MemoryScopeRef[];
          threshold?: number;
          strict?: boolean;
          strictness?: 'recall' | 'balanced' | 'strict';
          disableRecency?: boolean;
          includeRelated?: boolean;
          topicPrefix?: string;
          minLexicalSupport?: boolean;
          diagnostics?: boolean;
          rerankWithLearned?: boolean;
          useReranking?: boolean;
        };
        const scopes = boundReadScopesFor(context.access, query.scopes);
        if (scopes.length === 0) {
          // No admitted scopes means no visible corpus — an honest empty page,
          // not the legacy unbounded scan.
          return { success: true, results: [], count: 0 };
        }
        if (typeof query.query !== 'string' || query.query.trim().length === 0) {
          const rows = await listDecisionsInAdapter(adapter, {
            limit: query.limit,
            kind: query.kind,
            topicPrefix: query.topicPrefix,
            scopes,
          });
          const items = Array.isArray(rows) ? rows : [];
          return { success: true, results: items, count: items.length };
        }
        const result = (await suggestInAdapter(adapter, query.query, {
          limit: query.limit,
          kind: query.kind,
          threshold: query.threshold,
          strict: query.strict,
          strictness: query.strictness,
          disableRecency: query.disableRecency,
          includeRelated: query.includeRelated,
          topicPrefix: query.topicPrefix,
          minLexicalSupport: query.minLexicalSupport,
          diagnostics: query.diagnostics,
          rerankWithLearned: query.rerankWithLearned,
          useReranking: query.useReranking,
          ...(runner?.() ? { runner: runner() } : {}),
          scopes,
        })) as Record<string, unknown> | null;
        if (!result || typeof result !== 'object') {
          return {
            success: false,
            code: 'suggest_returned_null',
            error: 'Search failed: suggest() returned no result for query',
            results: [],
            count: 0,
          };
        }
        return result;
      },
    },
    {
      contract: {
        name: 'memory.checkpoint.load',
        summary:
          'Load the latest active session checkpoint — the durable hand-off record a later turn restores work from. Returns null when none exists.',
        inputSchema: memoryCheckpointLoadSchema,
        examples: [{ title: 'Restore the last checkpoint', input: {} }],
      },
      exec: (_input, _context) => loadCheckpointInAdapter(adapter),
    },
    {
      contract: {
        name: 'memory.checkpoint.list',
        summary:
          'List recent session checkpoints, newest first — the hand-off records this workspace kept, including superseded ones. `limit` defaults to 20 and is capped at 50.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'number', description: 'Maximum checkpoints, e.g. 10.' },
          },
        },
        examples: [{ title: 'What was handed off recently', input: { limit: 10 } }],
      },
      exec: async (input) => {
        const raw = Number((input as { limit?: unknown }).limit);
        const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 50) : 20;
        const checkpoints = await listCheckpointsInAdapter(adapter, limit);
        return { checkpoints, count: checkpoints.length };
      },
    },
    {
      contract: {
        name: 'memory.read:listing',
        summary:
          'Decisions under the admitted scopes as a list: `order: recent` is what changed last, `order: stale` is what has gone longest untouched, and `status` narrows to one lifecycle state. The default compact view keeps the complete decision and a short reasoning preview; use memory.search(topicPrefix) for one topic or `detail: full` for complete batch reasoning. `limit` defaults to 50 and is capped at 200.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', description: 'Memory lifecycle filter, e.g. "active".' },
            order: {
              type: 'string',
              enum: ['recent', 'stale'],
              description: 'List order, e.g. "recent".',
            },
            limit: { type: 'number', description: 'Maximum listed memories, e.g. 20.' },
            detail: {
              type: 'string',
              enum: ['compact', 'full'],
              description: 'Reasoning detail, e.g. "compact".',
            },
            scopes: {
              type: 'array',
              description: 'Admitted scope filter, e.g. [{"kind":"project","id":"project_123"}].',
              items: scopeRefSchema,
            },
          },
        },
        examples: [
          { title: 'Active decisions going stale', input: { status: 'active', order: 'stale' } },
          { title: 'What changed lately', input: { order: 'recent', limit: 20 } },
          { title: 'Read complete reasoning for the scoped list', input: { detail: 'full' } },
        ],
      },
      exec: async (input, context) => {
        const query = input as {
          status?: unknown;
          order?: unknown;
          limit?: unknown;
          detail?: unknown;
          scopes?: MemoryScopeRef[];
        };
        const scopes = boundReadScopesFor(context.access, query.scopes);
        const decisions = await readDecisionListing(adapter, scopes, {
          ...(typeof query.status === 'string' ? { status: query.status } : {}),
          ...(query.order === 'stale' ? { order: 'stale' as const } : { order: 'recent' as const }),
          ...(Number.isFinite(Number(query.limit)) ? { limit: Number(query.limit) } : {}),
        });
        if (query.detail === 'full') return { decisions, count: decisions.length };
        const compact = decisions.map(({ reasoning, ...row }) => {
          const points = Array.from(reasoning ?? '');
          return {
            ...row,
            reasoningPreview: points.slice(0, 160).join(''),
            reasoningTruncated: points.length > 160,
          };
        });
        return { decisions: compact, count: compact.length };
      },
    },
    {
      contract: {
        name: 'memory.read:projects',
        summary:
          'Project rollups over the admitted scopes: how many active decisions each project holds and when it last moved. Name a `project` to get that project\u2019s decisions instead, still bounded by what the caller admits.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: { type: 'string', description: 'Project label to inspect, e.g. "release".' },
            limit: { type: 'number', description: 'Maximum project decisions, e.g. 20.' },
            scopes: {
              type: 'array',
              description: 'Admitted scope filter, e.g. [{"kind":"project","id":"project_123"}].',
              items: scopeRefSchema,
            },
          },
        },
        examples: [
          { title: 'Which projects are busy', input: {} },
          { title: 'What one project holds', input: { project: 'mama', limit: 20 } },
        ],
      },
      exec: async (input, context) => {
        const query = input as { project?: unknown; limit?: unknown; scopes?: MemoryScopeRef[] };
        const scopes = boundReadScopesFor(context.access, query.scopes);
        const project = typeof query.project === 'string' ? query.project.trim() : '';
        if (project) {
          const decisions = await readProjectDecisions(
            adapter,
            scopes,
            project,
            Number.isFinite(Number(query.limit)) ? Number(query.limit) : 50
          );
          return { project, decisions, count: decisions.length };
        }
        const projects = await readProjectRollups(adapter, scopes);
        return { projects, count: projects.length };
      },
    },
    {
      contract: {
        name: 'memory.read:graph',
        summary:
          'The decision graph this caller may see: `view: graph` returns a bounded page of nodes with the edges joining admitted nodes and the admitted total; `nodes` returns the named ids; `detail` returns one record in full. Every view is bounded by the admitted scopes.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            view: {
              type: 'string',
              enum: ['graph', 'nodes', 'detail'],
              description: 'Memory graph view, e.g. "detail".',
            },
            id: { type: 'string', description: 'One memory id for detail, e.g. "mem_123".' },
            ids: {
              type: 'array',
              description: 'Memory ids for node lookup, e.g. ["mem_123"].',
              items: { type: 'string' },
            },
            limit: { type: 'number', description: 'Maximum graph rows, e.g. 100.' },
            scopes: {
              type: 'array',
              description: 'Admitted scope filter, e.g. [{"kind":"project","id":"project_123"}].',
              items: scopeRefSchema,
            },
          },
        },
        examples: [
          { title: 'The graph a viewer draws', input: { view: 'graph', limit: 100 } },
          { title: 'One decision in full', input: { view: 'detail', id: 'judgment_…' } },
        ],
      },
      exec: async (input, context) => {
        const query = input as {
          view?: unknown;
          id?: unknown;
          ids?: unknown;
          limit?: unknown;
          scopes?: MemoryScopeRef[];
        };
        const scopes = boundReadScopesFor(context.access, query.scopes);
        const view = typeof query.view === 'string' ? query.view : 'graph';
        const rawLimit = Number(query.limit);
        const limit = Number.isFinite(rawLimit)
          ? Math.min(Math.max(Math.floor(rawLimit), 1), 1000)
          : null;
        if (view === 'detail') {
          const id = typeof query.id === 'string' ? query.id.trim() : '';
          if (!id) {
            throw new JudgmentError('INVALID_INPUT', 'memory.read:graph detail requires an id');
          }
          const [node] = await readGraphNodes(adapter, scopes, { ids: [id], limit: 1 });
          return { node: node ?? null };
        }
        if (view === 'nodes') {
          const ids = Array.isArray(query.ids)
            ? query.ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
            : [];
          if (ids.length === 0) {
            return { nodes: [] };
          }
          return { nodes: await readGraphNodes(adapter, scopes, { ids, limit: null }) };
        }
        const [nodes, edges, total] = await Promise.all([
          readGraphNodes(adapter, scopes, { limit }),
          readGraphEdges(adapter, scopes),
          countGraphNodes(adapter, scopes),
        ]);
        return { nodes, edges, total };
      },
    },
    {
      contract: {
        name: 'memory.read:stats',
        summary:
          'Counts over the memory this caller may see: decisions in total and over the last week and month, the outcome breakdown, the five busiest topics, and how many checkpoints exist. Bounded by the admitted scopes — a principal that admits nothing counts nothing.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scopes: {
              type: 'array',
              description: 'Admitted scope filter, e.g. [{"kind":"project","id":"project_123"}].',
              items: scopeRefSchema,
            },
          },
        },
        examples: [{ title: 'What this workspace holds', input: {} }],
      },
      exec: async (input, context) => {
        const query = input as { scopes?: MemoryScopeRef[] };
        const scopes = boundReadScopesFor(context.access, query.scopes);
        return readMemoryStatsInAdapter(adapter, scopes);
      },
    },
    {
      contract: {
        name: 'memory.read:topic',
        summary:
          'Read the topic recall bundle — the profile, ranked memories, and graph context a question rests on. Omitted scopes read the admitted corpus; explicit scopes must be a subset of it. An admitted-empty caller gets an empty bundle, never an unbounded scan.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: {
              type: 'string',
              description: 'Topic text to recall, e.g. "release decision".',
            },
            scopes: {
              type: 'array',
              description: 'Admitted scope filter, e.g. [{"kind":"project","id":"project_123"}].',
              items: scopeRefSchema,
            },
          },
          required: ['query'],
        },
        examples: [
          {
            title: 'Recall everything relevant to a topic',
            input: { query: 'deploy freeze decision' },
          },
        ],
      },
      exec: async (input, context) => {
        const query = input as { query?: string; scopes?: MemoryScopeRef[] };
        const scopes = boundReadScopesFor(context.access, query.scopes);
        if (typeof query.query !== 'string' || query.query.trim().length === 0) {
          throw new JudgmentError('INVALID_INPUT', 'memory.read:topic requires a non-empty query');
        }
        // Scrubbed and narrowed to the fields a read may answer with. This
        // lived in a host tool case that wrapped the action, so a caller naming
        // memory.read:topic got unredacted full records while
        // memory.read:provenance below scrubbed its excerpts.
        return sanitizeRecallBundle(
          await recallMemory(adapter, query.query, { scopes, includeProfile: true })
        );
      },
    },
    {
      contract: {
        name: 'memory.read:provenance',
        summary:
          "Resolve a stored memory's recorded cause and derived_from observation links. Every supporting observation is checked against the current caller's source-read authority; a memory id grants no access. Omit scopes to use the admitted read scope. Excerpts are scrubbed with the recall redaction.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // Nonblank at the contract, not only in exec: the deleted host tool
            // trimmed and refused a blank handle before dispatching, and a
            // whitespace id is not a handle.
            memory_id: {
              type: 'string',
              pattern: '\\S',
              description: 'Memory id whose provenance to resolve, e.g. "mem_123".',
            },
            scopes: {
              type: 'array',
              description: 'Admitted scope filter, e.g. [{"kind":"project","id":"project_123"}].',
              items: scopeRefSchema,
            },
          },
          required: ['memory_id'],
        },
        examples: [
          {
            title: 'What does this decision rest on',
            input: { memory_id: 'mem_7f3a' },
          },
        ],
      },
      exec: async (input, context) => {
        const body = input as { memory_id?: string; scopes?: MemoryScopeRef[] };
        const scopes = boundReadScopesFor(context.access, body.scopes);
        if (typeof body.memory_id !== 'string' || body.memory_id.trim().length === 0) {
          throw new JudgmentError(
            'INVALID_INPUT',
            'memory.read:provenance requires a non-empty memory_id'
          );
        }
        const allowance = context.readAllowance;
        return resolveMemoryProvenanceLive(adapter, body.memory_id, {
          scopes,
          connectors: allowance?.connectors ?? [],
          wideConnectors: allowance?.wideConnectors ?? [],
          ...(allowance?.channels ? { channels: allowance.channels } : {}),
          ...(allowance?.projectIds === undefined ? {} : { projectIds: allowance.projectIds }),
          tenantId: allowance?.tenantId ?? null,
          minObservedMs: allowance?.minObservedMs ?? null,
          maxObservedMs: allowance?.maxObservedMs ?? null,
          maxSourceMs: allowance?.maxSourceMs ?? null,
          principalId: context.access.principalId,
          redact: (text: string) => sanitizeRecallText(text) ?? '',
        });
      },
    },
    {
      contract: {
        name: 'memory.read:record',
        summary:
          'Read one complete memory record by id within the admitted memory scopes. Returns the stored record content and structured workflow steps, without source excerpts or provenance material. An id is not a capability.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            memory_id: {
              type: 'string',
              pattern: '\\S',
              description: 'Memory id to read, e.g. "mem_123".',
            },
            scopes: {
              type: 'array',
              description: 'Admitted scope filter, e.g. [{"kind":"project","id":"project_123"}].',
              items: scopeRefSchema,
            },
          },
          required: ['memory_id'],
        },
        examples: [
          { title: 'Read a guidance record from its index id', input: { memory_id: 'mem_123' } },
        ],
      },
      exec: async (input, context) => {
        const body = input as { memory_id?: string; scopes?: MemoryScopeRef[] };
        const memoryId = typeof body.memory_id === 'string' ? body.memory_id.trim() : '';
        if (!memoryId) {
          throw new JudgmentError(
            'INVALID_INPUT',
            'memory.read:record requires a non-empty memory_id'
          );
        }
        const scopes = boundReadScopesFor(context.access, body.scopes);
        const record = await readMemoryRecordById(adapter, memoryId, scopes);
        return {
          record: record
            ? {
                id: record.id,
                kind: record.kind,
                topic: record.topic,
                summary: record.summary,
                details: record.details,
                ...(record.applies_when === undefined ? {} : { appliesWhen: record.applies_when }),
                ...(record.steps === undefined ? {} : { steps: record.steps }),
                ...(record.evidence_checks === undefined
                  ? {}
                  : { evidenceChecks: record.evidence_checks }),
                confidence: record.confidence,
                status: record.status,
                createdAt: record.created_at,
                updatedAt: record.updated_at,
              }
            : null,
        };
      },
    },
    {
      contract: {
        name: 'memory.retire',
        recallableWrite: true,
        summary:
          'Retire one visible memory record by appending a stale or superseded status amendment with its reason. The original record remains readable and the action returns the amendment receipt id.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            memory_id: {
              type: 'string',
              pattern: '\\S',
              description: 'Memory id to retire, e.g. "mem_123".',
            },
            status: {
              type: 'string',
              enum: ['stale', 'superseded'],
              description: 'Why the record no longer applies, e.g. "stale".',
            },
            reason: {
              type: 'string',
              minLength: 1,
              description:
                'Why this guidance was withdrawn or replaced, e.g. "The process changed".',
            },
            scopes: {
              type: 'array',
              description: 'Admitted scope filter, e.g. [{"kind":"project","id":"project_123"}].',
              items: scopeRefSchema,
            },
          },
          required: ['memory_id', 'status', 'reason'],
        },
        examples: [
          {
            title: 'Retire a withdrawn preference',
            input: {
              memory_id: 'mem_123',
              status: 'stale',
              reason: 'The owner withdrew this preference.',
            },
          },
        ],
      },
      exec: async (input, context) => {
        const body = input as {
          memory_id?: string;
          status?: string;
          reason?: string;
          scopes?: MemoryScopeRef[];
        };
        // A read grant may expose a memory record, but it cannot authorize changing its status.
        const writeAccess = { ...context.access, readScopes: [] };
        const scopes = boundReadScopesFor(writeAccess, body.scopes);
        const status = body.status;
        if (status !== 'stale' && status !== 'superseded') {
          throw new JudgmentError(
            'INVALID_INPUT',
            'memory.retire status must be stale or superseded'
          );
        }
        const retired = await retireMemoryRecord(
          adapter,
          {
            memoryId: typeof body.memory_id === 'string' ? body.memory_id : '',
            status,
            reason: typeof body.reason === 'string' ? body.reason : '',
          },
          { ...writeAccess, scopes },
          requiredOperationId(context, 'memory.retire')
        );
        recordWriteReceipt(context, 'memory.retire', retired.id);
        return retired;
      },
    },
    {
      contract: {
        name: 'memory.read:experience',
        summary:
          'Read execution evidence — the tool-trace ledger. One trace by trace_id, or a bounded page filtered by run_id/tool_name/cursor. The caller authority scopes the read: principalId becomes owner_scope, the single admitted project scope becomes project_id, and a non-owner caller must carry a channel scope that becomes channel_id. A trace id is never a capability — input cannot widen the scope.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            trace_id: {
              type: 'string',
              minLength: 1,
              description: 'One tool trace handle, e.g. "trace_123".',
            },
            run_id: {
              type: 'string',
              minLength: 1,
              description: 'Model run filter, e.g. "run_123".',
            },
            tool_name: {
              type: 'string',
              minLength: 1,
              description: 'Tool name filter, e.g. "source.read".',
            },
            cursor: {
              type: 'string',
              minLength: 1,
              description: 'Opaque trace page cursor, e.g. "cursor_25".',
            },
            limit: { type: 'number', description: 'Maximum traces, e.g. 25.' },
            evidence_only: {
              type: 'boolean',
              description: 'Return only evidence-bearing traces, e.g. true.',
            },
            offset: { type: 'number', description: 'Character offset inside one trace, e.g. 0.' },
            chars: { type: 'number', description: 'Maximum trace characters, e.g. 4000.' },
          },
        },
        examples: [
          { title: 'Read one execution trace', input: { trace_id: 'trace_abc' } },
          { title: 'List recent tool evidence for a run', input: { run_id: 'run_1', limit: 10 } },
        ],
      },
      exec: async (input, context) => {
        const body = input as {
          trace_id?: string;
          run_id?: string;
          tool_name?: string;
          cursor?: string;
          limit?: number;
          evidence_only?: boolean;
          offset?: number;
          chars?: number;
        };
        // Execution evidence answers to the RUN, not to the caller's memory
        // scopes: exactly one project, the owner lane or the principal, and a
        // channel for a member. The host states that as a session fact, which
        // is why this reads it rather than re-deriving it from `access` --
        // a host used to rewrite the principal's scopes for this one tool name,
        // and an access object with two authorities on it is what that cost.
        const evidence = context.session?.runEvidenceScope;
        if (!evidence) {
          throw new JudgmentError(
            'SCOPE_DENIED',
            'memory.read:experience requires the run evidence authority'
          );
        }
        const isOwnerRuntime = evidence.ownerScope === 'owner:runtime';
        if (!isOwnerRuntime && !evidence.channelId) {
          throw new JudgmentError(
            'SCOPE_DENIED',
            'memory.read:experience member reads require an admitted channel scope'
          );
        }
        const scope = {
          owner_scope: evidence.ownerScope,
          project_id: evidence.projectId,
          ...(isOwnerRuntime ? {} : { channel_id: evidence.channelId! }),
        };
        if (body.trace_id !== undefined) {
          if (
            body.run_id !== undefined ||
            body.tool_name !== undefined ||
            body.cursor !== undefined ||
            body.limit !== undefined ||
            body.evidence_only !== undefined
          ) {
            throw new JudgmentError(
              'INVALID_INPUT',
              'memory.read:experience trace reads accept only offset and chars beside trace_id'
            );
          }
          const offset = body.offset ?? 0;
          const chars = body.chars ?? 4000;
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(chars) ||
            chars < 1 ||
            chars > 8000
          ) {
            throw new JudgmentError('INVALID_INPUT', 'memory.read:experience offset/chars invalid');
          }
          const trace = await readToolTrace(adapter, body.trace_id, scope);
          if (!trace) {
            throw new JudgmentError(
              'NOT_FOUND',
              `Execution evidence unavailable: ${body.trace_id}`
            );
          }
          const text = Array.from(trace.evidence_json ?? '');
          if (offset > text.length) {
            throw new JudgmentError('INVALID_INPUT', 'memory.read:experience offset out of range');
          }
          const end = Math.min(offset + chars, text.length);
          return {
            trace: { ...trace, evidence_json: null },
            content: text.slice(offset, end).join(''),
            offset,
            total_chars: text.length,
            next_offset: end < text.length ? end : null,
          };
        }
        return listToolTraces(adapter, {
          ...scope,
          ...(body.run_id !== undefined ? { model_run_id: body.run_id } : {}),
          ...(body.tool_name !== undefined ? { tool_name: body.tool_name } : {}),
          ...(body.cursor !== undefined ? { cursor: body.cursor } : {}),
          ...(body.limit !== undefined ? { limit: body.limit } : {}),
          ...(body.evidence_only !== undefined ? { evidence_only: body.evidence_only } : {}),
        });
      },
    },
    {
      contract: {
        name: 'source.ingest',
        summary:
          'Store one explicitly provided raw observation — a content body or one whole conversation — under the caller authority. One call is one observation: no extraction, no judgment rows, no per-message split. The operationId is the command id, so retransmitting the same call replays the stored receipt instead of writing a second observation.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                required: ['role', 'content'],
                additionalProperties: false,
                properties: {
                  role: { type: 'string' },
                  content: { type: 'string' },
                },
              },
            },
            source: {
              type: 'object',
              additionalProperties: false,
              properties: {
                connector: { type: 'string' },
                id: { type: 'string' },
                package: { type: 'string' },
                source_type: { type: 'string' },
              },
            },
            session_date: { type: 'string' },
            scopes: { type: 'array', items: scopeRefSchema },
            metadata: { type: 'object' },
          },
        },
        examples: [
          {
            title: 'Import a conversation as one raw observation',
            input: {
              messages: [
                { role: 'user', content: 'ship on Friday?' },
                { role: 'assistant', content: 'yes, after the freeze lifts' },
              ],
              source: { connector: 'conversation:mcp_ingest_conversation' },
            },
          },
        ],
      },
      exec: async (input, context) => {
        const body = input as {
          content?: string;
          messages?: Array<{ role?: string; content?: string }>;
          source?: { connector?: string; id?: string; package?: string; source_type?: string };
          session_date?: string;
          scopes?: MemoryScopeRef[];
          metadata?: Record<string, JsonValue>;
        };
        const hasContent = typeof body.content === 'string' && body.content.trim().length > 0;
        const messages = Array.isArray(body.messages)
          ? body.messages.filter(
              (m) => typeof m?.role === 'string' && typeof m?.content === 'string'
            )
          : [];
        const hasMessages = messages.length > 0;
        if (hasContent === hasMessages) {
          throw new JudgmentError(
            'INVALID_INPUT',
            'source.ingest requires exactly one of content or a non-empty messages array'
          );
        }
        const commandId = requiredOperationId(context, 'source.ingest');
        const sessionMs = body.session_date === undefined ? null : Date.parse(body.session_date);
        if (body.session_date !== undefined && !Number.isFinite(sessionMs)) {
          throw new JudgmentError(
            'INVALID_INPUT',
            `source.ingest session_date is not a parseable date: ${body.session_date}`
          );
        }
        const connector =
          body.source?.connector ??
          (body.source?.source_type ? `conversation:${body.source.source_type}` : 'explicit');
        if (connector.startsWith('owner-message:') || connector.startsWith('owner-result:')) {
          throw new JudgmentError(
            'INVALID_INPUT',
            'source.ingest cannot use a reserved source prefix'
          );
        }
        const receipt = await ingestSource(
          {
            commandId,
            source: { connector, id: body.source?.id ?? commandId },
            body: hasContent
              ? (body.content as string)
              : messages.map((m) => `${m.role}: ${m.content}`).join('\n'),
            sourceAt: sessionMs,
            metadata: {
              ...(body.metadata ?? {}),
              ...(body.source ? { source: body.source as unknown as JsonValue } : {}),
              ...(hasMessages
                ? {
                    message_count: messages.length,
                    roles: messages.map((m) => m.role as string),
                    session_date: body.session_date ?? null,
                  }
                : {}),
            },
            ...(body.scopes ? { scopes: body.scopes } : {}),
            event: { reason: 'source ingest command' },
          },
          context.access,
          { adapter }
        );
        // The observation id is the ref later reads (source.read) name.
        return { ...receipt, observationRef: receipt.observationId };
      },
    },
    {
      contract: {
        name: 'work.list',
        summary:
          'Page the owner-work commitment log under the caller authority — coverage reasons name rows outside the caller scopes rather than shortening the page silently.',
        inputSchema: workListSchema,
        examples: [
          { title: 'The current board, one page', input: { limit: 25 } },
          {
            title: 'What the board looked like then',
            input: { asOf: 1760000000000, history: 'all' },
          },
        ],
      },
      exec: (input, context) => knowledge.readWork(input as WorkRead, context.access),
    },
    {
      contract: {
        name: 'work.show',
        summary:
          'One commitment by commitmentId (or rowId): the revision chain by default, or every revision with full values when history: all.',
        inputSchema: workShowSchema,
        examples: [
          { title: 'One task as it stands', input: { commitmentId: 'commitment_…' } },
          {
            title: 'Every revision it ever took',
            input: { commitmentId: 'commitment_…', history: 'all' },
          },
        ],
      },
      exec: (input, context) => {
        const body = input as WorkRead;
        if (body.commitmentId === undefined && body.rowId === undefined) {
          throw new JudgmentError(
            'INVALID_COMMAND',
            'work.show requires commitmentId or rowId: name the commitment'
          );
        }
        return knowledge.readWork(
          body.history === undefined ? { ...body, history: 'chain' } : body,
          context.access
        );
      },
    },
    ...(effects !== undefined
      ? [
          {
            contract: {
              name: 'work.changes',
              summary:
                'What this system durably changed in a window, with coverage. Use view=turn_inputs and an effect_id to page the accepted inputs in its native model turn; that relation is turn context, not an assertion that every input directly caused the effect.',
              inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  view: {
                    type: 'string',
                    enum: ['changes', 'turn_inputs'],
                    description: 'Changes view, e.g. "changes".',
                  },
                  effect_id: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Effect id for native-turn inputs, e.g. 1.',
                  },
                  cursor: {
                    type: 'integer',
                    minimum: 0,
                    description: 'Numeric effect cursor, e.g. 0.',
                  },
                  since: { type: 'string', description: 'Window start, e.g. "7d" or an ISO time.' },
                  target_type: {
                    type: 'string',
                    enum: [...CHANGES_READ_TARGET_TYPES],
                    description: 'Changed target type, e.g. "memory".',
                  },
                  cause_state: {
                    type: 'string',
                    enum: [...CHANGES_READ_CAUSE_STATES],
                    description: 'Cause attribution state, e.g. "unattributed".',
                  },
                  limit: {
                    description: 'Maximum changes or inputs, e.g. 25.',
                    oneOf: [
                      { type: 'integer', minimum: 1 },
                      { type: 'string', minLength: 1 },
                    ],
                  },
                },
              } satisfies ActionSchemaObject,
              examples: [
                { title: 'What changed today', input: {} },
                {
                  title: 'Unexplained task changes this week',
                  input: { since: '7d', target_type: 'task', cause_state: 'unattributed' },
                },
                {
                  title: 'Inputs in one effect’s native turn',
                  input: { view: 'turn_inputs', effect_id: 1, limit: 25 },
                },
              ],
            },
            exec: (input: unknown, context) => {
              const body = input as Record<string, unknown>;
              if (body.view === 'turn_inputs') {
                if (
                  body.since !== undefined ||
                  body.target_type !== undefined ||
                  body.cause_state !== undefined
                ) {
                  throw new JudgmentError(
                    'INVALID_INPUT',
                    'turn_inputs reads one effect; window filters do not apply'
                  );
                }
                const effectId = body.effect_id;
                const limit = body.limit === undefined ? 25 : Number(body.limit);
                const afterId = body.cursor === undefined ? 0 : body.cursor;
                if (
                  typeof effectId !== 'number' ||
                  !Number.isSafeInteger(effectId) ||
                  effectId < 1 ||
                  !Number.isSafeInteger(limit) ||
                  limit < 1 ||
                  limit > 100 ||
                  typeof afterId !== 'number' ||
                  !Number.isSafeInteger(afterId) ||
                  afterId < 0
                ) {
                  throw new JudgmentError(
                    'INVALID_INPUT',
                    'turn_inputs requires a valid effect_id, limit and cursor'
                  );
                }
                if (!effects.listTurnInputs) {
                  throw new JudgmentError(
                    'TOOL_ERROR',
                    'Native turn input reader is not configured'
                  );
                }
                const change = effects.listChanges({ id: effectId, limit: 1 })[0];
                if (!change?.runId) {
                  throw new JudgmentError('NOT_FOUND', 'Native turn context is not visible');
                }
                let page: ReturnType<NonNullable<typeof effects.listTurnInputs>>;
                try {
                  page = effects.listTurnInputs(change.runId, context.access.principalId, {
                    afterId,
                    limit,
                  });
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  if (
                    /Model run not found|matching principal-bound|no accepted native turn receipt/.test(
                      message
                    )
                  ) {
                    throw new JudgmentError('NOT_FOUND', 'Native turn context is not visible');
                  }
                  throw error;
                }
                return {
                  success: true,
                  view: 'turn_inputs',
                  effect_id: effectId,
                  run_id: change.runId,
                  relation: 'shared_native_turn_context',
                  direct_cause_event_ids: change.sourceEventIds,
                  run_status: page.runStatus,
                  returned: page.items.length,
                  next_cursor: page.nextCursor,
                  items: page.items,
                };
              }
              if (body.effect_id !== undefined || body.cursor !== undefined) {
                throw new JudgmentError(
                  'INVALID_INPUT',
                  'effect_id and cursor require view=turn_inputs'
                );
              }
              const result = readChanges(effects, input as ChangesReadInput, Date.now());
              if (!result.success) {
                throw new JudgmentError(result.code, result.error);
              }
              return result;
            },
          } satisfies ActionRegistration,
        ]
      : []),
    {
      contract: {
        name: 'operation.get',
        summary:
          'Settle a call whose reply was lost: which command the operationId bound to, under whose authority, and the receipt it committed. An operationId that is absent — or belongs to another principal — answers unavailable, never existence.',
        inputSchema: operationGetSchema,
        examples: [
          {
            title: 'A reply lost after commit',
            input: { operationId: 'op_…' },
          },
        ],
      },
      exec: (input, context) =>
        readOperation(adapter, (input as { operationId: string }).operationId, context.access),
    },
  ];
}
