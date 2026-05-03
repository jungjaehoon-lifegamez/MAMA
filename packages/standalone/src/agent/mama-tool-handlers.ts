/**
 * Shared MAMA tool handlers (save, search, update, loadCheckpoint)
 *
 * Extracted to eliminate duplication between MCPExecutor and GatewayToolExecutor.
 */

import type {
  SaveInput,
  SaveDecisionInput,
  SaveDecisionPayload,
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
  TrustedMemoryWriteOptions,
} from './types.js';

function isSearchResultItem(value: unknown): value is SearchResultItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

export async function handleSave(
  api: MAMAApiInterface,
  input: SaveInput,
  getRecentConversation?: () => unknown[],
  options?: TrustedMemoryWriteOptions
): Promise<SaveResult> {
  if (input.type === 'decision') {
    const d = input as SaveDecisionInput;
    if (!d.topic || !d.decision || !d.reasoning) {
      return { success: false, message: 'Decision requires: topic, decision, reasoning' };
    }
    if (isOperationalRunSummaryDecision(d)) {
      return {
        success: true,
        skipped: true,
        code: 'operational_memory_skipped',
        message:
          'Operational audit, dashboard, and wiki run summaries are kept in agent activity/notices, not saved as long-term decisions.',
      };
    }
    const payload: SaveDecisionPayload = {
      topic: d.topic,
      decision: d.decision,
      reasoning: d.reasoning,
      confidence: d.confidence ?? 0.5,
      is_static: d.is_static,
      type: 'user_decision',
      scopes: d.scopes,
      ...(d.event_date && { event_date: d.event_date }),
    };
    if (options) {
      if (!api.saveWithTrustedProvenance) {
        if (!options.provenance.context_packet_id) {
          return await api.save(payload);
        }
        return {
          success: false,
          message: 'Trusted provenance save is unavailable.',
        };
      }
      return await api.saveWithTrustedProvenance(payload, options);
    }
    return await api.save(payload);
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

function normalizeOperationalText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function isOperationalRunSummaryDecision(input: SaveDecisionInput): boolean {
  const topic = normalizeOperationalText(input.topic);
  const decision = normalizeOperationalText(input.decision);
  const reasoning = normalizeOperationalText(input.reasoning);
  const hasOperationalAutosaveMarker =
    reasoning.includes('auto-saved-by-dashboard-agent-after-report-publish') ||
    reasoning.includes('auto-saved-by-wiki-agent-after-wiki-publish');

  const operationalTopic =
    /^dashboard-briefing(?:-|$|\d)/.test(topic) ||
    /^wiki-compilation(?:-|$|\d)/.test(topic) ||
    /^system-audit(?:-|$|\d)/.test(topic) ||
    /^audit-summary(?:-|$|\d)/.test(topic) ||
    /^test-audit(?:-|$|\d)/.test(topic);

  if (operationalTopic) {
    return true;
  }

  return (
    decision.startsWith('dashboard-briefing-(') ||
    decision.startsWith('wiki-compilation-(') ||
    decision.startsWith('system-audit-') ||
    ((decision.startsWith('audit-complete') || decision.startsWith('audit-completed')) &&
      hasOperationalAutosaveMarker) ||
    hasOperationalAutosaveMarker
  );
}

export async function handleSearch(
  api: MAMAApiInterface,
  input: SearchInput
): Promise<SearchResult> {
  const {
    query,
    type,
    limit = 10,
    scopes,
    threshold,
    strict,
    strictness,
    disableRecency,
    includeRelated,
    topicPrefix,
    minLexicalSupport,
    diagnostics,
  } = input;

  if (type === 'checkpoint') {
    if (Array.isArray(scopes) && scopes.length > 0) {
      return {
        success: false,
        results: [],
        count: 0,
        error: 'Scoped checkpoint search is not supported until checkpoints have scoped reads.',
        code: 'scoped_checkpoint_unsupported',
      };
    }

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

  const hasScopes = Array.isArray(scopes) && scopes.length > 0;

  if (!query) {
    const decisions = await api.listDecisions({ limit, ...(hasScopes ? { scopes } : {}) });
    const raw = Array.isArray(decisions) ? decisions : [];
    let results = raw.filter(isSearchResultItem);

    if (type === 'decision') {
      results = results.filter((item) => item.id.startsWith('decision_'));
    }

    return { success: true, results, count: results.length };
  }

  const result = await api.suggest(query, {
    limit,
    ...(hasScopes ? { scopes } : {}),
    ...(threshold !== undefined && { threshold }),
    ...(strict !== undefined && { strict }),
    ...(strictness !== undefined && { strictness }),
    ...(disableRecency !== undefined && { disableRecency }),
    ...(includeRelated !== undefined && { includeRelated }),
    ...(topicPrefix !== undefined && { topicPrefix }),
    ...(minLexicalSupport !== undefined && { minLexicalSupport }),
    ...(diagnostics !== undefined && { diagnostics }),
  });
  if (!result || typeof result !== 'object') {
    // suggest() returned no result for the supplied query. Do NOT fall back to
    // listDecisions(): that drops the query entirely and returns unrelated
    // records while still reporting success: true, which would undermine the
    // strict-search guarantees the rest of this path provides.
    return {
      success: false,
      results: [],
      count: 0,
      code: 'suggest_returned_null',
      error: 'Search failed: suggest() returned no result for query',
    };
  }
  if (result.success === false) {
    return {
      success: false,
      results: [],
      count: result.count ?? 0,
      error: result.error ?? 'Search failed: suggest() reported failure',
      ...(result.code !== undefined ? { code: result.code } : {}),
      ...(result.diagnostics !== undefined ? { diagnostics: result.diagnostics } : {}),
      ...(result.meta !== undefined ? { meta: result.meta } : {}),
    };
  }
  let filteredResults: SearchResultItem[] = (result.results ?? []).filter(isSearchResultItem);

  // type === 'checkpoint' already handled above with early return
  if (type === 'decision') {
    filteredResults = filteredResults.filter((item) => item.id.startsWith('decision_'));
  }

  return {
    success: true,
    results: filteredResults,
    count: filteredResults.length,
    ...(result.diagnostics !== undefined ? { diagnostics: result.diagnostics } : {}),
    ...(result.meta !== undefined ? { meta: result.meta } : {}),
  };
}

export async function handleUpdate(
  api: MAMAApiInterface,
  input: UpdateInput
): Promise<UpdateResult> {
  const { id, outcome, reason } = input;

  if (!id) {
    return { success: false, message: 'Update requires: id' };
  }
  if (!outcome) {
    return { success: false, message: 'Update requires: outcome' };
  }

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
  const cpRecord = checkpoint as unknown as Record<string, unknown>;
  if (onRestore && 'recentConversation' in cpRecord && Array.isArray(cpRecord.recentConversation)) {
    onRestore(cpRecord.recentConversation);
  }

  // Ensure success field is present (HostBridge checks result.success)
  // Shallow copy to avoid mutating the original checkpoint object
  const record = { ...(checkpoint as unknown as Record<string, unknown>) };
  if (!('success' in record)) {
    record.success = true;
  }
  return record as unknown as LoadCheckpointResult;
}
