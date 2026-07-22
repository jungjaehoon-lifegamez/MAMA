# MAMA Deployment Guide

This document describes the deployment workflow, version management policy, and package-specific deployment strategies.

---

## Overview

MAMA is a pnpm workspace-based monorepo with four release targets (plus the internal
`memorybench` package):

| Package            | Location                       | Deployment Target  | npm Name                   | Version |
| ------------------ | ------------------------------ | ------------------ | -------------------------- | ------- |
| MAMA OS            | `packages/standalone/`         | npm registry       | `@jungjaehoon/mama-os`     | 0.27.3  |
| MCP Server         | `packages/mcp-server/`         | npm registry       | `@jungjaehoon/mama-server` | 1.14.0  |
| MAMA Core          | `packages/mama-core/`          | npm registry       | `@jungjaehoon/mama-core`   | 1.9.0   |
| Claude Code Plugin | `packages/claude-code-plugin/` | Claude Marketplace | `mama`                     | 1.10.0  |

---

## Prerequisites

- **Node.js**: >= 22.13.0
- **pnpm**: >= 8.0.0
- **npm account**: For MCP server deployment (npm publish permissions)
- **Claude Marketplace account**: For plugin deployment
- **Cloudflare Access / Tunnel setup**: Recommended if exposing MAMA OS beyond localhost

---

## Pre-Deployment Checklist

Verify the following items before deployment:

```markdown
- [ ] All tests passing (`pnpm test`)
- [ ] Lint/type checks passing (`pnpm typecheck`)
- [ ] Version updates complete (see "Version Management" section)
- [ ] CHANGELOG.md updated (summarize changes)
- [ ] README.md current (reflect new features/commands)
- [ ] Environment variables documented (.env.example updated)
- [ ] Backward compatibility with existing decision data confirmed
- [ ] If using Cloudflare Zero Trust, `MAMA_TRUST_CLOUDFLARE_ACCESS=true` is set in the runtime environment
```

---

## Version Management Policy

### Semantic Versioning

MAMA follows [Semantic Versioning 2.0.0](https://semver.org/):

- **MAJOR** (X.0.0): Backward-incompatible API changes
- **MINOR** (0.X.0): Backward-compatible new features
- **PATCH** (0.0.X): Backward-compatible bug fixes

### Version Update Locations

Synchronize versions across these files before deployment:

| File                                                     | Field     | Current Version |
| -------------------------------------------------------- | --------- | --------------- |
| `packages/standalone/package.json`                       | `version` | 0.27.3          |
| `packages/mcp-server/package.json`                       | `version` | 1.14.0          |
| `packages/mama-core/package.json`                        | `version` | 1.9.0           |
| `packages/claude-code-plugin/package.json`               | `version` | 1.10.0          |
| `packages/claude-code-plugin/.claude-plugin/plugin.json` | `version` | 1.10.0          |

### Version Update Example

```bash
# For v1.1.0 release
# packages/mcp-server/package.json
"version": "1.1.0"

# packages/claude-code-plugin/.claude-plugin/plugin.json
"version": "1.1.0"

# packages/claude-code-plugin/package.json
"version": "1.1.0"
```

### Git Tag Rules

- Tag format: `v{MAJOR}.{MINOR}.{PATCH}` (e.g., `v1.1.0`)
- Tags created only on main branch
- Include release notes (recommended)

---

## Deployment Workflow

### Step 1: Install Dependencies and Build

```bash
# Run from project root
pnpm install

# Build (if needed)
pnpm build
```

### Step 2: Run Tests

```bash
# Run all tests
pnpm test

# Stop deployment if tests fail!
# All tests must pass
```

### Step 3: Update Versions

Update all package.json and plugin.json versions per the "Version Management Policy" section above.

### Step 4: Update CHANGELOG

Record changes in `CHANGELOG.md`:

```markdown
## [1.1.0] - 2026-02-13

### Added

- Link governance (LLM proposal + user approval)
- Narrative preservation (evidence, alternatives, risks)
- Quality metrics and restart monitoring

### Changed

- Auto-link policy deprecated (v0 legacy)
- Enhanced token masking

### Fixed

- Embedding memory leak fix
```

### Step 5: Run the Release Workflow

```bash
# Versions must already be committed on protected main.
gh workflow run release.yml --ref main \
  -f release_type=minor \
  -f packages=mama-os \
  -f dry_run=false \
  -f bump_versions=false

# Follow the dispatched run through tag, npm, Pages, and GitHub Release creation.
gh run list --workflow release.yml --limit 1
```

The workflow publishes every selected package, including `@jungjaehoon/mama-os`. Use a
comma-separated package list such as `mama-core,mama-server,mama-os,mama-plugin`, or `all`, when a
release spans more than MAMA OS. Do not request an inline version bump on protected `main`.

### Step 6: Verify npm Artifacts

```bash
npm info @jungjaehoon/mama-os version
npm info @jungjaehoon/mama-server version
```

For a MAMA OS release, install the exact published version, restart the local daemon, and verify
both the process and HTTP health before enabling a new opt-in runtime:

```bash
npm install -g @jungjaehoon/mama-os@0.27.1
mama stop
mama start
mama status
curl -fsS http://127.0.0.1:3847/health
```

If the host already runs MAMA through a `KeepAlive` launch agent, restart through that supervisor
only. Do not run `mama start` in parallel with the supervisor restart: both processes can pass the
port preflight before either binds, producing duplicate Telegram pollers.

### Step 7: Deploy Plugin (Marketplace)

Claude Code plugin is deployed via the marketplace:

1. **Update marketplace repository**:
   - Update MAMA plugin metadata in `jungjaehoon-lifegamez/claude-plugins` repository
   - Reflect version and changes in `plugin.json`

2. **Create release**:
   - Create GitHub release (tag: `plugin-v1.1.0`)
   - Include release notes

3. **User update instructions**:
   ```bash
   # Command for users to run
   /plugin update mama
   ```

### Step 8: Git Tag and Push (Manual Fallback Only)

```bash
# Create tag
git tag v1.1.0

# Push tag
git push origin v1.1.0

# Push main branch (skip if already done)
git push origin main
```

---

## Package-Specific Deployment Strategies

### MCP Server (@jungjaehoon/mama-server)

| Item                  | Details                                  |
| --------------------- | ---------------------------------------- |
| **Deployment target** | npm registry (public)                    |
| **Deploy command**    | `npm publish`                            |
| **Deploy frequency**  | On feature changes (MINOR/PATCH)         |
| **Installation**      | `npx -y @jungjaehoon/mama-server`        |
| **Updates**           | Automatic (npx downloads latest version) |

**Files included in npm package** (`files` field):

- `src/**/*.js` - Server source code
- `src/db/migrations/*.sql` - DB migration scripts
- `README.md` - Package documentation
- `LICENSE` - License file

### MAMA OS (@jungjaehoon/mama-os)

| Item                  | Details                                                        |
| --------------------- | -------------------------------------------------------------- |
| **Deployment target** | npm registry (public)                                          |
| **Deploy method**     | `.github/workflows/release.yml` with `packages=mama-os`        |
| **Deploy frequency**  | On standalone runtime changes (MINOR/PATCH)                    |
| **Installation**      | `npm install -g @jungjaehoon/mama-os@<version>`                |
| **Verification**      | npm version, daemon restart/status, `/health`, temporal canary |

### Claude Code Plugin (mama)

| Item                  | Details                       |
| --------------------- | ----------------------------- |
| **Deployment target** | Claude Marketplace            |
| **Deploy method**     | Update marketplace repository |
| **Deploy frequency**  | On command/hook changes       |
| **Installation**      | `/plugin install mama`        |
| **Updates**           | `/plugin update mama`         |

**Files included in plugin** (`files` field):

- `.claude-plugin/**` - Plugin metadata
- `.mcp.json` - MCP server reference
- `commands/**` - Slash commands
- `hooks/**` - Hook configurations
- `skills/**` - Skill definitions
- `scripts/**` - Hook scripts
- `src/**` - Plugin source code

---

## Environment Configuration

### Development Environment

```bash
# Local development setup
cd packages/claude-code-plugin
ln -s $(pwd) ~/.claude/plugins/repos/mama

# Use development DB
export MAMA_DB_PATH=./dev-mama.db
```

### Test Environment

```bash
# Use in-memory DB for tests
export MAMA_DB_PATH=:memory:

# Force Tier 3 mode (feature testing)
export MAMA_FORCE_TIER_3=true
```

### Production Environment

```ini
# .env file (user environment)
MAMA_DB_PATH=~/.claude/mama-memory.db
MAMA_SERVER_TOKEN=<secure_token>
# MCP server HTTP mode only; the MAMA OS daemon API remains fixed at 3847.
MAMA_SERVER_PORT=3000
MAMA_EMBEDDING_MODEL=Xenova/multilingual-e5-small
MAMA_ENVELOPE_ISSUANCE=enabled
MAMA_STAGE2_WORKORDERS=off
MAMA_TEMPORAL_RECONCILE=off
```

For Cloudflare Zero Trust deployments of MAMA OS, add:

```ini
MAMA_TRUST_CLOUDFLARE_ACCESS=true
```

Use `MAMA_AUTH_TOKEN` for non-Access tunnels and temporary test exposure. Without one of those two modes, protected `/api/*` routes will reject external tunnel requests.

**Environment Variable Reference:**

| Variable                  | Description                                   | Default                        |
| ------------------------- | --------------------------------------------- | ------------------------------ |
| `MAMA_DB_PATH`            | SQLite DB file path                           | `~/.claude/mama-memory.db`     |
| `MAMA_SERVER_TOKEN`       | Auth token (HTTP mode)                        | -                              |
| `MAMA_SERVER_PORT`        | MCP server HTTP port; does not change MAMA OS | `3000`                         |
| `MAMA_EMBEDDING_MODEL`    | Embedding model                               | `Xenova/multilingual-e5-small` |
| `MAMA_ENVELOPE_ISSUANCE`  | Runtime envelope issuance                     | `enabled`                      |
| `MAMA_STAGE2_WORKORDERS`  | Durable workorders (`off`, `shadow`, or `on`) | `off`                          |
| `MAMA_TEMPORAL_RECONCILE` | Temporal reconciliation (`off` or `on`)       | `off`                          |
| `MAMA_FORCE_TIER_3`       | Force Tier 3 mode                             | `false`                        |

Keep both workorder flags `off` during an ordinary upgrade. A temporal rollout changes them
together: `MAMA_STAGE2_WORKORDERS=on` first, then `MAMA_TEMPORAL_RECONCILE=on` in the same daemon
restart after envelope and worker transport checks pass. Temporal `on` with Stage-2 not `on` fails
startup after pausing incompatible temporal attempts.

The MAMA OS daemon and its `/health` endpoint listen on the fixed local API port `3847`.

---

## Post-Deployment Verification

Verify the following after deployment:

```markdown
- [ ] npm package version: `npm info @jungjaehoon/mama-server version`
- [ ] MAMA OS npm version: `npm info @jungjaehoon/mama-os version`
- [ ] Exact MAMA OS version installed: `npm install -g @jungjaehoon/mama-os@<version>`
- [ ] Daemon restart and process status: `mama stop && mama start && mama status`
- [ ] HTTP health: `curl -fsS http://127.0.0.1:3847/health`
- [ ] MCP server startup: `npx -y @jungjaehoon/mama-server` (stdio start)
- [ ] Plugin installation: `/plugin install mama`
- [ ] Basic functionality tests:
  - [ ] `/mama-save` - Save decision
  - [ ] `/mama-list` - List decisions
  - [ ] `/mama-recall` - Search by topic
  - [ ] `/mama-checkpoint` - Save checkpoint
  - [ ] `/mama-resume` - Restore session
- [ ] GitHub release verification
- [ ] Release notes published
- [ ] If temporal reconciliation is being rolled out, verify one non-critical due task in `/ui`:
      workflow status remains independent from `temporal_state`, and its temporal workorder reaches a
      receipt-backed terminal result or an explicit bounded deferral.
```

---

## Troubleshooting

### npm publish failure

```bash
# Permission error
npm login  # Re-login

# Version conflict
# Bump version in package.json and retry

# Network error
npm publish --registry https://registry.npmjs.org
```

### Plugin update not reflecting

```bash
# Clear cache and reinstall
/plugin uninstall mama
/plugin install mama
```

### Test failures

```bash
# Run individual tests to identify cause
cd packages/mcp-server
pnpm vitest run tests/tools/save-decision.test.js

cd packages/claude-code-plugin
pnpm vitest run tests/hooks/pretooluse-hook.test.js
```

---

## Related Documentation

- [Installation Guide](./installation.md)
- [Troubleshooting](./troubleshooting.md)
- [v0 to v1.1 Migration](./migration-v0-to-v1.1.md)
- [API Reference](../reference/api.md)
- [MCP Protocol Specification](../reference/mcp-protocol-spec.md)

---

_Last Updated: 2026-07-22_
