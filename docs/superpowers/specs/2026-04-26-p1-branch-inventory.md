# P1 Branch Inventory

작성일: 2026-04-27
작성 브랜치: `codex/p1-runtime-contract-impl`
기준 HEAD: `44b2fc86`

근거: P1 M0/M1 runtime contract v6 preflight. 목적은 최근 브랜치가
`gateway-tool-executor.ts`, `message-router.ts`, `delegation-manager.ts`,
`db/migrations/`, case/task-board, connector ingest 경로를 건드리는지 확인하고,
P1에 좁게 가져올지 또는 후속 phase로 미룰지 결정하는 것이다.

## Branches Checked

명령:

```bash
git branch -a --sort=-committerdate | head -20
for B in codex/provenance-drawer-mainbase codex/work-item-identity codex/post-release-followup claude/nice-cray claude/stupefied-goldwasser; do
  git rev-list --left-right --count HEAD...$B
  git diff --name-status HEAD..$B -- \
    packages/standalone/src/agent/gateway-tool-executor.ts \
    packages/standalone/src/gateways/message-router.ts \
    packages/standalone/src/agent/delegation-manager.ts \
    packages/standalone/src/db/migrations \
    packages/standalone/src/memory \
    packages/standalone/src/api/case-board-router.ts \
    packages/standalone/src/api/case-task-board-router.ts \
    packages/mama-core/src/cases
done
```

| Branch | Ahead/behind vs P1 HEAD | Touches executor/router/delegation/migrations? | Cherry-pick into P1? | Defer to which P? |
|---|---:|---|---|---|
| `codex/provenance-drawer-mainbase` | `0 61` | Yes: `gateway-tool-executor.ts`, `message-router.ts`, new case-board routers, `connector-case-ingest.ts`, many `mama-core/src/cases/*` files | No wholesale cherry-pick | P2 provenance, P4 situation/command-center, P5+ connector ingest integration |
| `codex/work-item-identity` | `0 24` | Yes: `gateway-tool-executor.ts`, new case-board routers, `connector-case-ingest.ts`, case/task projection files | No wholesale cherry-pick | P4 entity/work-item identity, P5+ connector ingest integration |
| `codex/post-release-followup` | `0 0` | No diff from P1 HEAD | No | Not applicable |
| `claude/nice-cray` | `496 481` | Divergent/stale relative to current base; deletes many case files | No | Ignore for P1; investigate only if explicitly rebasing legacy work |
| `claude/stupefied-goldwasser` | `496 482` | Divergent/stale; touches executor/router and deletes migrations/case files | No | Ignore for P1; investigate only if explicitly rebasing legacy work |

## Conflict Watch

Files from this plan that overlap with recent valid branches:

```text
packages/standalone/src/agent/gateway-tool-executor.ts
packages/standalone/src/gateways/message-router.ts
packages/standalone/src/api/case-board-router.ts
packages/standalone/src/api/case-task-board-router.ts
packages/standalone/src/memory/connector-case-ingest.ts
packages/standalone/src/memory/history-extractor.ts
packages/standalone/src/memory/memory-agent-dashboard.ts
packages/standalone/src/memory/save-candidate-extractor.ts
packages/standalone/src/memory/save-candidate-types.ts
packages/mama-core/src/cases/*
```

`packages/standalone/src/agent/delegation-manager.ts` was not touched by the checked
recent branches in the filtered diff.

## Decision

Proceed with P1 on current HEAD. Do not wholesale cherry-pick
`codex/provenance-drawer-mainbase` or `codex/work-item-identity`.

Rationale:

- Both branches are recent and relevant, but they introduce broad case-board,
  provenance, work-item, and connector-ingest surfaces beyond P1 M0/M1.
- P1 must establish the runtime contract first: raw ingest isolation, envelope
  creation/signing/persistence, scope/destination enforcement, and visible
  missing-envelope warnings.
- If either recent branch lands before P1 completes, rerun Task 1 audit and
  apply the M0 kill switch to `connector-case-ingest.ts` before exposing raw
  connector ingestion to runtime flows.

## Task 0 Status

Task 0 is complete for this implementation branch. The next step is Task 1:
enumerate current HEAD auto-create paths and record absent recent-branch paths
as integration risks rather than importing them.
