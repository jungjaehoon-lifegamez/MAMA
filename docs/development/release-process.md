# Release Process

**Status:** Active

This document describes the release-preparation checklist for the MAMA monorepo and the minimum verification required before version bumps, changelog updates, and publishing.

---

## Release Checklist

Run this checklist in order for every release candidate.

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

4. Run verification
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

For release candidates that only touch a subset of the repo, scoped verification is acceptable during iteration, but the full commands above are the release gate.

---

## Documentation Gate

A release is not ready until these are true:

- README describes the shipped architecture and current frontdoor roles
- CHANGELOG contains an unreleased/release entry for the exact changes being shipped
- Roadmap docs distinguish shipped foundation work from next-branch architecture
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
# 1. Verify
pnpm test
pnpm build

# 2. Commit release-prep changes
git add .
git commit -m "chore: prepare release notes and docs"

# 3. Push branch
git push origin <branch>

# 4. Bump versions intentionally
pnpm -r exec npm version <patch|minor|major>

# 5. Publish/tag according to the package release plan
```

---

**Last Updated:** 2026-04-12
