# Release Process

제품 목적과 사용자 시나리오의 최상위 기준은 [INTENT.md](../../INTENT.md)다.
작업 후와 릴리즈 전에는 [의도 점검 기록](intent-checks.md)에 목적 부합 여부와 미해결 조건을
기록한다. 코드·테스트·설치 성공으로 사용자 시나리오의 실패를 덮거나 전체 목적을 완료로 선언하지 않는다.

**Status:** Active

This document describes the release-preparation checklist for the MAMA monorepo and the minimum verification required before version bumps, changelog updates, and publishing.

---

## Release Checklist

Run this checklist in order for every release candidate.

Before release preparation, establish product evidence for the change. A passing build, unit
suite, or delivery receipt does not by itself establish that the reported user problem improved.

1. Confirm branch scope
   - Ensure the branch is reviewable and the release note matches the actual diff
   - Separate foundation work from follow-up roadmap items

2. Align release-facing docs
   - Update [README](../../README.md)
   - Update [CHANGELOG](../../CHANGELOG.md)
   - Update operator/install docs when auth detection, setup flow, or CLI UX changed
   - Update roadmap/design docs for the affected release train
   - Remove or archive stale docs for deleted surfaces
   - Keep local-only planning artifacts out of release commits (`docs/superpowers/`, `.sisyphus/`)

3. Verify versions
   - Check package versions in workspace `package.json` files
   - Ensure docs and landing-page copy reflect the same versions
   - Run `pnpm sync-versions --check` after manual edits

4. Run verification
   - Complete the pre-release product evidence gate below
   - `pnpm test`
   - `pnpm build`
   - Any scoped smoke checks required by the changed area

5. Prepare release commit
   - Commit doc alignment, generated files, and code together when they describe the same release slice
   - Keep generated artifacts in sync with the committed source
   - Verify generated standalone artifacts such as `packages/standalone/src/agent/gateway-tools.md`

6. Publish
   - Bump versions intentionally
   - Push the release branch
   - Tag and publish the packages that are meant to ship

---

## Verification Commands

Use the full monorepo commands before publishing:

```bash
pnpm test
pnpm build
```

For release candidates that only touch a subset of the repo, scoped verification is acceptable
during iteration. The full commands above and the product evidence gate are required before release.

## Pre-release Product Evidence Gate

For behavior fixes, retain a reproduction that fails on the unchanged baseline for the reported
reason and passes on the candidate. Exercise the actual producers, consumers, and durable effects;
replace only external services or model decisions with controlled fixtures. List every omitted
boundary. A helper-only or prototype-constructed reproduction is discovery evidence, not proof
that the deployed input path is fixed.

For report judgment changes, freeze source snapshots, as-of times, expected material conflicts,
completion evidence, and owner-only decisions before changing guidance or storage. Evaluate the
baseline and candidate under the same model and evidence conditions. Compare minimal guidance
before introducing new persistent judgment structures. A scripted model that echoes instructions,
keyword presence, or successful transmission cannot substitute for a real judgment comparison.

For latency changes, preserve full request-to-delivery time and report queue, model, outbound, and
commit phases separately. Identify pre-existing active work and earlier owner requests; never hide
backlog by silently excluding it. Report the sample size, failures, and busy rejections. A single
fast run cannot establish a percentile objective.

An independent reviewer must inspect both the implementation and the fidelity of its reproduction
and evaluation. Record the candidate revision, fixture version, commands, outcomes, remaining gaps,
and reviewer disposition in a release evidence artifact. Missing user-path or judgment proof means
the candidate is not release-ready, even when the ordinary test suite passes.

Use isolated local fixtures and candidate runtimes for these checks. Do not modify operating tasks,
send synthetic production messages, or publish a release merely to obtain first proof. Post-release
checks confirm installation, environment differences, and regressions; they are not the first
evaluation of the promised behavior improvement.

---

## Documentation Gate

A release is not ready until these are true:

- README describes the shipped architecture and current frontdoor roles
- CHANGELOG contains an unreleased/release entry for the exact changes being shipped
- Roadmap docs distinguish shipped foundation work from next-branch architecture
- vNext default-rollout claims are backed by migration guidance and real local smoke evidence
- Deleted surfaces are no longer described as active features
- Local-only superpower planning/review docs are ignored unless intentionally promoted into public docs

---

## Versioning Notes

- `@jungjaehoon/mama-os` is the standalone runtime and viewer release driver
- `@jungjaehoon/mama-server`, `@jungjaehoon/mama-core`, and `mama-plugin` should only be bumped when their shipped package contents actually changed
- Keep the root changelog readable even when multiple workspace versions move together

---

## Suggested Release Flow

```bash
# 1. Align versions and generated doc references
pnpm sync-versions
pnpm sync-versions --check

# 2. Verify
pnpm test
pnpm build

# 3. Commit release-prep changes
git add <changed-release-files>
git commit -m "chore: prepare release notes and docs"

# 4. Push branch
git push origin <branch>

# 5. Publish/tag according to the package release plan
#    After the release-prep PR is merged, run the Release workflow on main with:
#    - packages: mama-core,mama-os (or the exact package set being shipped)
#    - bump_versions: false
#    - dry_run: false
```

The release workflow expects package versions to be prepared through a PR before publishing. Do not
use the workflow to push version bumps directly to `main`; branch protection requires those changes
to land through review first.

---

**Last Updated:** 2026-07-04
