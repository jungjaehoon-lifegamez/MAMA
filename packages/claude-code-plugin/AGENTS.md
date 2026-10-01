# CLAUDE CODE PLUGIN KNOWLEDGE BASE

**Generated:** 2026-02-08  
**Package:** claude-code-plugin  
**Type:** Claude Code marketplace plugin (JavaScript)

---

## OVERVIEW

Claude Code plugin for MAMA memory system. Provides 5 slash commands, 1 hook (SessionStart), and skills. Distributed via Claude Code marketplace. SessionStart installs the npm dependencies (mama-core) into `${CLAUDE_PLUGIN_DATA}`; Claude Code does not install them.

**Stack:** JavaScript, Vitest, SQLite + pure-TS cosine similarity, Transformers.js (local embeddings)

---

## STRUCTURE

```text
claude-code-plugin/
├── commands/                       # 5 slash commands (Markdown definitions)
│   ├── mama-save.md                # Save decisions/checkpoints
│   ├── mama-recall.md              # Search memory graph
│   ├── mama-suggest.md             # Get context-aware suggestions
│   ├── mama-list.md                # List recent decisions
│   └── mama-configure.md           # Configure plugin settings
├── scripts/
│   ├── sessionstart-hook.js        # SessionStart, the only hook
│   └── plugin-deps.js              # Installs dependencies into CLAUDE_PLUGIN_DATA
├── skills/mama-context/            # Skill for memory-aware context
├── src/core/                       # 27 modules DUPLICATED from mama-core
│   ├── mama-api.js                 # High-level memory API
│   ├── embeddings.js               # HTTP client + Transformers.js fallback
│   ├── db-manager.js               # SQLite + pure-TS cosine similarity
│   └── ...                         # (24 more modules)
├── tests/                          # 134 tests (commands, hooks, core)
└── .claude-plugin/plugin.json      # Plugin manifest (entry point)
```

---

## WHERE TO LOOK

| Task                  | Location                 | Notes                                              |
| --------------------- | ------------------------ | -------------------------------------------------- |
| **Add command**       | `commands/*.md`          | Markdown-based command definitions                 |
| **Modify hooks**      | `scripts/*.js`           | CRITICAL: Must complete <1800ms (target <1200ms)   |
| **Fix memory logic**  | `src/core/mama-api.js`   | ⚠️ Also fix in `../../mama-core/src/mama-api.js`   |
| **Modify embeddings** | `src/core/embeddings.js` | ⚠️ Also fix in `../../mama-core/src/embeddings.js` |
| **Run tests**         | `pnpm test`              | Single-fork pool (ONNX/V8 locking)                 |

---

## CRITICAL CONSTRAINTS

### **Code Duplication (Unavoidable)**

```text
src/core/ — 27 modules duplicated from mama-core
Why: Claude Code plugins can't have npm dependencies; files must be self-contained
Risk: Bug fixes in mama-core don't propagate to plugin (version skew)
Mitigation: ALWAYS apply fixes to BOTH locations:
  1. packages/mama-core/src/
  2. packages/claude-code-plugin/src/core/
```

### **Hook Performance**

```javascript
// SessionStart loads no embedding model and takes about 0.1 s; its 180 s manifest timeout
// covers a first dependency install. No other hook runs.
// Tests set MAMA_FORCE_TIER_3=true, including for spawned hook processes.
```

---

## COMMANDS

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Run single test file
pnpm vitest run tests/hooks/sessionstart-hook.test.js

# Run tests matching pattern
pnpm vitest run -t "SessionStart hook"
```

---

## NOTES

1. **Entry Point:** `.claude-plugin/plugin.json` (no main field)
2. **Active Hooks:** SessionStart only; the agent pulls everything else (removed 2026-10-01: PreToolUse, PostToolUse, PreCompact)
3. **Bug Fix Protocol:** Apply changes to BOTH mama-core and plugin src/core/
4. **Performance:** SessionStart about 0.1 s after the first install
5. **Test Mode:** Use `MAMA_FORCE_TIER_3=true` to skip embeddings (faster tests)
