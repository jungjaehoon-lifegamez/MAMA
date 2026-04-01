export type SaveCandidateKind =
  | 'decision'
  | 'preference'
  | 'fact'
  | 'constraint'
  | 'lesson'
  | 'profile_update'
  | 'change';

export type FactModality = 'completed' | 'plan' | 'past_habit' | 'state' | 'preference';

export interface SaveCandidate {
  id: string;
  kind: SaveCandidateKind;
  confidence: number;
  topicHint?: string;
  summary: string;
  evidence: string[];
  channelKey: string;
  source: string;
  channelId: string;
  userId?: string;
  projectId?: string;
  createdAt: number;
  modality?: FactModality;
  entities?: string[];
}
