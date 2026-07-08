/**
 * Generic agent-evolved trigger types (PUBLIC-SAFE).
 *
 * Genericized from Kagemusha's `SituationSignal` / `AgentContract`
 * (~/project/mama-suite/apps/kagemusha/src/agent/contracts/contract-types.ts:15-75),
 * with the personal literals removed (`projectId: 'kagemusha'`, `detector: 'kagemusha-static-v1'`).
 *
 * HARD RULE (G3 anti-refreeze): `kind` and `procedure[].action` are OPEN `string`s, never a
 * fixed enum. The agent authors them (trigger-author.ts). Narrowing them back to a catalog
 * (e.g. Kagemusha's 4 `hasExecutableProfile` kinds) silently re-freezes agent authoring.
 */

/** Ports Kagemusha `SourceRef` (contract-types.ts:9) - generic connector. */
export interface TriggerSourceRef {
  sourceConnector: string;
  sourceId: string;
}

/**
 * A fired trigger's signal. Genericized `SituationSignal` (contract-types.ts:15-27).
 * Drives recall (`memoryQuery`) + evidence gathering, then routes to the agent.
 */
export interface TriggerSignal {
  kind: string;
  memoryQuery: string;
  requiredEvidence: string[];
  confidence: number;
  detector: string;
  channelId: string;
  occurredAt: number;
  reason: string;
  text: string;
  sourceRefs: TriggerSourceRef[];
}

/** The agent-authored match condition (replaces hardcoded regex markers, G1). */
export interface TriggerMatch {
  keywords: string[];
  keywordMode: 'any' | 'every';
  scopeChannelIds?: string[];
  minConfidence: number;
}

/** One step of an agent-authored procedure. `action` is an OPEN string (G3). */
export interface TriggerProcedureStep {
  action: string;
  description: string;
}

export interface TriggerProvenance {
  createdFrom: string;
  note: string;
}

/** Outcome tallies - the G2 evolution feed (Task 4 reads these). */
export interface TriggerStats {
  fired: number;
  succeeded: number;
  failed: number;
}

export type TriggerStatus = 'active' | 'disabled' | 'superseded';

/**
 * A persisted trigger the agent authored/owns. No `approvedBy`/`approvedAt` field exists -
 * triggers self-activate (G4 unfrozen); there is structurally no human-approval gate.
 */
export interface TriggerRecord {
  id: string;
  kind: string;
  memoryQuery: string;
  match: TriggerMatch;
  procedure: TriggerProcedureStep[];
  requiredEvidence: string[];
  status: TriggerStatus;
  authoredBy: 'agent' | 'seed';
  createdAt: number;
  updatedAt: number;
  provenance: TriggerProvenance;
  stats: TriggerStats;
}

/** Input to author a trigger. Server manages status/timestamps/stats. */
export type CreateTriggerInput = Omit<TriggerRecord, 'status' | 'createdAt' | 'updatedAt' | 'stats'>;
