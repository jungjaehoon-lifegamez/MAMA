import type { DatabaseAdapter } from '../db-manager.js';
import type { MemoryScopeRef } from '../memory/types.js';

type ObservationVisibilityAdapter = Pick<DatabaseAdapter, 'prepare'>;

export interface ObservationVisibilityAuthority {
  principalId?: string;
  agentId?: string;
  scopes?: readonly MemoryScopeRef[];
  connectors?: readonly string[];
  channels?: Readonly<Record<string, readonly string[]>>;
}

export interface ObservationVisibilityRow {
  source_connector: unknown;
  scope_json: unknown;
}

function parseScopeJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new Error('observation_versions.scope_json must be JSON text');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`observation_versions.scope_json is malformed JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('observation_versions.scope_json must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function matchesScope(scope: Record<string, unknown>, visible: MemoryScopeRef): boolean {
  if (visible.kind === 'project') {
    return (
      scope.projectId === visible.id ||
      (scope.memoryScopeKind === 'project' && scope.memoryScopeId === visible.id)
    );
  }
  if (visible.kind === 'channel') {
    return (
      scope.channel === visible.id ||
      (scope.memoryScopeKind === 'channel' && scope.memoryScopeId === visible.id)
    );
  }
  return scope.memoryScopeKind === visible.kind && scope.memoryScopeId === visible.id;
}

export function isObservationVersionVisible(
  adapter: ObservationVisibilityAdapter,
  observationId: string,
  authority: ObservationVisibilityAuthority
): boolean {
  const row = adapter
    .prepare(
      `SELECT scope_json, source_connector
       FROM observation_versions WHERE observation_id = ?`
    )
    .get(observationId) as ObservationVisibilityRow | undefined;
  if (!row) {
    return false;
  }
  return isObservationVisibilityRowVisible(row, authority);
}

export function isObservationVisibilityRowVisible(
  row: ObservationVisibilityRow,
  authority: ObservationVisibilityAuthority
): boolean {
  const principalId = authority.principalId?.trim();
  const agentId = authority.agentId?.trim();
  if (!principalId || !agentId) {
    return false;
  }
  if (typeof row.source_connector !== 'string' || !row.source_connector.trim()) {
    throw new Error('observation_versions.source_connector must be nonblank text');
  }
  const ownerConnector = /^owner-(?:message|result):(.+)$/.exec(row.source_connector)?.[1];
  const connector = ownerConnector ?? row.source_connector;
  if (!authority.connectors?.includes(connector)) {
    return false;
  }
  const scope = parseScopeJson(row.scope_json);
  if (authority.channels) {
    const visibleChannels = authority.channels[connector];
    const channel = typeof scope.channel === 'string' ? scope.channel : null;
    const normalizedChannel = channel?.startsWith(`${connector}:`)
      ? channel.slice(connector.length + 1)
      : channel;
    if (
      !visibleChannels ||
      channel === null ||
      (!visibleChannels.includes(channel) &&
        (normalizedChannel === null || !visibleChannels.includes(normalizedChannel)))
    ) {
      return false;
    }
  }
  if (ownerConnector !== undefined || scope.visibility === 'owner') {
    if (ownerConnector === undefined || scope.visibility !== 'owner') {
      throw new Error('owner observation connector and scope visibility are inconsistent');
    }
    return scope.principalId === principalId && scope.agentId === agentId;
  }
  if (!authority.scopes || authority.scopes.length === 0) {
    return false;
  }
  return authority.scopes.some((visible) => matchesScope(scope, visible));
}
