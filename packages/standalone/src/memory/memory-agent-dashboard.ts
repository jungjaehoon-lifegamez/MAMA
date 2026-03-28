export interface MemoryAgentRecentExtraction {
  topic: string;
  timestamp: number;
  success: boolean;
  channelKey?: string;
}

export interface MemoryAgentStatsLike {
  turnsObserved: number;
  factsExtracted: number;
  factsSaved: number;
  acksApplied: number;
  acksSkipped: number;
  acksFailed: number;
  lastExtraction: number | null;
  recentExtractions: MemoryAgentRecentExtraction[];
}

export interface MemoryAgentChannelSummary {
  channelKey: string;
  updatedAt: number;
}

interface DashboardChannel {
  channelKey: string;
  source: string;
  channelId: string;
  label: string;
  lastActive: number;
}

function parseChannelKey(channelKey: string): { source: string; channelId: string } {
  const [source, ...rest] = channelKey.split(':');
  return {
    source: source || 'unknown',
    channelId: rest.join(':') || 'unknown',
  };
}

function buildChannelLabel(source: string, channelId: string): string {
  if (source === 'telegram') {
    return `Telegram ${channelId}`;
  }
  if (source === 'discord') {
    return `Discord ${channelId}`;
  }
  if (source === 'slack') {
    return `Slack ${channelId}`;
  }
  return `${source}:${channelId}`;
}

function buildRecentChannels(
  stats: MemoryAgentStatsLike,
  channelSummaries: MemoryAgentChannelSummary[]
): DashboardChannel[] {
  const channels = new Map<string, DashboardChannel>();

  for (const extraction of stats.recentExtractions) {
    if (!extraction.channelKey) {
      continue;
    }
    const { source, channelId } = parseChannelKey(extraction.channelKey);
    const existing = channels.get(extraction.channelKey);
    if (!existing || extraction.timestamp > existing.lastActive) {
      channels.set(extraction.channelKey, {
        channelKey: extraction.channelKey,
        source,
        channelId,
        label: buildChannelLabel(source, channelId),
        lastActive: extraction.timestamp,
      });
    }
  }

  for (const summary of channelSummaries) {
    const existing = channels.get(summary.channelKey);
    if (existing) {
      if (summary.updatedAt > existing.lastActive) {
        existing.lastActive = summary.updatedAt;
        channels.set(summary.channelKey, existing);
      }
      continue;
    }
    const { source, channelId } = parseChannelKey(summary.channelKey);
    channels.set(summary.channelKey, {
      channelKey: summary.channelKey,
      source,
      channelId,
      label: buildChannelLabel(source, channelId),
      lastActive: summary.updatedAt,
    });
  }

  return Array.from(channels.values()).sort((left, right) => right.lastActive - left.lastActive);
}

export function buildMemoryAgentDashboardPayload(params: {
  agentStats: MemoryAgentStatsLike;
  channelSummaries: MemoryAgentChannelSummary[];
  recentDecisions: Array<{
    id: string;
    topic: string;
    decision: string;
    outcome: string | null;
    confidence: number | null;
    created_at: number;
  }>;
  generatedAt?: string;
}): Record<string, unknown> {
  const generatedAt = params.generatedAt || new Date().toISOString();
  const recentChannels = buildRecentChannels(params.agentStats, params.channelSummaries);
  const activeChannel = recentChannels[0] || null;
  const lastExtraction = params.agentStats.lastExtraction;
  const lastExtractionStatus = params.agentStats.recentExtractions[0]?.success
    ? 'Recent save applied'
    : params.agentStats.recentExtractions[0]
      ? 'Recent audit skipped or failed'
      : 'No memory activity yet';

  return {
    generatedAt,
    status: {
      label: activeChannel ? 'Monitoring active' : 'Idle',
      lastExtraction,
      detail: lastExtractionStatus,
    },
    activeChannel,
    recentChannels,
    metrics: {
      turnsObserved: params.agentStats.turnsObserved,
      effectivenessRate:
        params.agentStats.turnsObserved > 0
          ? Math.round((params.agentStats.acksApplied / params.agentStats.turnsObserved) * 100)
          : 0,
      factsExtracted: params.agentStats.factsExtracted,
      factsSaved: params.agentStats.factsSaved,
      acksApplied: params.agentStats.acksApplied,
      acksSkipped: params.agentStats.acksSkipped,
      acksFailed: params.agentStats.acksFailed,
    },
    activity: params.agentStats.recentExtractions.map((item) => ({
      topic: item.topic,
      timestamp: item.timestamp,
      status: item.success ? 'applied' : 'skipped',
      channelKey: item.channelKey || null,
    })),
    summary: {
      updatedAt: activeChannel?.lastActive ?? null,
      markdown: activeChannel
        ? `## Active Channel\n- ${activeChannel.label}\n- Last activity: ${new Date(activeChannel.lastActive).toISOString()}\n- Recent audit status: ${lastExtractionStatus}`
        : '## No Active Channel\n- Memory agent has not observed any recent channel activity yet.',
      isEmpty: !activeChannel,
    },
    recentDecisions: params.recentDecisions,
  };
}
