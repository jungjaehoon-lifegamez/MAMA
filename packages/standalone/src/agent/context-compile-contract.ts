/** Canonical authority contract projected on every context_compile tool surface. */
export const CONTEXT_COMPILE_TOOL_DESCRIPTION =
  'Compile and persist an append-only scoped context packet from visible memory, raw, graph, and case evidence. AUTHORITY: OMIT scopes and connectors to use the current host-bound grants (recommended). Supply either field only to intentionally narrow the read; explicit values must remain authorized subsets and can never widen access. strictness is recall, balanced, or strict. Unavailable to Tier 3/read-only agents.';

/** Temporal workers have one host-selected task and must not choose authority inputs. */
export const TEMPORAL_CONTEXT_COMPILE_INSTRUCTION =
  'Do not supply scopes, connectors, or seed_refs to context_compile. The host-bound execution context applies the current generation project, connector, and memory grants and adds the active temporal task seed.';
