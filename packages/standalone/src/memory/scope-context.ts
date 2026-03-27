export interface ScopeContextInput {
  source: string;
  channelId?: string;
  userId?: string;
  projectId?: string;
}

export interface MemoryScopeRef {
  kind: 'global' | 'user' | 'channel' | 'project';
  id: string;
}

export function deriveMemoryScopes(input: ScopeContextInput): MemoryScopeRef[] {
  const scopes: MemoryScopeRef[] = [];

  if (input.projectId) {
    scopes.push({ kind: 'project', id: input.projectId });
  }
  if (input.channelId) {
    scopes.push({ kind: 'channel', id: `${input.source}:${input.channelId}` });
  }
  if (input.userId) {
    scopes.push({ kind: 'user', id: input.userId });
  }

  scopes.push({ kind: 'global', id: 'global' });
  return scopes;
}
