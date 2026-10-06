# AGENTS.md

Shared instructions for every coding agent working in this repository (Claude Code, Codex, and
others). Claude-only notes live in `CLAUDE.md`.

## Purpose first

- Read [INTENT.md](INTENT.md) before starting or resuming work. Tie every plan and change to one of
  its owner checks (recognise, attach, answer, report, learn) or to the shared-engine goal.
- The product is "Kagemusha's loop + a wiki + memory that carries over". What sets it apart is
  **task history and similar-case search**. Team features wait until the owner flow works on real
  data.
- Work is done when real owner questions on real data get the right answer. Passing tests,
  structure checks, line or file counts, and progress scripts are supporting evidence only. Never
  report a finished sub-task as the purpose being met.
- The current work list is [docs/development/plan.md](docs/development/plan.md). After each item, add 3–5
  lines to [docs/development/checks.md](docs/development/checks.md): result, evidence, what still fails.
  Both are working documents: commit them straight to `main`, without a PR (owner, 2026-10-06).
- What a better model would fix is not product work. A problem counts only when a perfect model
  could not solve it with today's tools, data and write paths. A done condition checks what the
  program delivers, not whether the model obeys it (owner, 2026-10-06).

## Repository map

| Package                       | Role                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/mama-core`          | Shared engine: storage, records with revisions, search, embeddings, memory, raw observations, runtime, action catalog. Used by MAMA and by other projects |
| `packages/standalone`         | Product (MAMA OS, `mama` CLI): connectors, owner loop, tasks/board/wiki/reports, viewer                                                                   |
| `packages/mcp-server`         | Public MCP server (plain JS) for Claude Code / Desktop                                                                                                    |
| `packages/claude-code-plugin` | Claude Code plugin (hooks, commands) for development-session memory                                                                                       |

- There are two data homes. `~/.mama/` is the daemon's (product) state. `~/.claude/mama-memory.db`
  is MCP and development-session memory. Never mix them.
- Kagemusha is a local reference implementation outside this repository. Read it, and port
  **mechanisms only**. Never copy names, channels, business content or other personal data from it.
- Check an action exists in the catalog (core `api/catalog.ts` plus the product registrations)
  before assuming it does.

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Run a single package or file **from inside that package**. Running from the repo root with
`--root` gives false failures.

```bash
cd packages/mama-core && npx vitest run tests/unit/some-file.test.ts
cd packages/mama-core && npx vitest run -t "pattern"
```

## Verification gotchas

- launchd manages the daemon (`com.mama.server`, KeepAlive), so a killed process comes back. Stop
  it before touching `~/.mama`: `launchctl bootout gui/$(id -u)/com.mama.server`. The daemon runs
  whatever `DAEMON_JS` in `~/.mama/start.sh` points at.
- Live behaviour is proven by an owner turn, a clean `~/.mama/logs/daemon.log`, and a DB read-back.
  A row existing in the DB is not proof on its own.
- `~/.mama` is a disposable testbed: no backups, compatibility windows or dual reads. Use
  `daemon.log` to see which branch ran, never to argue about cost or frequency.
- `~/.claude/mama-memory.db` is **not** disposable. Scripts and benches set `MAMA_DB_PATH` before
  `initDB()`, because the default is that database.
- Tests that touch config or the home directory run under a temporary `$HOME`. One of them once
  overwrote the live config.
- A bench `claude -p` runs with `--setting-sources project`, or the plugin hooks contaminate it.
- Check claims of absence ("nothing calls X") at the assembly point where things are wired
  together, not by grep alone.
- Never print ranges of `~/.mama/config.yaml`; it holds tokens.
- The daemon runs `packages/standalone/dist` from the main checkout, so pulling into it is a
  deploy: pull, build and restart together. Only one daemon can poll the Telegram bot.

## Rules

- **No PII:** no personal names, project names or channel IDs in source, comments, examples or
  test fixtures.
- **Core knows no consumer.** Other projects use `mama-core` through public exports
  only. Engine features (records, revisions, evidence links, search) go in core; product vocabulary
  stays in the product. A MAMA name inside core is a defect only when it makes the packed
  second-consumer test fail.
- **Build from evidence.** Before adding a mechanism, screen, field or action, name the code, the
  data or the owner decision that requires it. Do not build from imagination.
- **The agent judges, the host provides.** Meaning, relevance, identity and roles are not coded as
  rules. The host provides collection, storage, search, execution, permissions and receipts.
- **Relocate before you delete.** Before removing a host step, lane brief or policy line, name the
  place where its domain knowledge and owner corrections will reach the agent, and confirm it with
  one real owner turn.
- **No insurance guards or fallbacks.** Do not add a guard or an alternate path just because you are
  unsure. Surface the error and fix it. A guard needs a named reason.
- **Do not restrict the owner agent or its subagents.** The real boundaries are: non-owner
  principals' turns (grants and scope), `deliver.*` destination config, credentials outside MAMA's
  scope, and administration (interactive owner request only). Everything else is observed in
  `tool_traces`.
- **Schema:** change it with the next-numbered migration in `packages/mama-core/db/migrations`.
  Numbers 044–060 are held in `schema_version` by a retired chain; never reuse them.
- **Record** architecture, API contract and config schema decisions in MAMA (MCP `save`).
- Count what a refactor deletes as well as what it adds. A revision that only adds is suspect.
- Concurrent workers each get their own worktree. Never switch branches in a shared checkout.
- Pass commit messages from a file (`git commit -F`) and check `git log` before saying you committed.

## MAMA OS agent isolation — do not change

Daemon agents run only inside `~/.mama`. Leaking global settings costs thousands of duplicated
tokens every turn. Defined in `packages/mama-core/src/runtime/drivers/persistent-cli-process.ts`
and `claude-cli-wrapper.ts`; native tool projection in
`packages/standalone/src/agent/claude-native-tool-policy.ts` (carried back at W1).

| Setting             | Value                                                                                                                                                     | Why                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`               | `~/.mama/workspace`                                                                                                                                       | The home directory would inject `~/CLAUDE.md` every turn                                                                                                                                                                                                                                                                                                                                                                            |
| `.git/HEAD`         | created in the workspace                                                                                                                                  | Git boundary stops the upward CLAUDE.md search                                                                                                                                                                                                                                                                                                                                                                                      |
| `--plugin-dir`      | `~/.mama/.empty-plugins` (empty)                                                                                                                          | Keeps global plugin skills out                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--setting-sources` | `project,local` (no `user`)                                                                                                                               | Keeps `~/.claude/settings.json` plugins out                                                                                                                                                                                                                                                                                                                                                                                         |
| `--system-prompt`   | first turn only                                                                                                                                           | The session persists                                                                                                                                                                                                                                                                                                                                                                                                                |
| Native tools        | Claude owner: role-projected tools, sandboxed Bash, workspace-only writes and WebFetch/WebSearch; Codex owner: shell and web search; other backends: none | Owner decision 2026-09-26: both owner runtimes write only inside `~/.mama/workspace` and have web access. Claude uses the workspace project sandbox and `dontAsk` with CLI `--allowedTools` rules (project-settings permissions were not applied to non-interactive runs), inherited by subagents; Codex keeps sandbox `workspace-write` and approvals `never`. Core shell/web defaults stay off; shell network policy is unchanged |

Forbidden: `cwd` set to home, removing `--plugin-dir`, adding `user` to `--setting-sources`,
adding `--no-session-persistence`, removing the `.git/HEAD` creation, widening native tools in
source except for the owner decision of 2026-09-26: both MAMA owner-runtime backends write only in
`~/.mama/workspace` and have web access. Codex enables shell and live web search with sandbox
`workspace-write` and approvals `never`; core shell/web defaults stay off and shell network policy
is unchanged. Claude replaces permission bypass with required sandboxed Bash (no unsandboxed
retry), a workspace-only `Edit(//<workspace>/**)` rule passed with `--allowedTools` and `dontAsk`, retaining readable-file access,
WebFetch/WebSearch, MAMA MCP tools and Agent. Subagents inherit the same boundary and run inside
the owner turn (background tasks off). Any other widening needs an owner decision recorded here.

Owner decision 2026-10-03 (W35.4): the Claude owner's Bash sandbox network goes to MAMA's own
deny-all proxy (`sandbox.network.httpProxyPort`/`socksProxyPort` in the workspace settings, ports
chosen at daemon start). It refuses every connection, as the empty sandbox allowlist did, and
reports each attempt with its destination as a security alert. Shell egress stays closed; this is
observation, not widening.

Owner decision 2026-10-05: each WebFetch call raises the same kind of security alert, naming its
URL and grouped per host within a minute, because text placed in a URL reaches any host. WebFetch
stays allowed; WebSearch stays recorded in `tool_traces` only. This is observation, not narrowing.

## Owner credential boundary — 2026-09-27

- Scope (owner decision 2026-09-27): the boundary covers MAMA's own credentials — auth.env,
  config.yaml, runtime/, the managed Codex home and the replay key file. Other tools' credential stores
  on the machine are not denied; the agent's native reads of them are recorded in tool_traces.
- Standalone removes secret-shaped environment names before launching either backend; core accepts
  a complete consumer-supplied environment. Native children inherit it; daemon connectors keep theirs.
- Claude CLI Read denies and Bash sandbox denyRead exclude auth.env, config.yaml, runtime/ and the
  managed Codex home. Codex uses a named workspace permission profile with those paths denied;
  thread start/resume select that profile instead of the legacy sandbox override.
- Viewer tunnel headers never establish identity. Remote access requires MAMA_AUTH_TOKEN or a verified
  Access JWT configured with MAMA_CF_ACCESS_ISSUER and MAMA_CF_ACCESS_AUD. Unconfigured verification
  fails closed. Direct loopback without tunnel headers remains available.
- External evidence is quoted at model-facing tool results and delta stimuli; stored source data and
  host receipts retain their original structure. These changes protect the Answer and Report checks.

## References

- Release: [docs/development/release-process.md](docs/development/release-process.md). A release
  that touches mama-core publishes core first. The plugin's `package.json` and
  `.claude-plugin/plugin.json` versions must match; a test enforces it.
- Learning: [corrections and learning](docs/guides/corrections-and-learning.md), with
  development evidence recorded through the [intent workflow](docs/development/intent-workflow.md).
