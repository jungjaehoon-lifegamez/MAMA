# Embedding Server Ownership Consolidation Plan

Date: 2026-02-13
Branch: refactor/embedding-server-ownership
Owner: Codex + User

## 1) Problem Statement

- `mcp-server` and `standalone` both attempt to start embedding HTTP server.
- Port defaults are inconsistent (`3847` vs `3849`) across server/client paths.
- Most embedding calls use local `generateEmbedding()` directly, while HTTP embedding client path is underused.
- Multi-client usage (Codex/Gemini/Claude Code) increases chance of startup contention and duplicated model loads.

## 2) Target Architecture (Proposed)

- Standalone is the single owner of HTTP embedding server.
- MCP server runs stdio tools only by default and does not start HTTP embedding server.
- Port semantics are explicit:
  - `3847`: Standalone API/UI gateway
  - `3849`: Embedding HTTP + mobile chat internals
- Shared contract for health fields and takeover behavior remains in `mama-core`.

## 3) Scope

In scope:

- Ownership and startup behavior cleanup
- Port/env normalization
- Dead/legacy startup path cleanup
- Documentation alignment

Out of scope:

- Embedding model replacement
- Vector schema migration
- Full plugin architecture rewrite

## 4) Execution Plan

1. Ownership toggle in MCP server

- Add explicit default to skip HTTP embedding startup in `mcp-server`.
- Keep opt-in flag for legacy environments that still need MCP-launched HTTP.

2. Port/env normalization in mama-core

- Unify embedding server/client default port to `3849`.
- Keep backward-compatible fallback reading from port file and env.
- Ensure session/websocket defaults match embedding server default.

3. Standalone startup contract hardening

- Keep takeover flow but align log messages and env names.
- Ensure startup checks use the normalized port constants only.

4. Remove dead paths

- Remove or fix `packages/mcp-server/start-http-server.js` path mismatch.

5. Dependency cleanup

- Keep `@huggingface/transformers` ownership in `mama-core`.
- Remove direct transformers dependency from `mcp-server` (and verify no direct runtime import remains).
- Follow-up sweep for `openclaw-plugin` / `claude-code-plugin` direct transformers deps.

6. Docs and runbook

- Update READMEs and AGENTS references where port/ownership is outdated.
- Add one recommended multi-client topology section.

7. Verification

- Start standalone and validate:
  - `GET 127.0.0.1:3847/api/dashboard/status`
  - `GET 127.0.0.1:3849/health`
- Start MCP from Codex/Claude/Gemini and confirm no HTTP startup race logs.
- Run test suites for touched packages.

## 5) Risk & Mitigation

- Risk: Existing users depend on MCP-launched HTTP viewer.
  - Mitigation: Keep opt-in env to enable legacy behavior.
- Risk: Existing docs/examples assume `3847` embedding endpoint.
  - Mitigation: Document migration and fallback behavior clearly.
- Risk: Status confusion due to PID-only checks.
  - Mitigation: Follow-up task to improve `mama status` runtime probing.

## 6) Definition of Done

- Single owner for embedding HTTP startup is enforced by default.
- No port default contradictions between embedding server/client/session API.
- `mcp-server` does not directly depend on transformers runtime package.
- MCP tools work with standalone running and without standalone.
- Documentation no longer contradicts runtime behavior.
