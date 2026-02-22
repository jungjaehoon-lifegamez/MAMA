/**
 * Shared MAMA tool handlers (save, search, update, loadCheckpoint)
 *
 * Extracted to eliminate duplication between MCPExecutor and GatewayToolExecutor.
 */

import type {
  SaveInput,
  SaveDecisionInput,
  SaveCheckpointInput,
  SearchInput,
  UpdateInput,
  LoadCheckpointInput,
  SaveResult,
  SearchResult,
  SearchResultItem,
  UpdateResult,
  LoadCheckpointResult,
  MAMAApiInterface,
} from './types.js';

export async function handleSave(
  api: MAMAApiInterface,
  input: SaveInput,
  getRecentConversation?: () => unknown[]
): Promise<SaveResult> {
  if (input.type === 'decision') {
    const d = input as SaveDecisionInput;
    if (!d.topic || !d.decision || !d.reasoning) {
      return { success: false, message: 'Decision requires: topic, decision, reasoning' };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await api.save({
      topic: d.topic,
      decision: d.decision,
      reasoning: d.reasoning,
      confidence: d.confidence ?? 0.5,
      type: 'user_decision',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  if (input.type === 'checkpoint') {
    const c = input as SaveCheckpointInput;
    if (!c.summary) {
      return { success: false, message: 'Checkpoint requires: summary' };
    }
    const recentConversation = getRecentConversation?.() || [];
    const cpResult = await api.saveCheckpoint(
      c.summary,
      c.open_files ?? [],
      c.next_steps ?? '',
      ...(recentConversation.length > 0 ? [recentConversation] : [])
    );
    if (typeof cpResult !== 'object' || cpResult === null || !('success' in cpResult)) {
      return { success: true, id: String(cpResult), message: 'Checkpoint saved' };
    }
    return cpResult;
  }

  return {
    success: false,
    message: `Invalid save type: ${(input as { type?: string }).type}. Must be 'decision' or 'checkpoint'`,
  };
}

export async function handleSearch(
  api: MAMAApiInterface,
  input: SearchInput
): Promise<SearchResult> {
  const { query, type, limit = 10 } = input;

  if (type === 'checkpoint') {
    const checkpoint = await api.loadCheckpoint();
    if (checkpoint && typeof checkpoint === 'object' && 'summary' in checkpoint) {
      const cp = checkpoint as {
        id?: number;
        summary?: string;
        timestamp?: number;
        next_steps?: string;
        open_files?: string[];
      };
      const item: SearchResultItem = {
        id: `checkpoint_${cp.id ?? 'latest'}`,
        summary: cp.summary,
        created_at: cp.timestamp ? new Date(cp.timestamp).toISOString() : new Date().toISOString(),
        type: 'checkpoint',
      };
      return { success: true, results: [item], count: 1 };
    }
    return { success: true, results: [], count: 0 };
  }

  if (!query) {
    const decisions = await api.listDecisions({ limit });
    let results = (Array.isArray(decisions) ? decisions : []) as SearchResultItem[];

    if (type && type !== 'all') {
      results = results.filter((item) => {
        const id = item.id ?? '';
        if (type === 'decision') return id.startsWith('decision_');
        if (type === 'checkpoint') return id.startsWith('checkpoint_');
        return true;
      });
    }

    return { success: true, results, count: results.length };
  }

  const result = await api.suggest(query, { limit });
  let filteredResults = result.results ?? [];

  if (type && type !== 'all') {
    filteredResults = filteredResults.filter((item: { id?: string }) => {
      const id = item.id ?? '';
      if (type === 'decision') return id.startsWith('decision_');
      if (type === 'checkpoint') return id.startsWith('checkpoint_');
      return true;
    });
  }

  return { success: true, results: filteredResults, count: filteredResults.length };
}

export async function handleUpdate(
  api: MAMAApiInterface,
  input: UpdateInput
): Promise<UpdateResult> {
  const { id, outcome, reason } = input;

  if (!id) return { success: false, message: 'Update requires: id' };
  if (!outcome) return { success: false, message: 'Update requires: outcome' };

  const normalizedOutcome = outcome.toUpperCase();
  if (!['SUCCESS', 'FAILED', 'PARTIAL'].includes(normalizedOutcome)) {
    return {
      success: false,
      message: `Invalid outcome: ${outcome}. Must be one of: success, failed, partial`,
    };
  }

  const updateResult = await api.updateOutcome(id, {
    outcome: normalizedOutcome,
    failure_reason: reason,
  });
  if (!updateResult || typeof updateResult !== 'object' || !('success' in updateResult)) {
    return { success: true, message: `Outcome updated to ${normalizedOutcome}` };
  }
  return updateResult;
}

export async function handleLoadCheckpoint(
  api: MAMAApiInterface,
  _input: LoadCheckpointInput,
  onRestore?: (recentConversation: unknown[]) => void
): Promise<LoadCheckpointResult> {
  const checkpoint = await api.loadCheckpoint();
  if (!checkpoint) {
    return { success: false, message: 'No checkpoint found' };
  }

  // Restore conversation if callback provided
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp = checkpoint as any;
  if (cp.recentConversation && onRestore) {
    onRestore(cp.recentConversation);
  }

  // Ensure success field is present (HostBridge checks result.success)
  const record = checkpoint as unknown as Record<string, unknown>;
  if (!('success' in record)) {
    record.success = true;
  }
  return record as unknown as LoadCheckpointResult;
}
