import type { DatabaseAdapter } from '../db-manager.js';
import {
  createJudgmentWriter,
  type JudgmentAccess,
  type JudgmentKnowledgeOptions,
} from './judgments.js';
import type { JudgmentCommand, JudgmentReceipt } from '../memory/judgment-types.js';

export type { JudgmentAccess } from './judgments.js';

export type {
  IdentityCorrection,
  IdentityCorrectionReceipt,
  JudgmentCommand,
  JudgmentReceipt,
  JsonValue,
  OwnerWorkPatch,
  RecordLink,
  WorkGraphPage,
  WorkGraphQuery,
  WorkReference,
} from '../memory/judgment-types.js';
export { JudgmentError, appendJudgment } from './judgments.js';

export interface KnowledgeOptions extends JudgmentKnowledgeOptions {
  adapter: DatabaseAdapter;
}

export interface Knowledge {
  appendJudgment(command: JudgmentCommand, access: JudgmentAccess): Promise<JudgmentReceipt>;
}

export function createKnowledge(options: KnowledgeOptions): Knowledge {
  const writer = createJudgmentWriter(options);
  return {
    appendJudgment: writer.appendJudgment,
  };
}
