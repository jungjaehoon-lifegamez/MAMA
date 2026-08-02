/**
 * Connector read scope for gateway tools that read a raw connector DIRECTLY.
 *
 * Most connector evidence reaches a run through `context_compile`, `raw.*`, or a
 * connector-specific reader that already declares its target, so the envelope
 * enforcer can derive the requested connector from the call itself. A handful of
 * tools instead answer straight from a live connector API. Those had NO mapping,
 * which meant `envelope.scope.raw_connectors` never applied to them: whoever held
 * the tool in their role allowlist could read the connector regardless of scope,
 * and the Code-Act projection likewise handed the tool to any sandbox whose role
 * listed it.
 *
 * This module is the single place that says "tool X reads connector Y". Both the
 * envelope enforcer (runtime denial) and the Code-Act tool projection (the tool is
 * never offered in the first place) consult it, so the two layers cannot drift.
 *
 * Adding a direct connector reader WITHOUT registering it here silently re-opens
 * the same hole.
 */

/** Tools that read a raw connector directly, mapped to the connector they read. */
const DIRECT_CONNECTOR_READ_TOOLS: ReadonlyMap<string, string> = new Map([
  ['kagemusha_overview', 'kagemusha'],
  ['kagemusha_entities', 'kagemusha'],
  ['kagemusha_tasks', 'kagemusha'],
  ['kagemusha_messages', 'kagemusha'],
  ['trello_card', 'trello'],
  ['trello_kanban', 'trello'],
  ['trello_search', 'trello'],
  // Correlation reads the same live board internally to resolve ledger rows against
  // it; registering it here keeps that read under the same scope instead of making
  // the tool a way around it.
  ['task_external_correlation', 'trello'],
]);

/**
 * The raw connector a tool reads directly, or null when the tool is not a direct
 * connector reader (its scope, if any, is derived from its arguments elsewhere).
 */
export function directConnectorReadForTool(toolName: string): string | null {
  return DIRECT_CONNECTOR_READ_TOOLS.get(toolName) ?? null;
}

/**
 * Whether a direct connector reader may be offered/executed under the given
 * envelope raw-connector scope.
 *
 * `null` means the caller supplied no envelope information at all (non-runtime
 * callers, tests) and must not be filtered; `[]` means an envelope exists and
 * grants no connector read authority, which denies every direct reader. This
 * matches how destination scope is already treated.
 */
export function directConnectorReadAllowed(
  toolName: string,
  envelopeRawConnectors: readonly string[] | null
): boolean {
  const required = directConnectorReadForTool(toolName);
  if (required === null || envelopeRawConnectors === null) {
    return true;
  }
  return envelopeRawConnectors.includes(required);
}
