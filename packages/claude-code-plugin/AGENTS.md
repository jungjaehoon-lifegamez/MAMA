# CLAUDE CODE PLUGIN KNOWLEDGE BASE

**Generated:** 2026-02-08  
**Package:** claude-code-plugin  
**Type:** Claude Code marketplace plugin (JavaScript)

---

## OVERVIEW

Claude Code plugin for MAMA memory system. Provides 5 slash commands, 4 hooks (2 active), and 1 skill. Distributed via Claude Code marketplace. Self-contained (no npm dependencies) — 27 mama-core modules duplicated in `src/core/`.

**Stack:** JavaScript, Vitest, SQLite + sqlite-vec, Transformers.js (local embeddings)

---

## STRUCTURE

```
claude-code-plugin/
├── commands/                       # 5 slash commands (Markdown definitions)
│   ├── mama-save.md                # Save decisions/checkpoints
│   ├── mama-recall.md              # Search memory graph
│   ├── mama-suggest.md             # Get context-aware suggestions
│   ├── mama-list.md                # List recent decisions
│   └── mama-configure.md           # Configure plugin settings
├── scripts/                        # 7 hook scripts (2 active, 2 disabled)
│   ├── session-start.js            # SessionStart hook (active)
│   ├── user-prompt-submit.js       # UserPromptSubmit hook (active, <1800ms)
│   ├── pre-tool-use.js             # PreToolUse hook (disabled)
│   └── post-tool-use.js            # PostToolUse hook (disabled)
├── skills/mama-context/            # Skill for memory-aware context
├── src/core/                       # 27 modules DUPLICATED from mama-core
│   ├── mama-api.js                 # High-level memory API
│   ├── embeddings.js               # HTTP client + Transformers.js fallback
│   ├── db-manager.js               # SQLite + sqlite-vec
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

```
src/core/ — 27 modules duplicated from mama-core
Why: Claude Code plugins can't have npm dependencies; files must be self-contained
Risk: Bug fixes in mama-core don't propagate to plugin (version skew)
Mitigation: ALWAYS apply fixes to BOTH locations:
  1. packages/mama-core/src/
  2. packages/claude-code-plugin/src/core/
```

### **Hook Performance**

```javascript
// ❌ FORBIDDEN: Hook execution >1800ms
// UserPromptSubmit hook must complete within 1800ms (target <1200ms)
// Use MAMA_FORCE_TIER_3=true to skip embeddings in tests (~500ms vs ~2-9s)
```

---

## COMMANDS

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Run single test file
pnpm vitest run tests/hooks/user-prompt-submit.test.js

# Run tests matching pattern
pnpm vitest run -t "SessionStart hook"
```

---

## NOTES

1. **Entry Point:** `.claude-plugin/plugin.json` (no main field)
2. **Active Hooks:** SessionStart, UserPromptSubmit (PreToolUse/PostToolUse disabled)
3. **Bug Fix Protocol:** Apply changes to BOTH mama-core and plugin src/core/
4. **Performance Target:** <1200ms for UserPromptSubmit hook (hard limit 1800ms)
5. **Test Mode:** Use `MAMA_FORCE_TIER_3=true` to skip embeddings (faster tests)
