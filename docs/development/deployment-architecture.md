# Deployment Architecture

**Last Updated:** 2025-11-21

This document explains how MAMA is structured, developed, and deployed to users.

---

## Architecture Overview

MAMA uses a **3-layer architecture**:

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Development Repository (Monorepo)                  │
│ github.com/jungjaehoon-ui/MAMA                               │
│                                                              │
│ ├── packages/                                                │
│ │   ├── mcp-server/           → npm publish                  │
│ │   └── claude-code-plugin/   → copy to marketplace         │
│ └── docs/                                                    │
└─────────────────────────────────────────────────────────────┘
                    ↓                    ↓
        ┌───────────────────┐    ┌─────────────────────┐
        │ npm Registry      │    │ Plugin Marketplace  │
        │                   │    │ github.com/jungjaehoon-ui/ │
        │ @jungjaehoon-ui/  │    │ claude-plugins             │
        │ mama-server       │    │                     │
        │                   │    │ └── plugins/mama/   │
        └───────────────────┘    └─────────────────────┘
                    ↓                    ↓
        ┌───────────────────────────────────────────┐
        │ User Installation                         │
        │                                           │
        │ 1. /plugin marketplace add jungjaehoon-ui/...    │
        │ 2. /plugin install mama@jungjaehoon-ui           │
        │                                           │
        │ Result:                                   │
        │ ~/.claude/plugins/.../mama/               │
        │ └── .mcp.json (npx @jungjaehoon-ui/mama-server)  │
        └───────────────────────────────────────────┘
                    ↓
        First use: npx auto-downloads MCP server
```

---

## Layer 1: Development Repository (Monorepo)

### Structure

```
github.com/jungjaehoon-ui/MAMA
├── README.md                        # Project overview
├── LICENSE
├── package.json                     # pnpm workspace config
├── pnpm-workspace.yaml
│
├── packages/
│   ├── mcp-server/                  # @jungjaehoon-ui/mama-server
│   │   ├── package.json             # Independent npm package
│   │   ├── src/
│   │   │   ├── server.js            # MCP server entry point
│   │   │   ├── mama/                # Core logic
│   │   │   │   ├── db-manager.js
│   │   │   │   ├── embeddings-manager.js
│   │   │   │   ├── search-manager.js
│   │   │   │   └── graph-expander.js
│   │   │   └── tools/               # MCP tool handlers
│   │   │       ├── save-decision.js
│   │   │       ├── recall-decision.js
│   │   │       ├── suggest-decision.js
│   │   │       └── list-decisions.js
│   │   ├── tests/
│   │   └── bin/
│   │       └── mama-server          # CLI executable
│   │
│   └── claude-code-plugin/          # MAMA plugin
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── .mcp.json                # References @jungjaehoon-ui/mama-server
│       ├── commands/                # /mama-* commands (Markdown)
│       ├── hooks/                   # Hook configurations (JSON)
│       ├── skills/                  # Auto-context skill
│       ├── docs/                    # User documentation (Diátaxis)
│       └── tests/
│
├── .github/
│   └── workflows/
│       ├── test.yml                 # CI for both packages
│       ├── publish-mcp.yml          # npm publish workflow
│       └── publish-plugin.yml       # Marketplace sync workflow
│
└── docs/                            # Shared documentation (optional)
    └── architecture/
```

### Why Monorepo?

**Decision:** Use monorepo (pnpm workspace) for development

**Rationale:**

- **Version Sync**: Plugin 1.0.0 always works with MCP server 1.0.0
- **Single PR**: Changes to both packages in one pull request
- **Unified Testing**: CI/CD tests both packages together
- **Shared Dependencies**: Common dev tools (vitest, prettier, etc.)
- **Industry Standard**: @zilliz/claude-context, @modelcontextprotocol/servers use monorepo

**Alternative Considered:** Multi-repo (separate repos for MCP server and plugin)

- ❌ Version mismatch risk
- ❌ Duplicate CI/CD configuration
- ❌ Multiple PRs for single feature
- ❌ Complex dependency management

---

## Layer 2: Distribution Channels

### 2a. npm Registry (@jungjaehoon-ui/mama-server)

**Package:** `@jungjaehoon-ui/mama-server`
**Registry:** https://www.npmjs.com/package/@jungjaehoon-ui/mama-server

**Publishing:**

```bash
cd packages/mcp-server
npm version patch  # or minor, major
npm publish --access public
```

**Installation (by users):**

```bash
# Automatic (via npx in .mcp.json)
# No manual installation needed!

# Manual (if needed)
npm install -g @jungjaehoon-ui/mama-server
```

**Used by:**

- Claude Code plugin (via `.mcp.json`)
- Claude Desktop (via `claude_desktop_config.json`)
- Other MCP clients

### 2b. Plugin Marketplace (jungjaehoon-ui/claude-plugins)

**Repository:** `github.com/jungjaehoon-ui/claude-plugins`

**Structure:**

```
jungjaehoon-ui/claude-plugins/
├── marketplace.json         # Marketplace metadata
└── plugins/
    └── mama/                # From claude-mama/packages/claude-code-plugin
        ├── .claude-plugin/
        │   └── plugin.json
        ├── .mcp.json
        ├── commands/
        ├── hooks/
        ├── skills/
        └── README.md        # Plugin-specific README
```

**Sync Strategy (Option A: Automated):**

```yaml
# .github/workflows/publish-plugin.yml
name: Sync Plugin to Marketplace
on:
  release:
    types: [published]
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Copy plugin to marketplace
        run: |
          git clone https://github.com/jungjaehoon-ui/claude-plugins marketplace
          rm -rf marketplace/plugins/mama
          cp -r packages/claude-code-plugin marketplace/plugins/mama
          cd marketplace
          git add plugins/mama
          git commit -m "Update mama plugin to ${{ github.ref_name }}"
          git push
```

**Sync Strategy (Option B: Manual Release):**

```bash
# Release script
./scripts/release-plugin.sh v1.0.0
```

---

## Layer 3: User Installation

### Claude Code Installation

**Step 1: Add Marketplace**

```bash
/plugin marketplace add jungjaehoon-ui/claude-plugins
```

**Step 2: Install Plugin**

```bash
/plugin install mama@jungjaehoon-ui
```

**Step 3: First Use (Automatic)**

```bash
/mama-save
# MCP server downloads automatically via npx (~1-2 min)
```

**Installation Result:**

```
~/.claude/plugins/marketplaces/claude-plugins/plugins/mama/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json                    # Contains: npx -y @jungjaehoon-ui/mama-server
├── commands/
│   ├── mama-save.md
│   ├── mama-recall.md
│   ├── mama-suggest.md
│   └── mama-list.md
├── hooks/
│   └── inject-context.json
└── skills/
    └── mama-context.md

~/.npm/_npx/                     # MCP server cached here
└── @jungjaehoon-ui/mama-server/

~/.claude/mama-memory.db         # Shared database
```

### Claude Desktop Installation

**Add to `claude_desktop_config.json`:**

```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@jungjaehoon-ui/mama-server"],
      "env": {
        "MAMA_DB_PATH": "${HOME}/.claude/mama-memory.db"
      }
    }
  }
}
```

**First use:** npx downloads @jungjaehoon-ui/mama-server automatically

---

## Key Design Decisions

### Decision: 2-Package Architecture

**Separation:**

- **MCP Server** (@jungjaehoon-ui/mama-server): Heavy dependencies (better-sqlite3, @huggingface/transformers)
- **Plugin** (mama@jungjaehoon-ui): Lightweight (Markdown + JSON configs)

**Benefits:**

- ✅ Share MCP server across Claude Code + Claude Desktop
- ✅ Plugin updates don't require MCP server recompilation
- ✅ MCP server can be used standalone (API server, CLI tool)
- ✅ Clear dependency boundaries

### Decision: npx for MCP Server Distribution

**Why not bundle in plugin?**

- ❌ Native modules (better-sqlite3) are platform-specific
- ❌ Transformers models are 120MB+
- ❌ Cannot pre-compile for all platforms

**Why npx?**

- ✅ Auto-downloads on first use
- ✅ Caches locally (~/.npm/\_npx/)
- ✅ Compiles native modules for user's platform
- ✅ Official MCP servers use this pattern

### Decision: Marketplace Repo Separate from Dev Repo

**Why not use dev repo as marketplace?**

- ✅ Dev repo has CI, tests, docs (users don't need)
- ✅ Marketplace repo is clean, plugin-only
- ✅ Can have multiple plugins in marketplace later
- ✅ Follows official pattern (anthropic/claude-code-plugins)

---

## Development Workflow

### Local Development

```bash
# Clone monorepo
git clone https://github.com/jungjaehoon-ui/MAMA.git
cd MAMA

# Install dependencies
pnpm install

# Run tests (both packages)
pnpm test

# Test MCP server locally
cd packages/mcp-server
npm start

# Test plugin locally
cd packages/claude-code-plugin
# Link to ~/.claude/plugins/repos/mama (for testing)
```

### Release Workflow

**1. Update version (both packages)**

```bash
cd packages/mcp-server
npm version patch

cd packages/claude-code-plugin
npm version patch
```

**2. Tag release**

```bash
git tag v1.0.1
git push --tags
```

**3. GitHub Release triggers:**

- `publish-mcp.yml` → npm publish @jungjaehoon-ui/mama-server
- `publish-plugin.yml` → sync to jungjaehoon-ui/claude-plugins

**4. Users get updates:**

- MCP server: npx auto-updates on next use
- Plugin: `/plugin update mama@jungjaehoon-ui`

---

## Migration from Current Structure

**Current (MAMA):**

```
MAMA/
├── mama-plugin/              # Plugin files
└── mcp-server/               # MCP server (mixed with SpineLift code)
```

**New (MAMA monorepo):**

```
~/MAMA/
└── packages/
    ├── mcp-server/           # Clean MCP server (MAMA only)
    └── claude-code-plugin/   # Plugin (same as mama-plugin)
```

**Migration Steps:** See [Migration Guide](migration-plan.md)

---

## References

- [pnpm Workspace](https://pnpm.io/workspaces)
- [MCP Server Distribution](https://modelcontextprotocol.io/introduction)
- [Claude Code Plugin Structure](https://docs.anthropic.com/en/docs/claude-code/plugins-reference)
- Example Monorepo: [zilliz/claude-context](https://github.com/zilliztech/claude-context)
- Official MCP Servers: [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)

---

## See Also

- [Developer Playbook](developer-playbook.md)
- [Release Process](release-process.md)
- [Contributing Guide](contributing.md)
- [Testing Guide](testing.md)
