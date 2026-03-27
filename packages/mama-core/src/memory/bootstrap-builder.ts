import { listRecentMemoryEvents } from './event-store.js';
import { listOpenAuditFindings } from './finding-store.js';
import { classifyProfileEntries } from './profile-builder.js';
import { queryRelevantTruth } from './truth-store.js';
import { getChannelSummary } from './channel-summary-store.js';
import type { MemoryAgentBootstrap, MemoryScopeRef } from './types.js';

interface BuildMemoryAgentBootstrapParams {
  scopes: MemoryScopeRef[];
  channelKey?: string;
  currentGoal?: string;
  mainAgentState?: MemoryAgentBootstrap['main_agent_state'];
}

export async function buildMemoryAgentBootstrap(
  params: BuildMemoryAgentBootstrapParams
): Promise<MemoryAgentBootstrap> {
  const [truthRows, findings, recentEvents, channelSummary] = await Promise.all([
    queryRelevantTruth({
      query: '',
      scopes: params.scopes,
      includeHistory: true,
    }),
    listOpenAuditFindings(),
    listRecentMemoryEvents(10),
    params.channelKey ? getChannelSummary(params.channelKey) : Promise.resolve(null),
  ]);

  const scopedTruth = truthRows.filter((row) =>
    row.scope_refs.some((scopeRef) =>
      params.scopes.some((scope) => scope.kind === scopeRef.kind && scope.id === scopeRef.id)
    )
  );

  const profile = classifyProfileEntries(
    scopedTruth.map((row) => ({
      id: row.memory_id,
      topic: row.topic,
      kind: 'decision',
      summary: row.effective_summary,
      details: row.effective_details,
      confidence: row.trust_score,
      status: row.truth_status === 'quarantined' ? 'stale' : row.truth_status,
      scopes: row.scope_refs,
      source: {
        package: 'mama-core',
        source_type: 'truth_projection',
      },
      created_at: 0,
      updated_at: 0,
    }))
  );

  return {
    current_goal: params.currentGoal,
    scope_context: params.scopes,
    channel_summary_markdown: channelSummary?.summary_markdown,
    truth_snapshot: scopedTruth.map((row) => ({
      id: row.memory_id,
      topic: row.topic,
      summary: row.effective_summary,
      trust_score: row.trust_score,
    })),
    open_audit_findings: findings.map((finding) => ({
      id: finding.finding_id,
      kind: finding.kind,
      severity: finding.severity,
      summary: finding.summary,
    })),
    recent_memory_events: recentEvents.map((event) => ({
      id: event.event_id,
      type: event.event_type,
      topic: event.topic,
      created_at: event.created_at,
    })),
    profile_snapshot: {
      static: profile.static.map((entry) => ({ id: entry.id, summary: entry.summary })),
      dynamic: profile.dynamic.map((entry) => ({ id: entry.id, summary: entry.summary })),
    },
    main_agent_state: params.mainAgentState,
  };
}
