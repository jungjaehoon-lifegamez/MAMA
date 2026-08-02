import { minimatch } from 'minimatch';

import {
  projectPrivateToolPolicy,
  type ConnectorCapabilitySurface,
  type PrivateConnectorPolicy,
} from '../connectors/private-connector-policy.js';
import { wrapPrivatePromptOverlay } from '../connectors/private-prompt-overlay.js';
import { ToolRegistry } from './tool-registry.js';

export interface GatewayToolCatalogInput {
  surface: ConnectorCapabilitySurface;
  allowedTools?: readonly string[];
  blockedTools?: readonly string[];
  privateConnectorPolicy: PrivateConnectorPolicy;
}

export interface GatewayToolCatalog {
  cacheKey: string;
  toolNames: readonly string[];
  prompt: string;
}

const catalogCache = new Map<string, GatewayToolCatalog>();

function canonicalPatterns(patterns: readonly string[] | undefined, fallback: readonly string[]) {
  return [...new Set(patterns ?? fallback)].sort();
}

function buildCacheKey(input: GatewayToolCatalogInput): string {
  return JSON.stringify({
    surface: input.surface,
    allowedTools: canonicalPatterns(input.allowedTools, ['*']),
    blockedTools: canonicalPatterns(input.blockedTools, []),
    privateConnectorPolicyFingerprint: input.privateConnectorPolicy.fingerprint,
  });
}

export function buildGatewayToolCatalog(input: GatewayToolCatalogInput): GatewayToolCatalog {
  const cacheKey = buildCacheKey(input);
  const cached = catalogCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const expandedAllowed = ToolRegistry.expandToolPatterns(input.allowedTools);
  const projected = projectPrivateToolPolicy(
    input.surface,
    {
      allowedTools: expandedAllowed,
      blockedTools: input.blockedTools === undefined ? [] : [...input.blockedTools],
    },
    input.privateConnectorPolicy
  );
  const toolNames = Object.freeze(
    ToolRegistry.expandToolPatterns(projected.allowedTools).filter(
      (name) => !projected.blockedTools.some((pattern) => minimatch(name, pattern))
    )
  );
  const catalogPrompt = ToolRegistry.generatePrompt(toolNames);
  const overlay = input.privateConnectorPolicy.promptOverlayFor(input.surface).trim();
  const prompt = overlay
    ? `${catalogPrompt}\n\n${wrapPrivatePromptOverlay(overlay)}`
    : catalogPrompt;
  const catalog = Object.freeze({ cacheKey, toolNames, prompt });
  catalogCache.set(cacheKey, catalog);
  return catalog;
}
