import { createHash } from 'node:crypto';

export const MEMBER_CANDIDATE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CANDIDATES = 100;

export interface MemberCandidateInput {
  connector: string;
  namespace: string;
  externalId: string;
  displayName?: string;
  firstSeen: number;
  expiresAt: number;
}

export interface MemberCandidate extends MemberCandidateInput {
  candidateId: string;
}

function candidateIdFor(
  input: Pick<MemberCandidateInput, 'connector' | 'namespace' | 'externalId'>
) {
  const identity = JSON.stringify([input.connector, input.namespace, input.externalId]);
  return `member_candidate_${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

function copyCandidate(candidate: MemberCandidate): MemberCandidate {
  return { ...candidate };
}

export class MemberCandidateStore {
  private readonly candidates = new Map<string, MemberCandidate>();

  constructor(private readonly maxCandidates = DEFAULT_MAX_CANDIDATES) {
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) {
      throw new Error('Member candidate capacity must be a positive integer');
    }
  }

  upsert(input: MemberCandidateInput): MemberCandidate {
    if (
      input.connector.length === 0 ||
      input.namespace.length === 0 ||
      input.externalId.length === 0
    ) {
      throw new Error('Member candidate identity fields must be non-empty');
    }
    if (
      !Number.isFinite(input.firstSeen) ||
      !Number.isFinite(input.expiresAt) ||
      input.expiresAt <= input.firstSeen
    ) {
      throw new Error('Member candidate expiry must be later than firstSeen');
    }

    this.prune(input.firstSeen);
    const candidateId = candidateIdFor(input);
    const candidate: MemberCandidate = { candidateId, ...input };

    this.candidates.delete(candidateId);
    while (this.candidates.size >= this.maxCandidates) {
      const oldest = [...this.candidates.values()].sort(
        (left, right) =>
          left.firstSeen - right.firstSeen || left.candidateId.localeCompare(right.candidateId)
      )[0];
      if (!oldest) break;
      this.candidates.delete(oldest.candidateId);
    }
    this.candidates.set(candidateId, candidate);
    return copyCandidate(candidate);
  }

  list(now: number): MemberCandidate[] {
    this.prune(now);
    return [...this.candidates.values()]
      .sort(
        (left, right) =>
          left.firstSeen - right.firstSeen || left.candidateId.localeCompare(right.candidateId)
      )
      .map(copyCandidate);
  }

  get(candidateId: string, now: number): MemberCandidate | undefined {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) return undefined;
    if (candidate.expiresAt <= now) {
      this.candidates.delete(candidateId);
      return undefined;
    }
    return copyCandidate(candidate);
  }

  delete(candidateId: string): boolean {
    return this.candidates.delete(candidateId);
  }

  clear(): void {
    this.candidates.clear();
  }

  private prune(now: number): void {
    for (const [candidateId, candidate] of this.candidates) {
      if (candidate.expiresAt <= now) {
        this.candidates.delete(candidateId);
      }
    }
  }
}

let globalMemberCandidateStore: MemberCandidateStore | null = null;

export function getMemberCandidateStore(): MemberCandidateStore {
  if (!globalMemberCandidateStore) {
    globalMemberCandidateStore = new MemberCandidateStore();
  }
  return globalMemberCandidateStore;
}

export function setMemberCandidateStore(store: MemberCandidateStore): void {
  globalMemberCandidateStore = store;
}
