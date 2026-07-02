import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import {
  buildConnectorEventIngressPreview,
  type ConnectorEventIngressPreviewInput,
  type ConnectorEventIngressScope,
} from './connector-event-ingress.js';
import { requiredString } from './validation.js';

export type ConnectorIngressMigrationDryRunStatus = 'idle' | 'ready';

export interface ConnectorIngressMigrationDryRunCandidate {
  seq: number;
  eventIndexId: string;
  sourceRef: SourceRef;
  readiness: 'requires_decision';
}

export interface ConnectorIngressMigrationDryRun {
  mode: 'dry_run';
  status: ConnectorIngressMigrationDryRunStatus;
  cursorName: string;
  connector: string;
  channel: string;
  advancedThroughSeq: number;
  candidateCount: number;
  highestCandidateSeq: number | null;
  requiresOperatorDecision: boolean;
  durableWrites: {
    commits: 0;
    cursors: 0;
    noUpdates: 0;
  };
  candidates: ConnectorIngressMigrationDryRunCandidate[];
}

export type ConnectorIngressMigrationDryRunProvider = (
  input: ConnectorEventIngressScope & { limit?: number }
) => ConnectorIngressMigrationDryRun;

export function buildConnectorIngressMigrationDryRun(
  input: ConnectorEventIngressPreviewInput
): ConnectorIngressMigrationDryRun {
  const preview = buildConnectorEventIngressPreview(input);
  const candidates = preview.events.map((event): ConnectorIngressMigrationDryRunCandidate => {
    return {
      seq: event.seq,
      eventIndexId: event.eventIndexId,
      sourceRef: event.sourceRef,
      readiness: 'requires_decision',
    };
  });
  const candidateCount = candidates.length;

  return {
    mode: 'dry_run',
    status: candidateCount > 0 ? 'ready' : 'idle',
    cursorName: preview.cursorName,
    connector: preview.connector,
    channel: preview.channel,
    advancedThroughSeq: preview.advancedThroughSeq,
    candidateCount,
    highestCandidateSeq: candidateCount > 0 ? candidates[candidateCount - 1].seq : null,
    requiresOperatorDecision: candidateCount > 0,
    durableWrites: {
      commits: 0,
      cursors: 0,
      noUpdates: 0,
    },
    candidates,
  };
}

export function createConnectorIngressMigrationDryRunProvider(
  options: ConnectorEventIngressPreviewInput
): ConnectorIngressMigrationDryRunProvider {
  const connector = requiredString(options.connector, 'connector');
  const channel = requiredString(options.channel, 'channel');
  return (input) => {
    const requestedConnector = requiredString(input.connector, 'connector');
    const requestedChannel = requiredString(input.channel, 'channel');
    if (requestedConnector !== connector || requestedChannel !== channel) {
      throw new Error(
        `Connector ingress migration dry-run is locked to the configured connector/channel: ${connector}/${channel}`
      );
    }
    return buildConnectorIngressMigrationDryRun({
      rawAdapter: options.rawAdapter,
      operatorDb: options.operatorDb,
      connector,
      channel,
      limit: input.limit,
    });
  };
}
