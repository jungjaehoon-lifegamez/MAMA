import type { Envelope } from './types.js';
import { parseEnvelopeExpiresAt } from './expiry.js';

export class EnvelopeViolation extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly metadata: Record<string, unknown> = {}
  ) {
    super(`[${code}] ${message}`);
    this.name = 'EnvelopeViolation';
  }
}

const SEND_TOOLS_TO_DESTINATION_KIND: Record<string, string> = {
  telegram_send: 'telegram',
  slack_send: 'slack',
  chatwork_send: 'chatwork',
  discord_send: 'discord',
  webchat_send: 'webchat',
};

const WRITE_OR_SEND_TOOLS = new Set<string>([
  'mama_save',
  'mama_update',
  'memory.write',
  'case.create',
  'case.link',
  'case.update_state',
  'entity.write',
  'telegram_send',
  'slack_send',
  'chatwork_send',
  'discord_send',
  'webchat_send',
  'report.publish',
  'report_publish',
  'wiki_publish',
  'human.correction',
]);

export class EnvelopeEnforcer {
  check(envelope: Envelope | null | undefined, toolName: string, args: unknown): void {
    if (!envelope) {
      throw new EnvelopeViolation('No envelope bound to this call', 'no_envelope');
    }

    this.checkExpiry(envelope);
    this.checkDestination(envelope, toolName, args);
    this.checkRawConnectors(envelope, toolName, args);
    this.checkTier(envelope, toolName);
  }

  private checkExpiry(envelope: Envelope): void {
    let expiresAt: number;
    try {
      expiresAt = parseEnvelopeExpiresAt(envelope.expires_at);
    } catch {
      throw new EnvelopeViolation(
        `Envelope ${envelope.instance_id} has invalid expires_at ${envelope.expires_at}`,
        'invalid_expiry'
      );
    }
    if (expiresAt <= Date.now()) {
      throw new EnvelopeViolation(
        `Envelope ${envelope.instance_id} expired at ${envelope.expires_at}`,
        'expired'
      );
    }
  }

  private checkDestination(envelope: Envelope, toolName: string, args: unknown): void {
    const destinationKind = SEND_TOOLS_TO_DESTINATION_KIND[toolName];
    if (!destinationKind) {
      return;
    }

    const destinationId = getStringArg(args, 'chat_id') ?? getStringArg(args, 'channel_id');
    if (!destinationId) {
      throw new EnvelopeViolation(
        `Tool ${toolName} called without destination id`,
        'missing_destination'
      );
    }

    const allowed = envelope.scope.allowed_destinations.some(
      (destination) => destination.kind === destinationKind && destination.id === destinationId
    );
    if (!allowed) {
      throw new EnvelopeViolation(
        `Destination ${destinationKind}:${destinationId} not in envelope.scope.allowed_destinations`,
        'destination_out_of_scope',
        { allowed: envelope.scope.allowed_destinations }
      );
    }
  }

  private checkRawConnectors(envelope: Envelope, toolName: string, args: unknown): void {
    const requestedConnectors = requestedRawConnectorsForTool(toolName, args);
    if (requestedConnectors.length === 0) {
      return;
    }

    const outOfScope = requestedConnectors.filter(
      (connector) => !envelope.scope.raw_connectors.includes(connector)
    );
    if (outOfScope.length > 0) {
      throw new EnvelopeViolation(
        `Raw connectors ${outOfScope.join(',')} not in envelope.scope.raw_connectors`,
        'connector_out_of_scope',
        { allowed: envelope.scope.raw_connectors }
      );
    }
  }

  private checkTier(envelope: Envelope, toolName: string): void {
    if (envelope.tier === 3 && WRITE_OR_SEND_TOOLS.has(toolName)) {
      throw new EnvelopeViolation(
        `Tool ${toolName} not allowed at tier 3 (read-only)`,
        'tier_violation',
        { tier_required: 2, allowed: false }
      );
    }
  }
}

function requestedRawConnectorsForTool(toolName: string, args: unknown): string[] {
  if (toolName === 'kagemusha_messages') {
    const channelId = getStringArg(args, 'channelId');
    if (!channelId) {
      throw new EnvelopeViolation('kagemusha_messages requires channelId', 'missing_raw_target');
    }
    return ['kagemusha'];
  }

  if (!toolName.startsWith('raw.')) {
    return [];
  }

  const connectors = getStringArrayArg(args, 'connectors');
  if (connectors) {
    return connectors;
  }

  const connector = getStringArg(args, 'connector');
  return connector ? [connector] : [];
}

function getStringArg(args: unknown, key: string): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function getStringArrayArg(args: unknown, key: string): string[] | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const value = args[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
