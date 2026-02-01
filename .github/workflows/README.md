# GitHub Actions Workflows

This directory contains automated workflows for MAMA project CI/CD.

## Workflows

### `ci.yml` - Continuous Integration

**Purpose:** Run tests and type checks on every push and PR.

**Trigger:**

- Push to `main` or `feature/*` branches
- Pull requests to `main`

**Jobs:**

1. **test** (matrix: Node.js 20, 22)
   - Install dependencies with pnpm
   - Type check (`pnpm typecheck`)
   - Build packages (`pnpm build`)
   - Run tests (`pnpm test`)

2. **lint**
   - Run linting (`pnpm lint`)

---

### `publish.yml` - Publish npm Packages

**Purpose:** Publish packages to npm registry when tagged.

**Trigger:** Push tags matching:

| Tag Pattern                           | Package                      |
| ------------------------------------- | ---------------------------- |
| `v*`, `mcp-server-*`                  | `@jungjaehoon/mama-server`   |
| `core-v*`, `mama-core-*`              | `@jungjaehoon/mama-core`     |
| `os-v*`, `mama-os-*`, `standalone-v*` | `@jungjaehoon/mama-os`       |
| `openclaw-v*`, `openclaw-plugin-*`    | `@jungjaehoon/openclaw-mama` |

**Example Release:**

```bash
# Release MCP server v1.6.6
git tag v1.6.6
git push origin v1.6.6

# Release mama-core v1.0.1
git tag core-v1.0.1
git push origin core-v1.0.1

# Release mama-os v0.1.1
git tag os-v0.1.1
git push origin os-v0.1.1
```

**Required Secret:** `NPM_TOKEN`

---

### `pages.yml` - Deploy GitHub Pages

**Purpose:** Automatically deploy documentation website to GitHub Pages.

**Trigger:**

- Push to `main` branch
- Changes to `docs/website/**` or `.github/workflows/pages.yml`

**What it does:**

1. Checks out the repository
2. Configures GitHub Pages environment
3. Uploads `docs/website/` as artifact
4. Deploys to GitHub Pages

**Deployment URL:** `https://jungjaehoon-lifegamez.github.io/MAMA/`

---

### `sync-plugin.yml` - Sync Claude Code Plugin

**Purpose:** Sync plugin changes to Claude Code plugin marketplace.

**Trigger:**

- Push to `main` branch
- Changes to `packages/claude-code-plugin/**`

**What it does:**

1. Copies plugin files to `jungjaehoon-lifegamez/claude-plugins` repo
2. Updates marketplace.json with new version
3. Commits and pushes to plugin repo

**Required Secret:** `PLUGIN_DEPLOY_TOKEN`

## Secrets

| Secret                | Used By           | Purpose                     |
| --------------------- | ----------------- | --------------------------- |
| `GITHUB_TOKEN`        | All               | Auto-provided by GitHub     |
| `NPM_TOKEN`           | `publish.yml`     | npm registry auth           |
| `PLUGIN_DEPLOY_TOKEN` | `sync-plugin.yml` | Push to claude-plugins repo |

## Adding New Workflows

1. Create new `.yml` file in this directory
2. Follow GitHub Actions syntax
3. Use `actions/checkout@v4` for latest stable version
4. Document in this README

## Troubleshooting

**CI failing:**

- Check Node.js version compatibility
- Run `pnpm install && pnpm test` locally
- Review test output in Actions tab

**Publish failing:**

- Verify `NPM_TOKEN` secret is set
- Check package version is bumped
- Ensure workspace:\* protocol is replaced

**Pages not updating:**

- Check `docs/website/` exists
- Verify Pages is enabled in repo settings
- Clear browser cache

## References

- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [pnpm/action-setup](https://github.com/pnpm/action-setup)
