export type SaveCandidateKind =
  | 'decision'
  | 'preference'
  | 'fact'
  | 'constraint'
  | 'lesson'
  | 'profile_update'
  | 'change';

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
}
