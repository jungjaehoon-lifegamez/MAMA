import type { Envelope, MemoryScope } from './types.js';
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

const MEMORY_READ_TOOLS = new Set<string>(['mama_search', 'mama_recall', 'context_compile']);

export class EnvelopeEnforcer {
  check(envelope: Envelope | null | undefined, toolName: string, args: unknown): void {
    if (!envelope) {
      throw new EnvelopeViolation('No envelope bound to this call', 'no_envelope');
    }

    this.checkExpiry(envelope);
    this.checkDestination(envelope, toolName, args);
    this.checkRawConnectors(envelope, toolName, args);
    this.checkMemoryScopes(envelope, toolName, args);
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

  private checkMemoryScopes(envelope: Envelope, toolName: string, args: unknown): void {
    if (toolName === 'mama_load_checkpoint') {
      throw new EnvelopeViolation(
        'Checkpoint reads are not scoped yet; use scoped search for checkpoint queries.',
        'scoped_checkpoint_unsupported'
      );
    }

    if (!MEMORY_READ_TOOLS.has(toolName)) {
      return;
    }

    const requestedScopes = requestedMemoryScopesForTool(toolName, args);
    if (requestedScopes.length === 0) {
      throw new EnvelopeViolation(
        'Memory read tools must execute with an explicit envelope memory scope',
        'memory_scope_out_of_scope',
        { allowed: envelope.scope.memory_scopes }
      );
    }

    const allowedScopeKeys = new Set(
      envelope.scope.memory_scopes.map((scope) => `${scope.kind}:${scope.id}`)
    );
    const outOfScope = requestedScopes.some(
      (scope) => !allowedScopeKeys.has(`${scope.kind}:${scope.id}`)
    );
    if (outOfScope) {
      throw new EnvelopeViolation(
        'Requested memory scope is outside envelope.scope.memory_scopes',
        'memory_scope_out_of_scope'
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
  if (toolName === 'context_compile') {
    return uniqueStrings([
      ...(getStringArrayArg(args, 'connectors') ?? []),
      ...rawSeedRefConnectors(args),
    ]);
  }

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

function requestedMemoryScopesForTool(toolName: string, args: unknown): MemoryScope[] {
  if (!['mama_search', 'mama_recall', 'context_compile'].includes(toolName)) {
    return [];
  }
  if (!isRecord(args) || args.scopes === undefined) {
    return [];
  }
  if (!Array.isArray(args.scopes)) {
    throw new EnvelopeViolation('Tool scopes must be an array', 'invalid_memory_scope');
  }

  const scopes: MemoryScope[] = [];
  for (const item of args.scopes) {
    if (!isMemoryScope(item)) {
      throw new EnvelopeViolation(
        'Tool scopes must contain memory scope objects',
        'invalid_memory_scope'
      );
    }
    scopes.push({ kind: item.kind, id: item.id });
  }
  return scopes;
}

function rawSeedRefConnectors(args: unknown): string[] {
  if (!isRecord(args) || !Array.isArray(args.seed_refs)) {
    return [];
  }
  const connectors: string[] = [];
  for (const ref of args.seed_refs) {
    if (!isRecord(ref) || ref.kind !== 'raw') {
      continue;
    }
    if (typeof ref.connector === 'string') {
      connectors.push(ref.connector);
    }
  }
  return connectors;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

function isMemoryScope(value: unknown): value is MemoryScope {
  if (!isRecord(value)) {
    return false;
  }
  return (
    ['global', 'user', 'channel', 'project'].includes(String(value.kind)) &&
    typeof value.id === 'string' &&
    value.id.length > 0
  );
}
