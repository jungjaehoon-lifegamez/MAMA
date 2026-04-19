import { canonicalizeJSON, targetRefHash } from '../canonicalize.js';
import type { CaseMembershipSourceType } from './types.js';

export type CaseFieldName =
  | 'case_id'
  | 'canonical_case_id'
  | 'title'
  | 'status'
  | 'status_reason'
  | 'primary_actors'
  | 'blockers'
  | 'confidence'
  | 'last_activity_at';

export interface CaseFieldTargetRef {
  kind: 'case_field';
  field: CaseFieldName;
}

export interface CaseMembershipTargetRef {
  kind: 'membership';
  source_type: CaseMembershipSourceType;
  source_id: string;
}

export interface CaseWikiSectionTargetRef {
  kind: 'wiki_section';
  section_heading: string;
}

export type CaseTargetRef = CaseFieldTargetRef | CaseMembershipTargetRef | CaseWikiSectionTargetRef;

export interface CanonicalTargetRef {
  json: string;
  hash: Buffer;
}

export function buildCaseFieldTargetRef(fieldName: CaseFieldName): CaseFieldTargetRef {
  return { kind: 'case_field', field: fieldName };
}

export function buildMembershipTargetRef(
  sourceType: CaseMembershipSourceType,
  sourceId: string
): CaseMembershipTargetRef {
  return { kind: 'membership', source_type: sourceType, source_id: sourceId };
}

export function buildWikiSectionTargetRef(sectionHeading: string): CaseWikiSectionTargetRef {
  return { kind: 'wiki_section', section_heading: sectionHeading };
}

export function canonicalTargetRef(targetRef: CaseTargetRef): CanonicalTargetRef {
  const json = canonicalizeJSON(targetRef);
  const hash = targetRefHash(json);
  return { json, hash };
}
