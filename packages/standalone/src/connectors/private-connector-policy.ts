import { createHash } from 'node:crypto';

import type { GatewayToolExecutionContext, GatewayToolName } from '../agent/types.js';
import type { RoleConfig } from '../cli/config/types.js';

import type { ConnectorConfigLoadResult } from './config-loader.js';
import { AVAILABLE_CONNECTORS, PRIVATE_CONNECTORS } from './index.js';

export type ConnectorCapabilitySurface =
  | 'owner_console'
  | 'os_agent'
  | 'legacy-unbound'
  | 'multi-agent-generic'
  | 'workorder-board'
  | 'workorder-memory-curation'
  | 'workorder-temporal'
  | 'operator-report';

export interface PrivateConnectorToolDefinition {
  readonly name: GatewayToolName;
  readonly description: string;
  readonly category: 'business_data';
  readonly params?: string;
}

export interface PrivateConnectorPolicy {
  readonly fingerprint: string;
  readonly configuredPrivateConnectors: readonly string[];
  readonly enabledPrivateConnectors: readonly string[];
  isConfigured(name: string): boolean;
  isEnabled(name: string): boolean;
  toolsFor(surface: ConnectorCapabilitySurface): readonly string[];
  toolDefinitionsFor(
    surface: ConnectorCapabilitySurface
  ): readonly PrivateConnectorToolDefinition[];
  projectRole(surface: ConnectorCapabilitySurface, role: RoleConfig): RoleConfig;
  promptOverlayFor(surface: ConnectorCapabilitySurface): string;
}

export interface ProjectedToolPolicy {
  readonly allowedTools: readonly string[];
  readonly blockedTools: readonly string[];
}

const ELIGIBLE_SURFACES = new Set<ConnectorCapabilitySurface>([
  'owner_console',
  'workorder-board',
  'workorder-memory-curation',
  'workorder-temporal',
  'operator-report',
]);

export const PRIVATE_CONNECTOR_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'kagemusha_overview' as const,
    description: 'Get overview: room/task/message counts across all channels',
    category: 'business_data' as const,
    params: '(none)',
  }),
  Object.freeze({
    name: 'kagemusha_entities' as const,
    description: 'List people and project channels with activity stats',
    category: 'business_data' as const,
    params: 'channel?, activeOnly?, limit?',
  }),
  Object.freeze({
    name: 'kagemusha_tasks' as const,
    description:
      'Query tasks by room, status, priority, or text search. READ-ONLY project-task truth. Status vocabulary: pending|in_progress|review|done|completed|cancelled|dismissed|active (no "blocked" - an empty result for an unknown status is a vocabulary miss, not missing work).',
    category: 'business_data' as const,
    params: 'sourceRoom?, status?, priority?, search?, limit?',
  }),
  Object.freeze({
    name: 'kagemusha_messages' as const,
    description: 'Read raw messages from a specific channel (follow entities -> tasks -> messages)',
    category: 'business_data' as const,
    params: 'channelId (required), since?, limit?, search?',
  }),
] satisfies readonly PrivateConnectorToolDefinition[]);

const PRIVATE_TOOL_NAMES = Object.freeze(
  PRIVATE_CONNECTOR_TOOL_DEFINITIONS.map((definition) => definition.name)
);

export const PRIVATE_CONNECTOR_PROMPT_OVERLAY = [
  '## Private business data',
  '',
  "Use Kagemusha read tools only when they are present in this run's catalog. Explore progressively: overview, then entities or tasks, then messages for a specific channel.",
].join('\n');

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function privateNamesFrom(result: ConnectorConfigLoadResult): readonly string[] {
  if (!result.ok) {
    return Object.freeze([]);
  }

  return uniqueStrings(PRIVATE_CONNECTORS.filter((name) => Object.hasOwn(result.config, name)));
}

function enabledPrivateNamesFrom(result: ConnectorConfigLoadResult): readonly string[] {
  if (!result.ok) {
    return Object.freeze([]);
  }

  const enabledNames = new Set(result.enabledNames);
  return uniqueStrings(
    PRIVATE_CONNECTORS.filter(
      (name) => enabledNames.has(name) && result.config[name]?.enabled === true
    )
  );
}

function isEligibleSurface(surface: ConnectorCapabilitySurface): boolean {
  return ELIGIBLE_SURFACES.has(surface);
}

function privateToolsFor(
  surface: ConnectorCapabilitySurface,
  enabledPrivateConnectors: readonly string[]
): readonly string[] {
  if (!isEligibleSurface(surface) || enabledPrivateConnectors.length === 0) {
    return Object.freeze([]);
  }
  return PRIVATE_TOOL_NAMES;
}

function definitionsFor(
  surface: ConnectorCapabilitySurface,
  enabledPrivateConnectors: readonly string[]
): readonly PrivateConnectorToolDefinition[] {
  if (!isEligibleSurface(surface) || enabledPrivateConnectors.length === 0) {
    return Object.freeze([]);
  }
  return PRIVATE_CONNECTOR_TOOL_DEFINITIONS;
}

function overlayFor(
  surface: ConnectorCapabilitySurface,
  enabledPrivateConnectors: readonly string[]
): string {
  return isEligibleSurface(surface) && enabledPrivateConnectors.length > 0
    ? PRIVATE_CONNECTOR_PROMPT_OVERLAY
    : '';
}

function fingerprintFor(
  configuredPrivateConnectors: readonly string[],
  enabledPrivateConnectors: readonly string[]
): string {
  const surfaceBundles = Object.fromEntries(
    (
      [
        'owner_console',
        'os_agent',
        'legacy-unbound',
        'multi-agent-generic',
        'workorder-board',
        'workorder-memory-curation',
        'workorder-temporal',
        'operator-report',
      ] as const
    ).map((surface) => [surface, privateToolsFor(surface, enabledPrivateConnectors)])
  );
  const canonicalJson = JSON.stringify({
    configuredPrivateConnectors,
    enabledPrivateConnectors,
    surfaceBundles,
  });
  return createHash('sha256').update(canonicalJson).digest('hex');
}

function appendUnique(values: readonly string[], additions: readonly string[]): readonly string[] {
  return uniqueStrings([...values, ...additions]);
}

export function projectPrivateToolPolicy(
  surface: ConnectorCapabilitySurface,
  role: Pick<RoleConfig, 'allowedTools' | 'blockedTools'>,
  policy: PrivateConnectorPolicy
): ProjectedToolPolicy {
  const allowedTools = [...role.allowedTools];
  const blockedTools = [...(role.blockedTools ?? [])];

  if (isEligibleSurface(surface) && policy.enabledPrivateConnectors.length > 0) {
    return {
      allowedTools: appendUnique(allowedTools, policy.toolsFor(surface)),
      blockedTools: uniqueStrings(blockedTools),
    };
  }

  return {
    allowedTools: uniqueStrings(allowedTools),
    blockedTools: appendUnique(blockedTools, PRIVATE_TOOL_NAMES),
  };
}

export function resolvePrivateConnectorPolicy(
  result: ConnectorConfigLoadResult
): PrivateConnectorPolicy {
  const configuredPrivateConnectors = privateNamesFrom(result);
  const enabledPrivateConnectors = enabledPrivateNamesFrom(result);
  const fingerprint = fingerprintFor(configuredPrivateConnectors, enabledPrivateConnectors);

  return Object.freeze({
    fingerprint,
    configuredPrivateConnectors,
    enabledPrivateConnectors,
    isConfigured(name: string): boolean {
      return configuredPrivateConnectors.includes(name);
    },
    isEnabled(name: string): boolean {
      return enabledPrivateConnectors.includes(name);
    },
    toolsFor(surface: ConnectorCapabilitySurface): readonly string[] {
      return privateToolsFor(surface, enabledPrivateConnectors);
    },
    toolDefinitionsFor(
      surface: ConnectorCapabilitySurface
    ): readonly PrivateConnectorToolDefinition[] {
      return definitionsFor(surface, enabledPrivateConnectors);
    },
    projectRole(surface: ConnectorCapabilitySurface, role: RoleConfig): RoleConfig {
      const projectedTools = projectPrivateToolPolicy(surface, role, this);
      return {
        ...role,
        allowedTools: [...projectedTools.allowedTools],
        blockedTools: [...projectedTools.blockedTools],
        allowedPaths: role.allowedPaths === undefined ? undefined : [...role.allowedPaths],
      };
    },
    promptOverlayFor(surface: ConnectorCapabilitySurface): string {
      return overlayFor(surface, enabledPrivateConnectors);
    },
  });
}

export function visibleConnectorNames(configuredNames: readonly string[]): readonly string[] {
  const configuredPrivateNames = configuredNames.filter((name) =>
    PRIVATE_CONNECTORS.includes(name as 'kagemusha')
  );
  return uniqueStrings([...AVAILABLE_CONNECTORS, ...configuredPrivateNames]);
}

export function resolvePrivatePrincipalSurface(
  context: Pick<GatewayToolExecutionContext, 'agentContext'>
): ConnectorCapabilitySurface {
  const agentContext = context.agentContext;
  if (agentContext === undefined) {
    return 'legacy-unbound';
  }
  if (agentContext.source === 'viewer') {
    return 'os_agent';
  }
  switch (agentContext.roleName) {
    case 'owner_console':
    case 'workorder-board':
    case 'workorder-memory-curation':
    case 'workorder-temporal':
    case 'operator-report':
      return agentContext.roleName;
    default:
      return 'multi-agent-generic';
  }
}
