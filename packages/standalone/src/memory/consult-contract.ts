import type { MemoryConsultIntent } from '@jungjaehoon/mama-core/memory/types';
import type { MemoryScopeRef } from './scope-context.js';

export interface MemoryConsultRequest {
  intent: MemoryConsultIntent;
  query?: string;
  scopeIds?: MemoryScopeRef[];
}
