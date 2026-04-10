# v0.18 Output Layer Design

> Spec for MAMA v0.18. See plans/ for implementation plan.

## Problem

v0.17 completed the input pipeline (13 connectors, 3-pass extraction, project intelligence graph). But there is no way to consume the extracted intelligence. The viewer dashboard shows system monitoring instead of project intelligence.

## Solution

Replace system monitoring dashboard with agent-driven output layer. Orchestrator agent generates dashboard content as HTML slots (Kagemusha pattern), delivers briefings via Telegram/iMessage.

## Architecture

- **Intelligence API** — /api/report, /api/briefing, /api/alerts, /api/activity, /api/projects
- **Report Slots** — HTML fragments in SQLite, SSE push to viewer
- **Viewer** — Collapsible sidebar, slot frame, no fixed tabs on Dashboard
- **Orchestrator** — Schedule + event + user-request triggers, LLM briefing generation
- **Security** — Connectors read-only, orchestrator 1:1 write only, gateway bots deprecated

## Design Constraints

- border-radius: 4px cards, 6px buttons. No bubbly radius.
- Lucide SVG icons, no emoji. mama-icon.svg logo.
- Fredoka headings, Nunito body. #F9F7F4 bg, #F5C518 yellow, #C4B5E0 lavender.
- No AI slop: no stat grids, no emoji design elements, no colored left-border cards.

## Implementation Order

1. Report Slots Infrastructure (DB + API + SSE)
2. Viewer UI Redesign (sidebar + slot frame)
3. Intelligence API (alerts/activity/projects)
4. Deterministic Report Builder
5. Orchestrator Engine (Plan 2)
6. Telegram/iMessage Output (Plan 2)
7. Connector Settings UX (Plan 3)
8. Gateway Bot Deprecation (Plan 3)
