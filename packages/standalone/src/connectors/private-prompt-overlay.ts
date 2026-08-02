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

const PRIVATE_TOOL_NAMES = PRIVATE_CONNECTOR_TOOL_DEFINITIONS.map((definition) => definition.name);
const PRIVATE_CONNECTOR_DIRECTIVE_PATTERN =
  /\b(?:always|call|check|fetch|first|gather|inspect|invoke|must|never|query|read|run|should|then|use)\b/i;
const PATH_REFERENCE_PATTERN = /(?:^|\s)(?:\.{0,2}\/|\/|[A-Za-z]:\\)\S+/g;
const MARKDOWN_WRAPPER_MARKERS = new Set(['`', '*', '_', '~']);

type MarkdownToolIdentifierSpan = Readonly<{
  start: number;
  end: number;
}>;

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function expandMatchedMarkdownWrapper(
  line: string,
  span: MarkdownToolIdentifierSpan
): MarkdownToolIdentifierSpan | null {
  const marker = line[span.start - 1];
  if (marker === undefined || !MARKDOWN_WRAPPER_MARKERS.has(marker)) {
    return null;
  }

  let start = span.start;
  while (start > 0 && line[start - 1] === marker) {
    start -= 1;
  }

  let end = span.end;
  while (end < line.length && line[end] === marker) {
    end += 1;
  }

  const openingLength = span.start - start;
  const closingLength = end - span.end;
  if (openingLength !== closingLength || (marker === '~' && openingLength !== 2)) {
    return null;
  }
  return { start, end };
}

function normalizeMarkdownToolIdentifier(
  line: string,
  index: number,
  toolName: string
): MarkdownToolIdentifierSpan {
  let span: MarkdownToolIdentifierSpan = {
    start: index,
    end: index + toolName.length,
  };
  let expanded = expandMatchedMarkdownWrapper(line, span);
  // Every successful layer consumes characters on both sides, bounding the scan by the line.
  while (expanded !== null) {
    span = expanded;
    expanded = expandMatchedMarkdownWrapper(line, span);
  }
  return span;
}

function isPrivateToolInvocation(line: string, toolName: string): boolean {
  let cursor = 0;
  while (cursor < line.length) {
    const index = line.indexOf(toolName, cursor);
    if (index < 0) {
      return false;
    }
    const span = normalizeMarkdownToolIdentifier(line, index, toolName);
    if (!isIdentifierCharacter(line[span.start - 1]) && /^\s*\(/.test(line.slice(span.end))) {
      return true;
    }
    cursor = index + toolName.length;
  }
  return false;
}

function containsPrivatePromptRecipe(line: string): boolean {
  const withoutPaths = line.replace(PATH_REFERENCE_PATTERN, ' ');
  const mentionedTools = PRIVATE_TOOL_NAMES.filter((name) => withoutPaths.includes(name));
  if (mentionedTools.length > 0) {
    return (
      PRIVATE_CONNECTOR_DIRECTIVE_PATTERN.test(withoutPaths) ||
      mentionedTools.some((name) => isPrivateToolInvocation(withoutPaths, name))
    );
  }
  return (
    /\bkagemusha\b/i.test(withoutPaths) && PRIVATE_CONNECTOR_DIRECTIVE_PATTERN.test(withoutPaths)
  );
}

/**
 * Remove private call recipes from a disabled surface without rewriting the
 * user-owned file. Historical prose and path references remain ordinary user
 * context; malformed host markers remain byte-for-byte fail-closed.
 */
export function stripDisabledPrivatePromptRecipes(
  raw: string,
  privateToolsEnabled: boolean
): string {
  if (
    privateToolsEnabled ||
    raw.includes(PRIVATE_PROMPT_OVERLAY_START) ||
    raw.includes(PRIVATE_PROMPT_OVERLAY_END)
  ) {
    return raw;
  }

  const parts = raw.split(/(\r?\n)/);
  let projected = '';
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? '';
    const separator = parts[index + 1] ?? '';
    if (!containsPrivatePromptRecipe(line)) {
      projected += line + separator;
    }
  }
  return projected;
}

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
