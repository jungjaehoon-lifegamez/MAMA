import { minimatch } from 'minimatch';
import { HostBridge, isToolAvailableAtTier, type ToolMeta } from './host-bridge.js';

export type CodeActTier = 1 | 2 | 3;

export interface CodeActRoleToolPolicy {
  readonly allowedTools?: readonly string[];
  readonly blockedTools?: readonly string[];
}

export interface CodeActToolPolicyInput {
  readonly tier: CodeActTier;
  readonly roleName?: string;
  readonly role?: CodeActRoleToolPolicy;
  readonly disallowedTools?: readonly string[];
  readonly requestedAllowedTools?: unknown;
  readonly requestedBlockedTools?: unknown;
  /** Undefined preserves non-runtime callers; [] explicitly means no destination authority. */
  readonly envelopeDestinationKinds?: readonly string[];
  /** Undefined preserves non-runtime callers; [] explicitly means no connector read authority. */
  readonly envelopeRawConnectors?: readonly string[];
}

export interface CodeActToolPolicyFingerprintData {
  readonly version: 4;
  readonly inputs: {
    readonly tier: CodeActTier;
    readonly roleName: string | null;
    readonly roleAllowedTools: readonly string[] | null;
    readonly roleBlockedTools: readonly string[];
    readonly runtimeDisallowedTools: readonly string[];
    readonly requestedAllowedTools: readonly string[] | null;
    readonly requestedBlockedTools: readonly string[];
    readonly envelopeDestinationKinds: readonly string[] | null;
    readonly envelopeRawConnectors: readonly string[] | null;
  };
  readonly tools: readonly ToolMeta[];
}

export type CodeActToolPolicyFingerprintPayload = string;

export interface CodeActToolPolicy {
  readonly names: readonly string[];
  readonly definitions: readonly ToolMeta[];
  readonly fingerprintPayload: CodeActToolPolicyFingerprintPayload;
}

export class CodeActToolPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeActToolPolicyValidationError';
  }
}

/**
 * Resolve every Code-Act tool-policy input against the HostBridge registry.
 * Role and runtime policy establish the upper bound; model-requested fields can
 * only intersect with or subtract from that bound.
 */
export function projectCodeActToolPolicy(input: CodeActToolPolicyInput): CodeActToolPolicy {
  const tier = requireCodeActTier(input.tier);
  const registry = HostBridge.getToolRegistry();
  const registryNames = registry.map((tool) => tool.name);
  const roleAllowedTools = normalizePatterns(input.role?.allowedTools);
  const roleBlockedTools = normalizePatterns(input.role?.blockedTools) ?? [];
  const runtimeDisallowedTools = normalizePatterns(input.disallowedTools) ?? [];
  const requestedAllowedTools = normalizeModelPatterns(
    input.requestedAllowedTools,
    'requestedAllowedTools',
    registryNames
  );
  const requestedBlockedTools =
    normalizeModelPatterns(input.requestedBlockedTools, 'requestedBlockedTools', registryNames) ??
    [];
  const envelopeDestinationKinds = input.envelopeDestinationKinds
    ? [...new Set(input.envelopeDestinationKinds)].sort(compareStrings)
    : input.envelopeDestinationKinds === undefined
      ? null
      : [];
  const envelopeRawConnectors = input.envelopeRawConnectors
    ? [...new Set(input.envelopeRawConnectors)].sort(compareStrings)
    : input.envelopeRawConnectors === undefined
      ? null
      : [];

  const definitionsByName = new Map<string, ToolMeta>();
  for (const tool of registry) {
    const allowed =
      isToolAvailableAtTier(tool.name, tier) &&
      (!tool.name.startsWith('drive_') || input.roleName === 'owner_console') &&
      driveToolAllowed(
        tool.name,
        envelopeRawConnectors,
        envelopeDestinationKinds,
        input.roleName === 'owner_console'
      ) &&
      (roleAllowedTools === null || matchesAny(tool.name, roleAllowedTools)) &&
      !matchesAny(tool.name, roleBlockedTools) &&
      !matchesAny(tool.name, runtimeDisallowedTools) &&
      (requestedAllowedTools === null || matchesAny(tool.name, requestedAllowedTools)) &&
      !matchesAny(tool.name, requestedBlockedTools);
    if (allowed && !definitionsByName.has(tool.name)) {
      definitionsByName.set(tool.name, cloneToolMeta(tool));
    }
  }
  const definitions = Object.freeze(
    [...definitionsByName.values()].sort((left, right) => compareStrings(left.name, right.name))
  );
  const names = Object.freeze(definitions.map((tool) => tool.name));
  const fingerprintData: CodeActToolPolicyFingerprintData = {
    version: 4,
    inputs: {
      tier,
      roleName: input.roleName ?? null,
      roleAllowedTools,
      roleBlockedTools,
      runtimeDisallowedTools,
      requestedAllowedTools,
      requestedBlockedTools,
      envelopeDestinationKinds,
      envelopeRawConnectors,
    },
    tools: definitions.map(cloneToolMeta),
  };

  return Object.freeze({
    names,
    definitions,
    fingerprintPayload: JSON.stringify(fingerprintData),
  });
}

function driveToolAllowed(
  toolName: string,
  rawConnectors: readonly string[] | null,
  destinationKinds: readonly string[] | null,
  ownerConsole: boolean
): boolean {
  if (ownerConsole && toolName.startsWith('drive_')) {
    return true;
  }
  if (!toolName.startsWith('drive_') || (rawConnectors === null && destinationKinds === null)) {
    return true;
  }

  const canRead = rawConnectors?.includes('drive') === true;
  const canWrite = destinationKinds?.includes('drive') === true;
  if (toolName === 'drive_upload') {
    return canWrite;
  }
  if (toolName === 'drive_translate_conti') {
    return canRead && canWrite;
  }
  return canRead;
}

export function requireCodeActTier(tier: unknown): CodeActTier {
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    throw new CodeActToolPolicyValidationError(
      `Invalid Code-Act tier: expected 1, 2, or 3; received ${String(tier)}`
    );
  }
  return tier;
}

function normalizeModelPatterns(
  patterns: unknown,
  fieldName: 'requestedAllowedTools' | 'requestedBlockedTools',
  registryNames: readonly string[]
): string[] | null {
  if (patterns === undefined) {
    return null;
  }
  if (!Array.isArray(patterns)) {
    throw new CodeActToolPolicyValidationError(
      `${fieldName} must be an array of gateway tool names.`
    );
  }
  if (!patterns.every((pattern): pattern is string => typeof pattern === 'string')) {
    throw new CodeActToolPolicyValidationError(
      `${fieldName} must contain non-empty gateway tool names.`
    );
  }
  const normalized = normalizePatterns(patterns);
  if (normalized === null) {
    return null;
  }

  for (const pattern of normalized) {
    if (!registryNames.some((name) => minimatch(name, pattern))) {
      throw new CodeActToolPolicyValidationError(
        `Unknown Code-Act tool pattern in ${fieldName}: ${pattern}`
      );
    }
  }
  return normalized;
}

function normalizePatterns(patterns: readonly string[] | undefined): string[] | null {
  if (patterns === undefined) {
    return null;
  }

  const normalized = new Set<string>();
  for (const pattern of patterns) {
    const value = pattern.trim();
    if (value.length === 0) {
      throw new CodeActToolPolicyValidationError(
        'Code-Act tool patterns must contain non-empty names.'
      );
    }
    normalized.add(value);
  }
  return [...normalized].sort(compareStrings);
}

function matchesAny(toolName: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(toolName, pattern));
}

function cloneToolMeta(tool: ToolMeta): ToolMeta {
  const params = Object.freeze(tool.params.map((param) => Object.freeze({ ...param })));
  return Object.freeze({
    ...tool,
    params,
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
