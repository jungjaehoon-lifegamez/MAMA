# Telegram Owner State Isolation Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate private connector isolation, safe external lifecycle reconciliation, and
one-shot report carry; prove TG-01/TG-05/TG-06 and repository-wide release readiness before PR.

**Architecture:** Execute the three subsystem plans in dependency order, then update the parity
artifact with direct test evidence. Independent reviewers audit privacy/tool projection, lifecycle
authority, and Telegram delivery/session behavior. All focused, package-wide, and root gates must
pass from a clean worktree before PR creation.

**Tech Stack:** pnpm/Turbo, TypeScript, Vitest single-fork, Git/GitHub CLI, MAMA runtime CLI.

## Global Constraints

- Execute these plans in order:
  1. `docs/plans/2026-08-02-private-connector-isolation-implementation.md`
  2. `docs/plans/2026-08-02-external-lifecycle-reconciliation-implementation.md`
  3. `docs/plans/2026-08-02-report-carry-v2-implementation.md`
- Do not weaken tests, envelope scope, no-replay rules, or single-fork configuration to make a gate
  pass.
- Do not merge, release, install, or restart production until implementation review and PR review
  are clear.
- Preserve unrelated user changes and use only targeted staging.
- Every parity claim must cite a test or inspected runtime path, not tool-name similarity.
- Update the active goal only after every requirement has authoritative evidence.

---

### Task 1: Production-wiring contract gate

**Files:**

- Test: `packages/standalone/tests/cli/lane-wiring.test.ts`
- Test: `packages/standalone/tests/gateways/message-router.test.ts`
- Test: `packages/standalone/tests/gateways/message-router-turn-save.test.ts`
- Test: `packages/standalone/tests/gateways/telegram.test.ts`
- Test: `packages/standalone/tests/operator/operator-trigger-loop.test.ts`
- Test: `packages/standalone/tests/operator/external-lifecycle-reconcile.test.ts`
- Test: `packages/standalone/tests/operator/external-lifecycle-workorder-recovery.test.ts`

**Interfaces:**

- Consumes the real `start.ts` lane builders, `MessageRouter` + `SessionStore` +
  `FileReportCarryStore`, Telegram queue, and `TaskLedger` receipt APIs implemented by the three
  subsystem plans.
- Produces no fake aggregate fixture. The gate is the union of real runtime-boundary tests, so it
  cannot pass through a synthetic counter that bypasses production wiring.

- [ ] **Step 1: Verify the real production seams are covered**

```text
TG-01: telegram.test.ts proves same-chat FIFO and exact-ID transport ordering.
TG-05: message-router.test.ts proves persistence-before-ack; agent-loop.test.ts +
       codex-app-server-process.test.ts prove policy mismatch replaces the durable thread once and
       unchanged policy resumes minimally.
TG-06: lane-wiring.test.ts is policy/list coherence; operator-trigger-loop.test.ts drives the
       real reporter/pending/carry/output assemblies for scheduled and on-demand reports;
       lifecycle tests prove candidate receipt authority and no replay after ambiguous/partial effects.
```

- [ ] **Step 2: Run the real boundary suites together**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/cli/lane-wiring.test.ts \
  tests/gateways/message-router.test.ts \
  tests/gateways/message-router-turn-save.test.ts \
  tests/gateways/telegram.test.ts \
  tests/operator/operator-trigger-loop.test.ts \
  tests/agent/agent-loop.test.ts \
  tests/agent/codex-app-server-process.test.ts \
  tests/operator/external-lifecycle-reconcile.test.ts \
  tests/operator/external-lifecycle-workorder-recovery.test.ts
```

Expected: PASS after all subsystem plans are implemented. A failure must be fixed in the owning
subsystem with a focused failing test before this combined gate is rerun.

- [ ] **Step 3: Commit only genuine integration fixes**

```bash
git status --short
```

If the combined gate exposes a source defect, stage the exact source and regression-test paths and
commit them under the owning subsystem. If it exposes no defect, make no empty integration commit.

### Task 2: Prepare the parity evidence map

**Files:**

- Modify: `docs/development/kagemusha-telegram-parity.md`

- [ ] **Step 1: Re-read the complete parity artifact and update TG-01 evidence**

Record that the existing same-chat FIFO/external-report ordering remains unchanged, the delivered
report writes only a target-scoped carry, and the Telegram regression retains the exact TG-06
delivery ID.

- [ ] **Step 2: Update TG-05 evidence**

Record that private policy changes rotate the session fingerprint; normal continuation still uses
the existing backend session; carry enters only the per-turn user path and is acknowledged after
final assistant-session persistence.

- [ ] **Step 3: Update TG-06 evidence**

Record pending provenance across restart, exact text/ID replay, same-ID carry idempotency,
success-only schedule advancement, scheduled/on-demand capability parity, and receipt-authoritative
unknown-mutation no-replay.

- [ ] **Step 4: Prepare the dated change log and exact test paths**

List the new/updated tests from each subsystem, but do not write final command results or mark a
scenario verified yet. Keep this evidence map in the task handoff until Tasks 3 and 4 below are
clear.

- [ ] **Step 5: Defer the artifact mutation until final gates pass**

```text
No git mutation in this task. Task 5 writes and commits the authoritative evidence after review,
static checks, package tests, root tests, and builds have all passed in the current worktree.
```

### Task 3: Independent subagent review gates

**Files:**

- Review only; fixes use the exact affected files.

- [ ] **Step 1: Dispatch privacy and capability review**

Ask a fresh reviewer to compare the implementation against the private connector plan and inspect
fresh/configured/disabled states, wildcard blocks, API discovery, prompt catalogs, user-owned brief
projection, envelope scope, and TG-05 fingerprint rotation.

- [ ] **Step 2: Dispatch lifecycle security/integrity review**

Ask a fresh reviewer to inspect immutable snapshots, binding authority, generic-update bypass,
transaction boundaries, temporal/effect invariants, complete/partial/zero arbitration, ambiguous
no-replay, and stale-claim recovery.

- [ ] **Step 3: Dispatch TG/report review**

Ask a fresh reviewer to trace pending full report from composition through restart replay, Telegram
send, same-ID carry persist, exact-chat peek, final-session ack, and next turn.

- [ ] **Step 4: Resolve every actionable finding with a failing regression test first**

For each finding: reproduce in the narrowest test, confirm failure, patch, rerun the focused suite,
then request re-review. Do not dismiss a finding without code evidence.

- [ ] **Step 5: Require all three reviewers to return clear**

Store reviewer summaries in the task handoff; do not create source files solely for review output.

### Task 4: Full verification matrix

**Files:**

- Verification only.

- [ ] **Step 1: Run formatting and static checks**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run focused mama-core migration/event tests**

```bash
pnpm --dir packages/mama-core exec vitest run \
  tests/connectors/operator-ingest-seq-update.test.ts \
  tests/cases/migration-chain.test.ts \
  tests/cases/migration-runner-duplicate-column.test.ts \
  tests/connectors/raw-provenance.test.ts
pnpm --dir packages/mama-core typecheck
```

- [ ] **Step 3: Run all focused standalone state-isolation tests**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/connectors/private-connector-policy.test.ts \
  tests/connectors/config-loader.test.ts \
  tests/cli/connector-command.test.ts \
  tests/api/private-connector-api.test.ts \
  tests/cli/runtime/envelope-bootstrap.test.ts \
  tests/gateways/tool-ad-coherence.test.ts \
  tests/gateways/message-router.test.ts \
  tests/gateways/message-router-turn-save.test.ts \
  tests/gateways/telegram.test.ts \
  tests/envelope/reactive-config.test.ts \
  tests/envelope/tool-connector-scope.test.ts \
  tests/envelope/enforcer.test.ts \
  tests/agent/gateway-tool-catalog.test.ts \
  tests/agent/gateway-tools-generation.test.ts \
  tests/agent/gateway-tool-executor.test.ts \
  tests/agent/agent-loop.test.ts \
  tests/agent/codex-app-server-process.test.ts \
  tests/code-act/tool-policy.test.ts \
  tests/multi-agent/per-agent-tool-filtering.test.ts \
  tests/operator/external-lifecycle.test.ts \
  tests/operator/external-lifecycle-binding-migration.test.ts \
  tests/operator/external-lifecycle-reconcile.test.ts \
  tests/operator/external-lifecycle-workorder-recovery.test.ts \
  tests/operator/workorder-publishers.test.ts \
  tests/operator/workorder-consumer.test.ts \
  tests/operator/task-ledger-effects.test.ts \
  tests/operator/temporal-generations.test.ts \
  tests/operator/report-carry.test.ts \
  tests/operator/situation-report.test.ts \
  tests/operator/pending-report-store.test.ts \
  tests/operator/operator-trigger-loop.test.ts
```

- [ ] **Step 4: Run package and repository gates**

```bash
pnpm --dir packages/standalone test
pnpm --dir packages/standalone build
pnpm test
pnpm build
git diff --exit-code -- packages/standalone/src/agent/gateway-tools.md
```

Expected: all exit 0. If a command fails, apply one cause→fix→reverify loop before reporting.

- [ ] **Step 5: Verify a clean, bounded diff**

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: only planned code/tests/docs, no secrets, runtime DBs, `.superpowers/`, or unrelated files.

### Task 5: PR, code review, merge, release, install, and monitoring

**Files:**

- Release metadata only if the repository's release process requires it after review.

- [ ] **Step 1: Finalize and commit authoritative parity evidence**

Re-read the full parity artifact after all three reviewer gates and Task 4 verification commands
are clear. Apply the Task 2 evidence map, record the actual current-worktree command results, and
mark only directly proven TG-01/TG-05/TG-06 rows verified.

```bash
git add docs/development/kagemusha-telegram-parity.md
git commit -m "docs(standalone): update Telegram parity evidence"
```

- [ ] **Step 2: Push the implementation branch and open a ready PR**

```bash
git push -u origin codex/telegram-owner-state-isolation
gh pr create --fill --base main --head codex/telegram-owner-state-isolation
```

The PR body must summarize the three independent causes/fixes and list TG-01/TG-05/TG-06 plus all
verification commands.

- [ ] **Step 3: Monitor CI and external code review**

```bash
gh pr checks --watch
gh pr view --comments
```

Classify each comment against current code. Reproduce actionable issues with tests, patch, rerun the
affected and full gates, push, and wait for clear checks.

- [ ] **Step 4: Merge only after required checks and reviews are clear**

Use the repository's existing merge method. Confirm the merged commit is on `origin/main`; never
force push or bypass protection.

- [ ] **Step 5: Follow the repository release procedure and verify the published version**

Inspect current release scripts/tags before mutation. Build artifacts from the merged commit, publish
only the package(s) changed by the approved release, and verify registry/tag state. Do not infer a
release command from old conversation history.

- [ ] **Step 6: Install the released build and restart MAMA**

Use the existing documented install and `mama stop`/`mama start start` workflow. Confirm
`pnpm start status` or the current authoritative status command reports Running.

- [ ] **Step 7: Monitor Telegram owner behavior and logs**

Verify with real conversation content, not only transport logs:

- a fresh follow-up turn does not repeat the prior full-report prefix;
- the intended chat can reference a newly delivered report once;
- another chat cannot see or consume it;
- configured Kagemusha owner queries still work while generic surfaces omit it;
- a structured lifecycle delta produces a binding/lifecycle receipt before native status changes;
- no partial/ambiguous candidate attempt replays automatically.

- [ ] **Step 8: Complete the active goal only after the completion audit**

Map every objective requirement to current code, passing tests, PR/merge/release state, installed
runtime, and observed Telegram evidence. If any evidence is missing or indirect, keep the goal active
and continue rather than marking it complete.
