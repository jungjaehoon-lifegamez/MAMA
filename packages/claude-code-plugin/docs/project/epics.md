# MAMA Plugin – Migration Epics

**Author:** spellon (updated 2025-11-21 by Codex)\
**Scope:** Migrate the proven MAMA stack from `mcp-server/` into the new standalone `mama-plugin/` without re‑implementing working functionality.\
**Source Docs:** [MAMA-PRD](./MAMA-PRD.md), [MAMA-CODE-REUSE-ANALYSIS](./MAMA-CODE-REUSE-ANALYSIS.md)

---

## 1. Why We Hit Reset

- The rewrite inside `mama-plugin/` diverged from [PRD](./MAMA-PRD.md) scope and now lags far behind the existing `mcp-server/` implementation (Story 1.5 is the furthest we got, yet feature parity is worse).  
- `MAMA-CODE-REUSE-ANALYSIS.md` shows **~70% of the required LOC already exist** and are production validated. Re-implementing them in the new folder is wasteful and risks regressions.  
- Decision: **discard the partially re-written code**, treat the new repository as a packaging/migration effort, and focus engineering time on the net-new plugin surface (hooks, commands, packaging, docs).

> Guiding quote: "발명된 바퀴를 다시 만들지 않기" – reuse the wheel.

---

## 2. Migration-First Principles

1. **Reuse before Rewrite** – copy/adapt modules from `mcp-server/src/mama/` into `mama-plugin/src/` unless there is a hard plugin constraint.
2. **Parity Gate** – do not ship a plugin build until it can at least match the MCP server feature set for FR1‑FR44.
3. **Folder Contract** – `mcp-server/` stays the source of truth until the plugin passes regression tests; treat the new code as a consumer package.
4. **Story Reset** – old stories 1.x/2.x/3.x/... move into migration buckets (M1.x, M2.x) so the backlog reflects reality.
5. **Traceability** – every migration step links back to the PRD functional requirements and references the file origin (path + commit) for auditing.

---

## 3. Phase & Epic Overview

| Phase | Epic ID | Goal | Source of Truth | FR Coverage | Status |
|-------|---------|------|-----------------|-------------|--------|
| Phase M0 | **Epic M0 – Reset & Alignment** | Kill the rewrite, align on migration plan, lock folders (`mcp-server` = legacy, `mama-plugin` = target). | docs/\*, repo structure | All (governance) | ✅ DONE (this doc) |
| Phase M1 | **Epic M1 – Core Extraction** | Port the database, API, embeddings, semantic search, and outcome tracking modules. | `mcp-server/src/mama/` | FR1‑15, FR40‑44, FR45‑49, FR30‑34 | 🚧 In progress |
| Phase M2 | **Epic M2 – Hook Integration** | Adapt automation hooks (UserPromptSubmit, PreToolUse, PostToolUse) + transparency banner. | `mcp-server/src/mama/memory-inject.js`, scripts | FR16‑24, FR25‑29 | 🟡 Ready |
| Phase M3 | **Epic M3 – Commands & Packaging** | Ship `/mama-*` commands, plugin.json, .mcp.json, installer, Tier detector. | new plugin files + wrappers | FR30‑39, FR50‑55 | 🟡 Ready |
| Phase M4 | **Epic M4 – Quality & Knowledge** | Port tests, regenerate docs, author operator runbooks. | `mcp-server/tests`, docs | Cross-FR validation, FR45‑49, FR53 | ⏳ Pending |
| Phase M5 | **Epic M5 – Claude Desktop Expansion** | Cross-platform DB paths (M5.0), @mama/server NPM packaging, 3 user scenarios documentation. M5.1 deferred. | platform detection, packaging | FR32‑34, FR40‑44 | ⏳ Pending |

Legend: ✅ complete, 🚧 in progress, 🟡 ready to pull, ⏳ pending.

---

## 4. Epic Detail & Re-defined Stories

### 4.1 Epic M0 – Reset & Alignment (Complete)
- **Outcome:** Rewrite halted, `mama-plugin/` code flagged for deletion, decision log captured in [MAMA-CODE-REUSE-ANALYSIS.md](./MAMA-CODE-REUSE-ANALYSIS.md).
- **Actions:** Archive the incomplete TypeScript rewrite, point all contributors to this document, refresh story numbering.
- **Definition of Done:** Repo structure + PRD + this doc all tell the same plan. ✅

### 4.2 Epic M1 – Core Extraction (Week 1)
Goal: deliver the MCP feature set inside the plugin by **migrating** instead of re-coding.

| Story ID | Description | Old Story Mapping | Notes |
|----------|-------------|-------------------|-------|
| **M1.1 – Extract @mama/core** | Copy `mama-api.js`, `embeddings.js`, `decision-tracker.js`, `outcome-tracker.js`, `time-formatter.js`, `decision-formatter.js`, `relevance-scorer.js`, `memory-store.js`, `query-intent.js`. | 1.2, 1.4, 2.x, 3.x, 7.x | Preserve module boundaries; update imports only. |
| **M1.2 – SQLite-only DB adapter** | Strip PostgreSQL paths from `db-manager.js`, move migrations to `mama-plugin/src/db/`, keep WAL defaults. | 1.1 | Ensure file lives under new repo root; maintain migration history. |
| **M1.3 – Tool surface port** | Move MCP tool handlers (`save_decision`, `list_decisions`, `recall_decision`, `suggest_decision`, `update_outcome`). | 1.5, 3.5, 7.1 | Story 1.5 is now a copy task: reuse proven handlers, delete the rewrite. |
| **M1.4 – Config + model selection** | Lift configurable model loader + config parser. | 3.6 | Path: `~/.mama/config.json`, defaults to multilingual-e5-small. |
| **M1.5 – Outcome + audit store** | Bring over audit logging + status calculators (success rate, failure surfacing). | 7.2‑7.5 | Required before exposing stats in hooks/UI. |

Deliverables: `mama-plugin/src/core/*`, `mama-plugin/src/tools/*`, shared tests proving parity.\
Exit Criteria: All FR1‑15 and FR40‑44 pass regression tests in plugin context.

### 4.3 Epic M2 – Hook Integration (Week 2)
Goal: retain automation wins from Claude Code hooks while adapting to plugin APIs.

Story seeds:
1. **M2.1 – UserPromptSubmit hook** (reuse `memory-inject.js`, adapt output schema).
2. **M2.2 – PreToolUse hook** (inject context prior to Read/Edit/Grep; reuse relevance scoring).
3. **M2.3 – PostToolUse auto-save** (new UI wrapper, but persistence uses `mama-api.save()`).
4. **M2.4 – Transparency banner** (Tier badge, degraded mode instructions per FR25‑29).
5. **M2.5 – Hook metrics & logging** (structured logs, p95 latency).

Dependencies: Epic M1 (API parity). Targets FR16‑24 & FR25‑29.

### 4.4 Epic M3 – Commands & Packaging (Week 3)
Goal: expose the features to users and make install zero-touch.

Story seeds:
- **M3.1 – `/mama-save`, `/mama-recall`, `/mama-suggest`, `/mama-list`, `/mama-configure` commands** (thin wrappers around existing API).
- **M3.2 – Auto-context skill** (subscribe to plugin skill surface, reuse filtering pipeline).
- **M3.3 – plugin.json + hooks.json + .mcp.json** (documented in PRD Epic 6).
- **M3.4 – Installer + tier detector** (postinstall scripts, compatibility checks).

Targets FR30‑39, FR30‑34 (packaging), FR50‑55 (model config).

### 4.5 Epic M4 – Quality & Knowledge (Week 4+)
Goal: port the mature test suite + docs so the plugin can be adopted safely.

Story seeds:
- **M4.1 – Unit + integration test port** (reuse `mcp-server/tests`, swap wiring).
- **M4.2 – Regression harness** (match old CLI/regression scripts).
- **M4.3 – User/install docs** (fresh README, troubleshooting, Tier guide).
- **M4.4 – Developer playbook** (architecture + contribution guide).

Targets FR45‑49 (data ownership), FR53 (model guidance), plus PRD quality metrics.

### 4.6 Epic M5 – Claude Desktop Expansion (Week 5+)
Goal: Enable MAMA on Claude Desktop via standalone MCP server with proper cross-platform support.

Story seeds:
- **M5.0 – Cross-Platform DB Path Strategy** ⚠️ **NEW, CRITICAL** – Platform-aware database path detection (Claude Code uses `~/.claude/`, Claude Desktop uses OS-specific paths). Environment variable override for advanced users.
- **M5.1 – Split shared core package** ⏸️ **DEFERRED** – `@mama/core` extraction deferred per Rule of Three principle (only 2 implementations exist, need 3rd consumer to validate interface).
- **M5.2 – Desktop server packaging** – NPM package `@mama/server` with platform-aware paths, global install via `npm install -g @mama/server`.
- **M5.3 – Cross-platform setup docs** – 3 user scenarios (Code only / Code+MCP / Desktop only), platform-specific installation guides (macOS/Windows/Linux), DB sharing options (advanced).
- **M5.4 – Shared DB handoff** – Concurrent access testing, tier state persistence, health check command (`mama-doctor`). Only applies to advanced users sharing DB via `MAMA_DATABASE_PATH`.

Targets FR32‑34, FR40‑44.

**Key Architectural Change**: Claude Desktop **cannot** access `~/.claude/` directory. Default behavior uses separate databases per platform. Advanced users can optionally share via environment variable or symlinks.

---

## 5. Story Re-definition Matrix

| Legacy Story | New Owner | Action |
|--------------|-----------|--------|
| Story 1.1 – Database schema | M1.2 | Copy `db-manager.js` (SQLite path only), delete rewrite from `mama-plugin`. |
| Story 1.2 – CRUD API | M1.1 | Move `mama-api.js` wholesale, wire exports via `@mama/core`. |
| Story 1.3 – MCP server skeleton | M1.3 + M3.3 | Use existing tool handlers, ensure stdio transport only. |
| **Story 1.5 – list_decisions & recall_decision** | **M1.3** | Discard the fresh implementation, re-host the proven handlers and tests from `mcp-server`. |
| Story 2.1‑2.4 – evolution graph | M1.1 | Already implemented; bring `decision-tracker.js` + `decision-formatter.js` formatting. |
| Story 3.x – semantic search | M1.1 + M1.4 | Copy embeddings + scoring stack verbatim. |
| Story 7.x – outcome tracking | M1.5 | Copy audit helpers. |
| Story 4.x‑6.x | M2.x / M3.x | Remain net-new (hook + UI work). |
| Story 8.x‑9.x | M4.x / M5.x | Remain net-new (tests, docs, desktop). |

👉 **Action item:** Update each story markdown under `docs/stories/` to reference the new owner column when that story is next touched (starting with Story 1.5).

---

## 6. Migration Workboard

1. **Archive rewrite artifacts**
   - Delete/park `mama-plugin/mcp-server/src/**` files that attempted to re-implement FR1‑FR7.
   - Tag the last commit for reference, then stop investing time into that branch.

2. **Mechanical copy**
   - Use `rsync`/`cp` from `mcp-server/src/mama/` → `mama-plugin/src/core/`.
   - Keep relative imports identical to simplify diff review.
   - Bring over the supporting tests simultaneously to preserve safety nets.

3. **Adaptation pass**
   - Replace PostgreSQL toggles with a single SQLite path.
   - Update package names/import paths (`@mama/core` placeholder).
   - Wire the plugin exports and update TypeScript config (if required).

Each step should include a short migration note appended to `docs/MAMA-CODE-REUSE-ANALYSIS.md` so we can track provenance.

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Partial rewrites linger and cause merge conflicts | High | Remove obsolete files now; enforce code owners on `mama-plugin/src/core`. |
| Regression caused by context differences (plugin vs MCP) | Medium | Run existing vitest suites after each migration chunk; add smoke tests invoking the plugin runtime. |
| Tier detection diverges between repos | Medium | Centralize tier logic inside `@mama/core/tier-detector` and consume from both plugin + desktop. |
| Docs drift from PRD | Medium | Keep this doc + PRD in the same PR; cross-link FR references (done in tables above). |

---

## 8. Immediate Next Steps

1. Move outstanding Story 1.5 work to **M1.3** and delete the inferior implementation under `mama-plugin/mcp-server/src/tools/`.
2. Prepare a mechanical migration PR: copy the modules listed in **M1.1** with zero functional edits, prove lint/tests pass.
3. Follow-up doc work: update `docs/stories/story-1.5.md` and related backlog files to reference the migration plan (will be tackled after this doc lands).

Once Epic M1 is complete we regain parity with the legacy MCP server, unlocking the hook/command/packaging work without duplicating effort.

--- 

_This document is now the canonical source for MAMA plugin epics. All future story discussions should reference the Epic IDs introduced here._
