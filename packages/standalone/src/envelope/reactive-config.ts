import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { MAMAConfig } from '../cli/config/types.js';
import type { NormalizedMessage } from '../gateways/types.js';
import { deriveMemoryScopes } from '../memory/scope-context.js';
import type { DestinationRef, Envelope, MemoryScope, ProjectRef } from './types.js';

export type EnvLike = Record<string, string | undefined>;

export interface ReactiveEnvelopeConfig {
  projectRefsFor(message: NormalizedMessage): ProjectRef[];
  rawConnectorsFor(message: NormalizedMessage): string[];
  memoryScopesFor(message: NormalizedMessage): MemoryScope[];
  sourceFor?(message: NormalizedMessage): Envelope['source'];
  allowedDestinationsFor?(message: NormalizedMessage): DestinationRef[];
  reactiveBudgetSeconds: number;
}

export interface ReactiveRoutePolicy {
  source: Envelope['source'];
  projectRefs: ProjectRef[];
  rawConnectors: string[];
  memoryScopes: MemoryScope[];
  allowedDestinations: DestinationRef[];
  reactiveBudgetSeconds: number;
}

type StaticRoute = {
  source: Envelope['source'];
  rawConnectors: string[];
  allowedDestinations(message: NormalizedMessage): DestinationRef[];
};

const REACTIVE_ROUTE_TABLE = {
  telegram: {
    source: 'telegram',
    rawConnectors: ['telegram'],
    allowedDestinations: (message: NormalizedMessage) => [
      { kind: 'telegram', id: message.channelId },
    ],
  },
  slack: {
    source: 'slack',
    rawConnectors: ['slack'],
    allowedDestinations: (message: NormalizedMessage) => [{ kind: 'slack', id: message.channelId }],
  },
  chatwork: {
    source: 'chatwork',
    rawConnectors: ['chatwork'],
    allowedDestinations: (message: NormalizedMessage) => [
      { kind: 'chatwork', id: message.channelId },
    ],
  },
  discord: {
    source: 'discord',
    rawConnectors: ['discord'],
    allowedDestinations: (message: NormalizedMessage) => [
      { kind: 'discord', id: message.channelId },
    ],
  },
  viewer: {
    source: 'viewer',
    rawConnectors: [],
    allowedDestinations: (message: NormalizedMessage) => [
      { kind: 'webchat', id: message.channelId },
    ],
  },
  mobile: {
    source: 'viewer',
    rawConnectors: [],
    allowedDestinations: (message: NormalizedMessage) => [
      { kind: 'webchat', id: message.channelId },
    ],
  },
  system: {
    source: 'watch',
    rawConnectors: [],
    allowedDestinations: () => [],
  },
} satisfies Record<NormalizedMessage['source'], StaticRoute>;

function isReactiveEnvelopeConfig(
  config: MAMAConfig | ReactiveEnvelopeConfig
): config is ReactiveEnvelopeConfig {
  const candidate = config as Partial<ReactiveEnvelopeConfig>;
  return (
    typeof candidate.projectRefsFor === 'function' &&
    typeof candidate.rawConnectorsFor === 'function' &&
    typeof candidate.memoryScopesFor === 'function' &&
    typeof candidate.reactiveBudgetSeconds === 'number'
  );
}

function getStaticRoute(message: NormalizedMessage): StaticRoute {
  const route = REACTIVE_ROUTE_TABLE[message.source];
  if (!route) {
    throw new Error(`[envelope] unsupported message source: ${String(message.source)}`);
  }
  return route;
}

function homeFromEnv(env: EnvLike): string {
  const home = env.HOME;
  return home && home.trim() ? home : homedir();
}

function expandRequiredPath(rawPath: string, env: EnvLike, label: string): string {
  const home = homeFromEnv(env);
  let expanded = rawPath.trim();
  if (!expanded) {
    throw new Error(`[envelope] ${label} must not be empty`);
  }
  expanded = expanded
    .replace(/^~(?=$|\/)/, home)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME(?=$|\/)/g, home);

  if (!isAbsolute(expanded)) {
    throw new Error(`[envelope] ${label} must resolve to an absolute path`);
  }
  return resolve(expanded);
}

export function resolveReactiveProjectRoot(config: MAMAConfig, env: EnvLike = process.env): string {
  if (config.workspace?.path !== undefined) {
    return expandRequiredPath(config.workspace.path, env, 'workspace.path');
  }

  const workspaceFromEnv = env.MAMA_WORKSPACE;
  if (workspaceFromEnv !== undefined) {
    return expandRequiredPath(workspaceFromEnv, env, 'MAMA_WORKSPACE');
  }

  return expandRequiredPath(join(homeFromEnv(env), '.mama', 'workspace'), env, 'default workspace');
}

function reactiveBudgetSeconds(config: MAMAConfig): number {
  const seconds = Number(config.timeouts?.agent_ms) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 300;
}

export function getReactiveRoutePolicy(
  message: NormalizedMessage,
  config: MAMAConfig | ReactiveEnvelopeConfig,
  env: EnvLike = process.env
): ReactiveRoutePolicy {
  const route = getStaticRoute(message);

  if (isReactiveEnvelopeConfig(config)) {
    return {
      source: config.sourceFor?.(message) ?? route.source,
      projectRefs: config.projectRefsFor(message),
      rawConnectors: config.rawConnectorsFor(message),
      memoryScopes: config.memoryScopesFor(message),
      allowedDestinations:
        config.allowedDestinationsFor?.(message) ?? route.allowedDestinations(message),
      reactiveBudgetSeconds: config.reactiveBudgetSeconds,
    };
  }

  const source = route.source;
  const projectId = resolveReactiveProjectRoot(config, env);
  const memoryScopes = deriveMemoryScopes({
    source,
    channelId: message.channelId,
    userId: message.userId,
    projectId,
  }) as MemoryScope[];

  return {
    source,
    projectRefs: [{ kind: 'project', id: projectId }],
    rawConnectors: [...route.rawConnectors],
    memoryScopes,
    allowedDestinations: route.allowedDestinations(message),
    reactiveBudgetSeconds: reactiveBudgetSeconds(config),
  };
}

export function createDefaultReactiveEnvelopeConfig(
  config: MAMAConfig,
  env: EnvLike = process.env
): ReactiveEnvelopeConfig {
  const budgetSeconds = reactiveBudgetSeconds(config);
  resolveReactiveProjectRoot(config, env);
  const policyCache = new WeakMap<NormalizedMessage, ReactiveRoutePolicy>();
  const policyFor = (message: NormalizedMessage): ReactiveRoutePolicy => {
    const cached = policyCache.get(message);
    if (cached) {
      return cached;
    }
    const policy = getReactiveRoutePolicy(message, config, env);
    policyCache.set(message, policy);
    return policy;
  };

  return {
    projectRefsFor: (message) => policyFor(message).projectRefs,
    rawConnectorsFor: (message) => policyFor(message).rawConnectors,
    memoryScopesFor: (message) => policyFor(message).memoryScopes,
    sourceFor: (message) => policyFor(message).source,
    allowedDestinationsFor: (message) => policyFor(message).allowedDestinations,
    reactiveBudgetSeconds: budgetSeconds,
  };
}
