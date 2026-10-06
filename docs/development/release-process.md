---
title: Release process
parent: Development
nav_order: 6
---

# Release process

Establish the promised owner result before publishing. Builds, test counts, package installation
and delivery receipts support that evidence; they do not establish it alone. Use
[the intent workflow](intent-workflow.md) and record remaining failures in
[the check log](checks.md).

## Prepare the candidate

1. Match the release scope to the reviewed diff. Separate implemented behaviour from follow-up work.
2. Update the affected setup, guide, reference and explanation pages, package READMEs and changelog.
   Remove claims and links for deleted surfaces. Keep `docs/superpowers/` out of commits.
3. Choose versions for packages whose shipped contents changed. Check every manifest and any
   version-bearing documentation. `pnpm sync-versions --check` checks only the files its script covers;
   it is not a full documentation audit.
4. Keep `packages/claude-code-plugin/package.json` and its `.claude-plugin/plugin.json` at the same
   version. The plugin manifest test enforces this, along with marketplace manifest consistency.
5. Run the checks below and review their actual output.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm sync-versions --check
git diff --check
```

Run the plugin manifest check from `packages/claude-code-plugin`:

```bash
pnpm exec vitest run tests/manifests/plugin-manifests.test.js
```

## Keep product evidence faithful

A behaviour fix needs a reproduction that fails on the unchanged baseline for the reported reason
and succeeds on the candidate. Exercise the producers, consumers and durable effects. If a fixture
replaces an external service or model decision, name the omitted boundary. A helper-only test does
not prove the deployed input path.

For report or learning changes, freeze source snapshots, as-of time, material conflicts and expected
completion evidence. Compare baseline and candidate with the same model and effort. Judge factual
quality, preserved scope and actual correction on the next related request. An echoing scripted model,
a keyword check or successful transmission is not a judgment comparison.

For latency work, retain request-to-delivery time and separate queue, model, outbound and commit
phases. Record sample size, failures and busy rejections. Include existing backlog; do not select one
fast run as a percentile result. Have an independent reviewer inspect the change and the fidelity of
its evidence. Record candidate revision, fixture version, commands, outcomes and remaining gaps.

Use isolated fixtures and candidate runtimes for first proof. Post-release checks establish installed
behaviour and environment differences; they should not be the first evaluation of the promised fix.

## Review privacy and the commit

Scan the working tree, every added line and commit message on the release branch, and the PR body
for private names, business content, identifiers, addresses and credentials. Include every added
line and commit message in the branch history, plus the PR body. Remove findings, rewrite a commit
if it contains private material, and repeat the scan until clean. Check links for deleted files and
check new claims against the current code. Wait for the owner's go-ahead before pushing or opening
the PR.

Stage named files. Pass the commit message through `git commit -F <message-file>` and inspect
`git log` before reporting the commit. Do not add local planning folders through blanket staging.

## Publish dependencies in order

The [Release workflow](../../.github/workflows/release.yml) accepts a comma-separated package set,
`dry_run`, `bump_versions` and `release_type`. Prepare version changes in a PR; after it merges,
run the workflow on `main` with `bump_versions=false`. Inline bumps on protected `main` are rejected.
Use `dry_run=true` to inspect version resolution without publishing; it does not replace validation.

**If core changed, include and publish `mama-core` first.** The server and MAMA OS publication jobs
wait for core. They may also run when core publication is skipped, so selecting the correct package
set remains the releaser's responsibility. Their published dependencies use the chosen core version.

The release tag is derived from the MAMA OS version. Check that it is intentional and unused even
when releasing a different package. Plugin synchronization depends on server publication; review
that job dependency when selecting a plugin release. The workflow also deploys the documentation
site and creates the release after the required jobs succeed.

Finally, verify the installed package versions and the affected owner or development-memory path.
Record live delivery and read-back evidence separately from the publication job result.
