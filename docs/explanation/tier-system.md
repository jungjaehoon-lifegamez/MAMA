# Worker Tool Tiers

A `tier` field on an internal managed worker controls which native tools its subprocess may use.
That is the only tier system MAMA has.

## There is no search tier

Earlier versions of this page described a two-tier search system: vector search as Tier 1, an
exact-match SQL fallback as Tier 2, with automatic detection and a documented upgrade path. None
of it exists.

The flag that would have selected the fallback, `DatabaseAdapter.vectorSearchEnabled`, had one
implementation, was initialised to `true`, and was never assigned anywhere else. It is gone with
this page. There is no `getTier()`, no tier detection, no exact-match fallback, and no tier
indicator in results. Search is vector search over the local embedding model, with FTS5 alongside
it - see [Semantic Search](semantic-search.md).

`MAMA_FORCE_TIER_3` keeps its name but is not part of any tier system: it makes
`assertEmbeddingsEnabled()` throw before the model loads, so tests skip embedding work. It fails
loudly rather than degrading, which is why it is not a search mode.

The tutorial and the remediation guide that taught readers to diagnose and escape Tier 2 are
removed with it; they described a state that cannot occur.

---

## Internal Worker Tool Tiers (Advanced/Legacy)

Separate from the search tiers above, legacy/internal managed workers use a tier field to control
which native tools a subprocess may use. These tiers do not define human-team access and do not
grant a member access to a Case, memory, artifact, or destination. Human access belongs to the v1
principal-grant contract. Ground truth for the surviving process-level tier is
`packages/standalone/src/multi-agent/tool-permission-manager.ts`.

### Defaults (verbatim from code)

| Tier       | Allowed                                         | Blocked                                 |
| ---------- | ----------------------------------------------- | --------------------------------------- |
| **Tier 1** | `*` (everything)                                | -                                       |
| **Tier 2** | `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` | `Write`, `Edit`, `Bash`, `NotebookEdit` |
| **Tier 3** | same as Tier 2                                  | same as Tier 2                          |

Two things the old version of this page got wrong:

- **Tier 2 and Tier 3 defaults are byte-identical.** Downgrading an agent from 2 to 3 changes nothing by default. Differences only come from an explicit `tool_permissions` block on the persona.
- **These are Claude-Code-native tool names, not MAMA gateway tools.** Memory writes (`mama_save`, `mama_update`) are NOT granted by tier; they require an explicit `tool_permissions` allowlist, and gateway-tool authority is governed separately by per-run envelopes (see the generated catalog `packages/standalone/src/agent/gateway-tools.md`).

Delegation (`can_delegate`) is accepted and persisted by the API but **inert**: the host `delegate` tool and its executor no longer exist. MAMA delegates through the model runtime's native subagents instead.

Tier 3 agents cannot opt into Code-Act and fall back to normal tool-call mode. The `/api/code-act` HTTP endpoint defaults to Tier 2 for Code-Act-enabled agents, but can be forced into read-only injection with `MAMA_CODE_ACT_READ_ONLY=true`.

### Configuration

Personas live in `config.yaml` under `multi_agent.agents` (there is no `~/.mama/agents/` directory):

```yaml
multi_agent:
  agents:
    reviewer:
      tier: 2 # 1, 2, or 3 (default: 1)
```

Or via API:

```bash
curl -X PUT http://localhost:3847/api/multi-agent/agents/reviewer \
  -H "Content-Type: application/json" \
  -d '{"tier": 2}'
```

---

## See Also

- [Performance Characteristics](performance.md) - Search latency
- [Semantic Search](semantic-search.md) - How retrieval actually works
- [Architecture](architecture.md) - Where search lives
- [Security Guide](../guides/security.md) - Code-Act sandbox security
