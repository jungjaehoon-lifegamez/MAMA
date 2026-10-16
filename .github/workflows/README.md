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

### `pages.yml` - Deploy GitHub Pages

**Purpose:** Build the Markdown documentation in `docs/` with Jekyll and deploy it to GitHub Pages.

**Trigger:**

- Push to `main` branch
- Changes to `docs/**/*.md`, `docs/_config.yml`, or `.github/workflows/pages.yml`
- Manual `workflow_dispatch`

**What it does:**

1. Checks out the repository
2. Configures GitHub Pages environment
3. Builds `docs/` with the Just the Docs remote theme and uploads `_site/`
4. Deploys to GitHub Pages

**Deployment URL:** `https://jungjaehoon-lifegamez.github.io/MAMA/`

---

### `release.yml` - Publish Prepared Releases

**Purpose:** Tag, publish selected packages (core first; the server with the exact core version), sync the Claude Code plugin to the `jungjaehoon-lifegamez/claude-plugins` marketplace, deploy GitHub Pages from the release tag, and create a GitHub Release. It is the only way packages reach npm and the plugin reaches the marketplace. The plugin sync fails unless the core version is on npm and the server the plugin pins depends on exactly that core.

**Trigger:** Manual `workflow_dispatch`.

**Recommended flow:**

1. Prepare package versions and release notes in a PR.
2. Merge the PR into `main`.
3. Run `release.yml` on `main` with `bump_versions=false`.

`bump_versions=true` is intentionally fail-closed for protected `main`; version bumps must be reviewed through a PR before publishing.

---

## Secrets

| Secret                | Used By       | Purpose                     |
| --------------------- | ------------- | --------------------------- |
| `GITHUB_TOKEN`        | All           | Auto-provided by GitHub     |
| `NPM_TOKEN`           | `release.yml` | npm registry auth           |
| `PLUGIN_DEPLOY_TOKEN` | `release.yml` | Push to claude-plugins repo |

## Adding New Workflows

1. Create new `.yml` file in this directory
2. Follow GitHub Actions syntax
3. Use `actions/checkout@v6` for latest stable version
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

- Check the Jekyll build step and the `docs/_config.yml` exclusions
- Verify Pages is enabled in repo settings
- Clear browser cache

## References

- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [pnpm/action-setup](https://github.com/pnpm/action-setup)
