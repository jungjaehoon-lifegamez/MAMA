import type { MamaApiClient, MemoryAgentBootstrap } from '../gateways/context-injector.js';
import type { MemoryScopeRef } from './scope-context.js';

interface BuildStandaloneMemoryBootstrapParams {
  mamaApi: Pick<MamaApiClient, 'buildMemoryBootstrap' | 'recallMemory'>;
  scopes: MemoryScopeRef[];
  currentGoal?: string;
  mainAgentState?: MemoryAgentBootstrap['main_agent_state'];
}

export async function buildStandaloneMemoryBootstrap(
  params: BuildStandaloneMemoryBootstrapParams
): Promise<MemoryAgentBootstrap> {
  if (params.mamaApi.buildMemoryBootstrap) {
    return params.mamaApi.buildMemoryBootstrap({
      scopes: params.scopes,
      currentGoal: params.currentGoal,
      mainAgentState: params.mainAgentState,
    });
  }

  const recall = params.mamaApi.recallMemory
    ? await params.mamaApi.recallMemory('', {
        scopes: params.scopes,
        includeProfile: true,
      })
    : undefined;

  return {
    current_goal: params.currentGoal,
    scope_context: params.scopes,
    truth_snapshot:
      recall?.memories.map((memory) => ({
        id: memory.id,
        topic: memory.topic,
        summary: memory.summary,
        trust_score: 0.5,
      })) ?? [],
    open_audit_findings: [],
    recent_memory_events: [],
    profile_snapshot: recall?.profile
      ? {
          static: recall.profile.static.map((entry, index) => ({
            id: `static_${index}`,
            summary: entry.summary,
          })),
          dynamic: recall.profile.dynamic.map((entry, index) => ({
            id: `dynamic_${index}`,
            summary: entry.summary,
          })),
        }
      : undefined,
    main_agent_state: params.mainAgentState,
  };
}

export function formatMemoryBootstrap(packet: MemoryAgentBootstrap): string {
  const lines = ['[Memory Bootstrap]'];

  if (packet.current_goal) {
    lines.push(`Current goal: ${packet.current_goal}`);
  }

  if (packet.scope_context.length > 0) {
    lines.push(
      `Scopes: ${packet.scope_context.map((scope) => `${scope.kind}:${scope.id}`).join(', ')}`
    );
  }

  if (packet.truth_snapshot.length > 0) {
    lines.push('Truth snapshot:');
    for (const row of packet.truth_snapshot.slice(0, 5)) {
      lines.push(`- ${row.topic}: ${row.summary}`);
    }
  }

  if (packet.open_audit_findings.length > 0) {
    lines.push('Open findings:');
    for (const finding of packet.open_audit_findings.slice(0, 5)) {
      lines.push(`- [${finding.severity}] ${finding.summary}`);
    }
  }

  lines.push('[/Memory Bootstrap]');
  return lines.join('\n');
}
