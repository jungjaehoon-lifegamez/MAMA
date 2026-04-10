# v0.18 Report Slots + Viewer UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the system monitoring dashboard with an agent-driven report slots frame (Kagemusha pattern) and collapsible sidebar navigation.

**Architecture:** Report slots are HTML fragments stored in SQLite, served via REST, and pushed to the browser via SSE. The viewer is a thin frame that renders slots sorted by priority. No fixed tabs or sub-tabs on Dashboard.

**Tech Stack:** TypeScript, Express (existing), node:sqlite (existing), SSE, ES modules (no bundler), Lucide icons, Fredoka/Nunito fonts (existing).

**Reference:** Kagemusha implementation at `/Users/jeongjaehun/project/mama-suite/apps/kagemusha/src/http/routes/report.ts` and `src/runtime/report-builder.ts`.

---

## File Structure

```
packages/standalone/
├── src/
│   ├── api/
│   │   ├── report-handler.ts        (NEW — ReportStore + routes + SSE)
│   │   ├── intelligence-handler.ts   (NEW — /api/briefing, /api/alerts, /api/activity, /api/projects)
│   │   └── index.ts                  (MODIFY — register new routers)
│   └── report/
│       └── deterministic-builder.ts  (NEW — HTML slot builder, pure function)
├── public/viewer/
│   ├── viewer.html                   (MODIFY — sidebar nav, slot frame, mobile tab bar)
│   ├── src/modules/
│   │   ├── dashboard.ts              (REWRITE — slot renderer + SSE client)
│   │   ├── projects.ts               (NEW — projects tab)
│   │   └── settings.ts               (MODIFY — reorganize into Connectors/Agents/System)
│   └── src/utils/
│       └── api.ts                    (MODIFY — add report/intelligence API types)
└── tests/
    ├── api/
    │   ├── report-handler.test.ts    (NEW)
    │   └── intelligence-handler.test.ts (NEW)
    └── report/
        └── deterministic-builder.test.ts (NEW)
```

---

### Task 1: Report Slots DB + Store

**Files:**

- Create: `packages/standalone/src/api/report-handler.ts`
- Test: `packages/standalone/tests/api/report-handler.test.ts`

- [ ] Write ReportStore interface and in-memory implementation (ReportSlot type with slotId, html, priority, updatedAt; methods: get, update, delete, getAll, getAllSorted)
- [ ] Write tests: empty store returns {}, store/retrieve slot, upsert existing, getAllSorted by priority, delete
- [ ] Run tests, verify pass
- [ ] Commit: "feat(v0.18): add ReportStore with in-memory backend"

---

### Task 2: Report API Routes + SSE

**Files:**

- Modify: `packages/standalone/src/api/report-handler.ts`
- Modify: `packages/standalone/src/api/index.ts`
- Test: `packages/standalone/tests/api/report-handler.test.ts`

- [ ] Add broadcastReportUpdate function (writes SSE payload to Set of ServerResponse clients)
- [ ] Add createReportRouter: GET / (all slots), GET /events (SSE stream), PUT / (bulk update), PUT /slots/:id (single), DELETE /slots/:id
- [ ] Register router in index.ts: app.use('/api/report', reportRouter)
- [ ] Add SSE broadcast test
- [ ] Run tests, verify pass
- [ ] Commit: "feat(v0.18): add report slots API with SSE broadcast"

---

### Task 3: Intelligence API — Alerts, Activity, Projects

**Files:**

- Create: `packages/standalone/src/api/intelligence-handler.ts`
- Modify: `packages/standalone/src/api/index.ts`
- Test: `packages/standalone/tests/api/intelligence-handler.test.ts`

- [ ] Implement buildAlertsFromDecisions: flag stale (>14d no update) and low confidence (<0.4) active decisions
- [ ] Implement buildActivityFeed: sort by timestamp desc, cross-project
- [ ] Implement buildProjectsSummary: group by project scope, sort by lastActivity
- [ ] Create Express router: GET /api/intelligence/alerts, /activity, /projects — query mama-memory.db decisions/scopes tables
- [ ] Register in index.ts
- [ ] Write tests for pure functions
- [ ] Run tests, verify pass
- [ ] Commit: "feat(v0.18): add Intelligence API — alerts, activity, projects"

---

### Task 4: Deterministic Report Builder

**Files:**

- Create: `packages/standalone/src/report/deterministic-builder.ts`
- Test: `packages/standalone/tests/report/deterministic-builder.test.ts`

- [ ] Implement buildDeterministicReport(input) → { slots: Record<string, {html, priority}>, text: string }
- [ ] Four slot builders: buildBriefingSlot (date + project summaries), buildAlertsSlot (attention items, empty if none), buildActivitySlot (recent decisions timeline), buildPipelineSlot (project table + connector status)
- [ ] Plain text export for Telegram (no HTML tags)
- [ ] Tests: returns 4 slots, briefing contains project names, alerts empty when no alerts, text has no HTML
- [ ] Run tests, verify pass
- [ ] Commit: "feat(v0.18): add deterministic report builder — 4 slots with plain text"

---

### Task 5: Viewer HTML — Sidebar + Slot Frame + Mobile Tab Bar

**Files:**

- Modify: `packages/standalone/public/viewer/viewer.html`

- [ ] Replace top navigation bar with collapsible sidebar: 56px collapsed, 200px on hover, 4 items (Dashboard/Memory/Projects/Settings) using inline Lucide SVGs, mama-icon.svg logo
- [ ] Replace dashboard tab content with slot container: `<div id="dashboard-slots">` with empty state message
- [ ] Add mobile bottom tab bar (hidden on desktop, shown below 768px) with safe-area-inset
- [ ] Add sidebar CSS: transition, hover expand, active indicator (yellow bar), nav items
- [ ] Follow design constraints: 4px radius, no emoji, Lucide icons, cream bg #F9F7F4
- [ ] Build viewer: `pnpm build:viewer`
- [ ] Commit: "feat(v0.18): replace top nav with collapsible sidebar + mobile tab bar"

---

### Task 6: Dashboard Module — Slot Renderer + SSE Client

**Files:**

- Rewrite: `packages/standalone/public/viewer/src/modules/dashboard.ts`
- Modify: `packages/standalone/public/viewer/src/utils/api.ts`

- [ ] Add ReportSlot type and API.getReportSlots() to api.ts
- [ ] Rewrite DashboardModule: init() fetches slots from /api/report, renders sorted by priority into #dashboard-slots
- [ ] Connect SSE at /api/report/events, handle report-update event (single slot, batch, delete)
- [ ] Sanitize slot HTML via DOMPurify before innerHTML
- [ ] Show/hide empty state based on slot count
- [ ] Build viewer: `pnpm build:viewer`
- [ ] Manual test: curl PUT a slot, verify it renders in browser
- [ ] Commit: "feat(v0.18): rewrite dashboard as slot renderer with SSE live updates"

---

### Task 7: Settings Reorganization

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/settings.ts`
- Modify: `packages/standalone/public/viewer/viewer.html`

- [ ] Restructure Settings HTML into 3 collapsible sections: Connectors, Agents, System
- [ ] Move health check, token usage, cron displays from old dashboard into System section
- [ ] Connector section: list with enable/disable toggle (uses existing /api/connectors/status and /:name/toggle)
- [ ] Build viewer: `pnpm build:viewer`
- [ ] Commit: "refactor(v0.18): reorganize Settings into Connectors/Agents/System"

---

### Task 8: Integration Test + Build Verification

- [ ] Run full test suite: `pnpm test` — all tests pass
- [ ] Run build: `pnpm build` — no errors
- [ ] Run typecheck: `pnpm typecheck` — no errors
- [ ] Manual smoke test: sidebar nav works, empty dashboard renders, curl slot appears, Settings 3 sections, mobile bottom tabs
- [ ] Commit fixes if any: "fix(v0.18): integration fixes from smoke test"
