# vNext Release Readiness Guide

MAMA vNext is the primary-operator rebuild. It keeps durable writes behind one reviewed commit
authority instead of letting dashboard, wiki, memory, connector, and gateway agents write state from
separate loops.

This guide records the release decision and the remaining checkpoint before vNext can move from
opt-in to default.

## Current Decision

vNext remains opt-in after PR #115.

The synthetic dogfood harness and operator cockpit exercise the reviewed path with synthetic
connector data. They do not prove that existing users can migrate safely, or that a real local smoke
run can be documented without leaking private connector content.

Default rollout waits on:

- migration guidance for enabling, verifying, and rolling back vNext
- real local smoke evidence using redacted or synthetic-visible outputs only
- public-project privacy checks before every release-readiness PR
- documentation consistency across README, setup, gateway, release, and architecture docs

## Release Checkpoint

Release readiness is achieved only when the vNext-specific gates below and the standard release
verification in [Release Process](../development/release-process.md) are true.

| Gate                      | Status      | Evidence required                                                                 |
| ------------------------- | ----------- | --------------------------------------------------------------------------------- |
| PR #115 merged            | Done        | GitHub PR #115 merged into `main`                                                 |
| vNext opt-in documented   | In progress | README, setup guide, gateway guide, architecture plan, changelog                  |
| Migration path documented | Done        | See [Migration Path](#migration-path): enable flags, smoke-test, return to legacy |
| Real local smoke evidence | Pending     | Redacted command output or synthetic-equivalent transcript with no private data   |
| Privacy scans             | Per PR      | `./scripts/check-pii.sh --base origin/main`, `./scripts/check-pr-gitleaks.sh`     |
| Dogfood gate              | Pending     | `MAMA_FORCE_TIER_3=true pnpm --filter @jungjaehoon/mama-os dogfood:vnext`         |
| Release verification      | Pending     | `pnpm test`, `pnpm build`, plus any scoped smoke checks from the release process  |
| Review gate               | Pending     | Code review before PR, after PR comments, and before the next branch              |

## Migration Path

vNext is opt-in. The runtime resolves to `legacy` mode unless a flag turns it on, so enabling and
reverting are both non-destructive. Precedence is env `MAMA_VNEXT_RUNTIME` > config > default
(`legacy`), implemented in `packages/standalone/src/runtime-vnext/feature-flags.ts`.

### Enable

```bash
export MAMA_VNEXT_RUNTIME=1   # accepted: 1 / true / yes / on / bootstrap / vnext
```

Or, in the MAMA config, set `runtime.vnext: true` (equivalently `runtime_vnext.enabled: true`).
With no flag set, the runtime resolves to `legacy`.

Related opt-in flags (all default off):

- Implicit memory recall on ordinary turns: `MAMA_MEMORY_POLICY_IMPLICIT_RECALL`,
  `MAMA_MEMORY_POLICY_IMPLICIT_LEGACY_CONTEXT_SEARCH`
- Connector ingress under review: `MAMA_VNEXT_INGRESS_CONNECTOR`, `MAMA_VNEXT_INGRESS_CHANNEL`,
  `MAMA_VNEXT_SYNTHETIC`

### Verify

Run the [Smoke Checklist](#smoke-checklist) below. The synthetic dogfood gate exercises the preview,
commit, projection, and recall paths without real connector data.

### Return to legacy

Unset `MAMA_VNEXT_RUNTIME` (or set `0` / `false` / `off` / `legacy`), or set `runtime.vnext: false`.
Because the default is `legacy`, removing the flag reverts. The legacy runtime is preserved, not
deleted (architecture invariant), so rollback needs no data migration.

## Smoke Checklist

Run the smoke checklist on an opt-in local config. Do not use real connector payloads in committed
fixtures, screenshots, logs, or docs.

1. Start from a clean branch based on `origin/main`.
2. Confirm legacy mode still starts without enabling vNext.
3. Enable vNext only in the local config under review.
4. Run the synthetic dogfood gate:

   ```bash
   MAMA_FORCE_TIER_3=true pnpm --filter @jungjaehoon/mama-os dogfood:vnext
   ```

5. Run one local operator cockpit smoke pass using synthetic or redacted connector data.
6. Verify ordinary gateway turns do not inject implicit recall or legacy context search by default.
7. Verify explicit `mama_recall` can recall reviewed memory.
8. Capture only safe evidence:
   - command names and pass/fail summaries
   - synthetic connector/channel names
   - redacted timestamps if needed
   - no message bodies from private sources
   - no local absolute paths
   - no memory ids from a real user database

## Rollback Rule

Until vNext becomes default, rollback is simple: leave vNext disabled and keep using the legacy
runtime. Release docs must preserve that path.

Do not delete or hide legacy runtime setup steps before migration docs and real smoke evidence are
merged.

## Public-Project Privacy Rule

Before committing release-readiness changes, scan the staged diff:

```bash
git diff --cached --check
./scripts/check-pii.sh
gitleaks protect --source . --staged --redact --verbose --no-banner
```

Before opening a release-readiness PR, after responding to review comments, and before starting the
next branch, scan the full branch diff against `main`:

```bash
git diff origin/main...HEAD --check
./scripts/check-pii.sh --base origin/main
./scripts/check-pr-gitleaks.sh
```

These scans are gates, not a substitute for reading the diff. Review added docs and fixtures for
tokens, local paths, channel IDs, customer names, raw connector payloads, and internal project
details.
