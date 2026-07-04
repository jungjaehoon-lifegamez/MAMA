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

| Gate                      | Status      | Evidence required                                                                |
| ------------------------- | ----------- | -------------------------------------------------------------------------------- |
| PR #115 merged            | Done        | GitHub PR #115 merged into `main`                                                |
| vNext opt-in documented   | In progress | README, setup guide, gateway guide, architecture plan, changelog                 |
| Migration path documented | Pending     | Steps to enable vNext, run smoke checks, and return to legacy mode               |
| Real local smoke evidence | Pending     | Redacted command output or synthetic-equivalent transcript with no private data  |
| Privacy scans             | Per PR      | `./scripts/check-pii.sh --base origin/main`, `./scripts/check-pr-gitleaks.sh`    |
| Dogfood gate              | Pending     | `MAMA_FORCE_TIER_3=true pnpm --filter @jungjaehoon/mama-os dogfood:vnext`        |
| Release verification      | Pending     | `pnpm test`, `pnpm build`, plus any scoped smoke checks from the release process |
| Review gate               | Pending     | Code review before PR, after PR comments, and before the next branch             |

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
