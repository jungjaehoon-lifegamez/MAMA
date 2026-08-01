import {
  PRIVATE_CONNECTOR_PROMPT_OVERLAY,
  PRIVATE_CONNECTOR_TOOL_DEFINITIONS,
  type ConnectorCapabilitySurface,
  type PrivateConnectorPolicy,
  type PrivateConnectorToolDefinition,
} from './private-connector-policy.js';

export const PRIVATE_PROMPT_OVERLAY_START = '<!-- MAMA private connector overlay:start -->';
export const PRIVATE_PROMPT_OVERLAY_END = '<!-- MAMA private connector overlay:end -->';

function formatPrivatePromptOverlay(
  overlay: string,
  definitions: readonly PrivateConnectorToolDefinition[]
): string {
  return [
    overlay.trim(),
    '',
    ...definitions.map(
      (definition) =>
        `- **${definition.name}**(${definition.params ?? ''}) — ${definition.description}`
    ),
  ].join('\n');
}

export function wrapPrivatePromptOverlay(content: string): string {
  return `${PRIVATE_PROMPT_OVERLAY_START}\n${content}\n${PRIVATE_PROMPT_OVERLAY_END}`;
}

const CANONICAL_PRIVATE_PROMPT_OVERLAYS = new Set([
  wrapPrivatePromptOverlay(
    formatPrivatePromptOverlay(PRIVATE_CONNECTOR_PROMPT_OVERLAY, PRIVATE_CONNECTOR_TOOL_DEFINITIONS)
  ),
]);

/**
 * Remove only complete host-generated overlays. Any unmatched, nested, or
 * non-canonical marker text makes cleanup fail closed and preserves every byte.
 */
export function stripMarkedPrivatePromptOverlays(raw: string): string {
  const removals: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf(PRIVATE_PROMPT_OVERLAY_START, cursor);
    const strayEnd = raw.indexOf(PRIVATE_PROMPT_OVERLAY_END, cursor);
    if (start < 0) {
      return strayEnd < 0 ? applyRemovals(raw, removals) : raw;
    }
    if (strayEnd >= 0 && strayEnd < start) {
      return raw;
    }

    const contentStart = start + PRIVATE_PROMPT_OVERLAY_START.length;
    const endStart = raw.indexOf(PRIVATE_PROMPT_OVERLAY_END, contentStart);
    const nestedStart = raw.indexOf(PRIVATE_PROMPT_OVERLAY_START, contentStart);
    if (endStart < 0 || (nestedStart >= 0 && nestedStart < endStart)) {
      return raw;
    }
    const end = endStart + PRIVATE_PROMPT_OVERLAY_END.length;
    if (CANONICAL_PRIVATE_PROMPT_OVERLAYS.has(raw.slice(start, end))) {
      removals.push({ start, end });
    }
    cursor = end;
  }
  return applyRemovals(raw, removals);
}

function applyRemovals(
  raw: string,
  removals: ReadonlyArray<{ start: number; end: number }>
): string {
  let projected = raw;
  for (let index = removals.length - 1; index >= 0; index -= 1) {
    const removal = removals[index]!;
    projected = projected.slice(0, removal.start) + projected.slice(removal.end);
  }
  return projected;
}

export function buildPrivatePromptOverlay(
  surface: ConnectorCapabilitySurface,
  policy: PrivateConnectorPolicy
): string {
  const overlay = policy.promptOverlayFor(surface).trim();
  const definitions = policy.toolDefinitionsFor(surface);
  if (!overlay || definitions.length === 0) {
    return '';
  }
  return wrapPrivatePromptOverlay(formatPrivatePromptOverlay(overlay, definitions));
}
