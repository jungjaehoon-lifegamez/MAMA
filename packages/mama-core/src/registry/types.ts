export const REGISTRY_KINDS = ['item', 'person', 'client'] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export interface RegistryNode {
  id: string;
  kind: RegistryKind;
  name: string;
  parentId: string | null;
  mergedInto: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecordActor {
  personId: string;
  role: string;
}

export interface RecordIdentity {
  itemId: string | null;
}

export interface RegistryScopeRef {
  kind: 'global' | 'user' | 'channel' | 'project';
  id: string;
}
