import type { DatabaseAdapter } from '../db-manager.js';
import {
  createJudgmentWriter,
  type JudgmentAccess,
  type JudgmentKnowledgeOptions,
} from './judgments.js';
import { ingestSource } from './source-ingest.js';
import type { SourceIngestCommand, SourceIngestReceipt } from './source-ingest.js';
import type { JudgmentCommand, JudgmentReceipt } from '../memory/judgment-types.js';

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
  WorkReference,
} from '../memory/judgment-types.js';
export { JudgmentError, appendJudgment } from './judgments.js';
export { ingestSource } from './source-ingest.js';
export type { SourceIngestCommand, SourceIngestReceipt } from './source-ingest.js';
export {
  upsertDecisionEdge,
  proposeDecisionEdge,
  approveDecisionEdge,
  rejectDecisionEdge,
  deprecateAutoDecisionEdges,
  deleteDecisionEdgesWithAudit,
  type DecisionEdgeKey,
  type DecisionEdgeRow,
  type DecisionEdgeDeleteFailure,
} from './decision-edges.js';

export interface KnowledgeOptions extends JudgmentKnowledgeOptions {
  adapter: DatabaseAdapter;
}

export interface Knowledge {
  appendJudgment(command: JudgmentCommand, access: JudgmentAccess): Promise<JudgmentReceipt>;
  ingestSource(command: SourceIngestCommand, access: JudgmentAccess): Promise<SourceIngestReceipt>;
}

export function createKnowledge(options: KnowledgeOptions): Knowledge {
  const writer = createJudgmentWriter(options);
  return {
    appendJudgment: writer.appendJudgment,
    ingestSource: (command, access) => ingestSource(command, access, { adapter: options.adapter }),
  };
}
