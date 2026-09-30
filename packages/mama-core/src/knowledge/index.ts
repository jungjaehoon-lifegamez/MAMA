import {
  appendLink,
  findLink,
  type LinkCommand,
  type LinkReceipt,
  type StoredLink,
} from './links.js';
import type { DatabaseInstance } from '../db-manager.js';
import {
  createJudgmentWriter,
  type JudgmentAccess,
  type JudgmentKnowledgeOptions,
} from './judgments.js';
import { ingestSource } from './source-ingest.js';
import { createWork, readWork, reviseWork, withdrawWork } from './commitments.js';
import { correctIdentity } from './identity.js';
import { queryGraph as queryKnowledgeGraph } from './graph-query.js';
import type {
  CommitmentPage,
  CreateWorkCommand,
  ReviseWorkCommand,
  WithdrawWorkCommand,
  WorkRead,
  WorkWriteResult,
} from './commitments.js';
import type { SourceIngestCommand, SourceIngestReceipt } from './source-ingest.js';
import type {
  IdentityCorrection,
  IdentityCorrectionReceipt,
  JudgmentCommand,
  JudgmentReceipt,
  WorkGraphPage,
  WorkGraphQuery,
} from '../memory/judgment-types.js';

export type { JudgmentAccess } from './judgments.js';
export { judgmentRecordId } from './judgments.js';

export type {
  IdentityCorrection,
  IdentityCorrectionReceipt,
  JudgmentAmendment,
  JudgmentCommand,
  JudgmentEventMeta,
  JudgmentProjections,
  JudgmentReceipt,
  JudgmentRecordFields,
  JsonValue,
  OwnerWorkPatch,
  RecordLink,
  WorkGraphPage,
  WorkGraphQuery,
  WorkReclassifyDisposition,
  WorkReference,
} from '../memory/judgment-types.js';
export { WORK_RECLASSIFY_DISPOSITIONS } from '../memory/judgment-types.js';
export {
  JudgmentError,
  appendJudgment,
  getTwinEdge,
  listTwinEdgesForRefs,
  mapTwinEdgeRow,
} from './judgments.js';
export {
  appendLink,
  findLink,
  linkEdgeId,
  type LinkCommand,
  type LinkReceipt,
  type StoredLink,
} from './links.js';
export {
  assertTwinRefsVisible,
  channelGrantClause,
  isChannelGranted,
  listVisibleTwinEdgesForRefs,
  visibleTwinRefKeys,
  visibleTwinRefKeysRecursive,
  TwinRefNotVisibleError,
} from './access.js';
export type { ChannelGrant, ChannelGrantClause } from './access.js';
export {
  TWIN_EDGE_SOURCES,
  TWIN_EDGE_TYPES,
  TWIN_REF_KINDS,
  type InsertTwinEdgeInput,
  type ListVisibleTwinEdgesOptions,
  type TwinEdgeInsert,
  type TwinEdgeRecord,
  type TwinEdgeSource,
  type TwinEdgeSubjectRef,
  type TwinEdgeType,
  type TwinProjectRef,
  type TwinRef,
  type TwinRefKind,
  type TwinScopeRef,
  type TwinVisibility,
} from './twin-edge-types.js';
export { ingestSource } from './source-ingest.js';
export { correctIdentity, type IdentityDeps } from './identity.js';
// The connector event index and its raw query layer moved to the package that has
// connectors. Three of the four consumers of this core have none.
export {
  observationVersionId,
  appendObservationVersion,
  getObservationVersion,
  searchOwnerObservationVersions,
  readObservationVersion,
  isObservationVersionVisible,
  isObservationVisibilityRowVisible,
  type ObservationBodyLocation,
  type ObservationVersionInput,
  type ObservationVersionRecord,
  type OwnerObservationSearchItem,
  type ObservationBodyReader,
  type ObservationReadResult,
  type ObservationVisibilityAuthority,
  type ObservationVisibilityRow,
} from './observations.js';
export { createWork, readWork, reviseWork, withdrawWork } from './commitments.js';
export {
  parseExactDueAt,
  assertIsoDate,
  assertWorkPatchValues,
  WORK_PATCH_DEADLINE_PATTERN,
  WORK_PATCH_DUE_AT_PATTERN,
  type ParsedExactDueAt,
} from './work-dates.js';
export type {
  CommitmentPage,
  CommitmentChainEntry,
  CommitmentRevision,
  CommitmentView,
  CreateWorkCommand,
  ReviseWorkCommand,
  WithdrawWorkCommand,
  WorkRead,
  WorkWriteResult,
} from './commitments.js';
export { vectorSearch, fts5Search } from './search.js';
export {
  queryDecisionGraph,
  querySemanticEdges,
  getGraphNeighborhood,
  getGraphPaths,
  getGraphTimeline,
  queryGraph,
  AgentGraphValidationError,
  type AgentGraphAdapter,
  type AgentGraphEdgeFilters,
  type AgentGraphResult,
  type AgentGraphCurrentProjection,
  type AgentGraphPath,
  type AgentGraphTimelineEvent,
  type AgentGraphTimelineMemoryEvent,
  type AgentGraphTimelineCaseEvent,
  type AgentGraphTimelineRawEvent,
  type AgentGraphTimelineEdgeEvent,
  type GraphNeighborhoodInput,
  type GraphPathsInput,
  type GraphPathsResult,
  type GraphTimelineInput,
  type GraphTimelineResult,
} from './graph-query.js';
export type { SourceIngestCommand, SourceIngestReceipt } from './source-ingest.js';

export interface KnowledgeOptions extends JudgmentKnowledgeOptions {
  adapter: DatabaseInstance;
}

export interface Knowledge {
  appendJudgment(command: JudgmentCommand, access: JudgmentAccess): Promise<JudgmentReceipt>;
  /** T4 correction — alias, merge, split, ref assignment — under trusted authority. */
  correctIdentity(command: IdentityCorrection, access: JudgmentAccess): IdentityCorrectionReceipt;
  ingestSource(command: SourceIngestCommand, access: JudgmentAccess): Promise<SourceIngestReceipt>;
  /** Commit new owner work; the record and the commitment commit together. */
  createWork(command: CreateWorkCommand, access: JudgmentAccess): Promise<WorkWriteResult>;
  /** Revise owner work at an expected revision. */
  reviseWork(command: ReviseWorkCommand, access: JudgmentAccess): Promise<WorkWriteResult>;
  /** Withdraw owner work without erasing what it held. */
  withdrawWork(command: WithdrawWorkCommand, access: JudgmentAccess): Promise<WorkWriteResult>;
  /** Read owner work back out of the commitment log this instance writes. */
  readWork(query: WorkRead, access: JudgmentAccess): CommitmentPage;
  /**
   * Read the twin-edge graph: overview roots, name-free search seeds, neighbors,
   * paths, timelines, and hydrated details — all under the caller's authority.
   */
  queryGraph(query: WorkGraphQuery, access: JudgmentAccess): WorkGraphPage;
  /**
   * Append one edge between existing records, with its reason; nothing is edited. A link to an
   * edge contradicts it.
   */
  appendLink(command: LinkCommand, access: JudgmentAccess): LinkReceipt;
  /** The link this principal already wrote under a command id, if any. */
  findLink(commandId: string, access: JudgmentAccess): StoredLink | null;
}

export function createKnowledge(options: KnowledgeOptions): Knowledge {
  const writer = createJudgmentWriter(options);
  return {
    appendJudgment: writer.appendJudgment,
    correctIdentity: (command, access) =>
      correctIdentity(command, access, { adapter: options.adapter }),
    ingestSource: (command, access) => ingestSource(command, access, { adapter: options.adapter }),
    createWork: (command, access) => createWork(command, access, options),
    reviseWork: (command, access) => reviseWork(command, access, options),
    withdrawWork: (command, access) => withdrawWork(command, access, options),
    readWork: (query, access) => readWork(options.adapter, query, access),
    queryGraph: (query, access) => queryKnowledgeGraph(options.adapter, query, access),
    appendLink: (command, access) => appendLink(options.adapter, command, access),
    findLink: (commandId, access) => findLink(options.adapter, commandId, access),
  };
}
