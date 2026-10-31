# Google read — the agent reads Gmail, Calendar, Sheets and Docs on demand

Owner decision, 2026-10-31 (dev memory `google_read_host_action`):

- The agent reads Google on demand through a host action that takes gws-style arguments and runs
  gws for it. Read methods only; the host holds the credentials; the output is quoted as external
  evidence; every call is in `tool_traces`.
- Owner-role chat turns and autonomous turns (reports, deltas) have it. Member sessions never (P6).
- The agent's shell stays closed (W35.4 unchanged). Rejected: letting the shell reach Google
  hosts. The proxy filters by host, not binary, so it would be an exfil channel to an attacker's
  Google account; gws credentials would be readable in the sandbox; raw output would skip quoting.

Correction, same day (coordinator research): no global `--readonly` login, because
`deliver.drive.file` writes to Drive with the same sign-in. Explicit scopes instead, read-only
where nothing writes. Do not duplicate `drive.read`, `drive.download` or `deliver.drive.file`.

Owner decision, 2026-10-31 (dev memory `gws_credentials_denied_to_agents`): gws's credential
store is denied to MAMA's agents' native reads, on both backends, because MAMA's connectors and
`google.read` now run on that login. Other tools' stores stay as they were.

Program evidence:

- gws takes `gws <service> <resource>… <method> --params <JSON>`. Per method it also takes
  `--output`, `--json` (methods with a body), `--upload` (media methods) and
  `--page-all/--page-limit/--page-delay`. Global flags are `--format`, `--dry-run` and
  `--sanitize <template>`, which sends responses to a Model Armor template in a Cloud project
  (gws `commands.rs`).
- gws passes any parameter it does not know through to the URL as a query parameter (gws
  `executor.rs`, `build_url`). Google's system parameters `alt`/`$alt` (media, proto) and
  `callback`/`$callback` (JSONP) make the response something other than JSON.
- gws writes any response that is not JSON to a file. Without `--output` the file is
  `download.<ext>` in its working directory, and stdout carries only `{"status","saved_file",…}`
  (gws `executor.rs`, `handle_binary_response`). The daemon's working directory is the MAMA home
  (start.sh `cd`s there), so before this round `callback: "f"` on `threads get` would have left the
  whole thread in `~/.mama/download.<ext>`. The agent could then open it with Read, past the cap,
  the quoting and the trace.
- An error is JSON on stdout, `{"error":{"code","message","reason"}}`, with `enable_url` for
  `accessNotConfigured`; auth failures are 401 `authError` (gws `error.rs`, `executor.rs`).
- Login scopes (gws `auth_commands.rs`). `--scopes` conflicts with `--readonly` and `--full` but
  not with `-s`. It is passed to Google as written (`resolve_scopes`, `ScopeMode::Custom`), so
  `-s` does nothing beside it. gws adds `openid`, `userinfo.email` and `userinfo.profile`.
  Today's `-s <services>` opens a scope picker in a terminal. Otherwise it asks for gws's
  defaults: `drive`, `spreadsheets`, `gmail.modify` and `calendar`.
- gws keeps its sign-in in one config directory (gws `auth_commands.rs`, `config_dir`). It uses
  `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` if set, else `~/.config/gws` if that exists, else the legacy
  `dirs::config_dir()/gws` (macOS `~/Library/Application Support/gws`, Linux
  `$XDG_CONFIG_HOME/gws`) if that exists. The directory holds `credentials.enc`, its
  `.encryption_key` fallback, `credentials.json`, `token_cache.json` and `client_secret.json`.
  `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` names a plaintext sign-in anywhere (`auth.rs`). On
  macOS the key to `credentials.enc` is in the keychain (`credential_store.rs`).
  `gws auth export --unmasked` prints the client secret and refresh token with no network
  (`handle_export`).
- `deliver.drive.file` runs `files list`, `files create --upload`, `files update` and
  `permissions create` in the folder the owner names in config (`api/drive-delivery.ts`).
  `drive.file` reaches only files the client created or the person opened with it (Google's Drive
  scope guide), not an existing folder, so Drive needs `drive`. `drive.read` lists drives, browses
  folders, reads metadata and searches; `drive.download` fetches a file or exports it as
  docx/xlsx/pptx (`api/drive-actions.ts`). Neither reads a Doc as text.
- Dispatch compares `access.actions` before exec (`mama-core/src/api/dispatch.ts:115`) and a
  `readsConnector` input against `access.connectors`. The daemon gives the owner every loadable
  connector, enabled or not (`cli/commands/daemon.ts:837`). An owner-role DM gets `drive.read`
  beside `MEMBER_ACTIONS` (`runtime/principal-access.ts:194`); rooms filter `MEMBER_ACTIONS`.
- Replay turns carry `session.replaySourceEndMs` (`runtime/stimulus-delivery.ts:853`), and
  `member.notice` refuses on it (`api/member-notice-actions.ts:100`). `drive.read` and
  `trello.read` never check it.
- Quoting is by action name (`utils/untrusted-content.ts`), applied to Codex host tools
  (`runtime/native-session.ts`) and MCP results (`runtime/action-mcp-server.ts`); Claude reaches
  actions through `code_act`, whose whole result is quoted.
- The daemon's gws calls inherit `process.env`, which is start.sh's environment; doctor rebuilds
  the same with `serviceEnvironment` (`cli/runtime/diagnostics.ts:938`). Backends get
  `backendEnvironment`, without credential-shaped names. Native read denies
  (`credentialReadPaths`) reach Claude's Read rules, its Bash sandbox `denyRead` and the Codex
  permission profile through `runtime/native-session.ts`, and the document renderer's sandbox.
- `execGwsAsync` passes `maxBuffer: undefined` when a call names none. That lifts Node's 1 MiB
  default instead of keeping it (measured on Node 25), so the connectors' gws output is unbounded.

## Work

| #   | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Done when                                                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `google.read {service, argv, params?}`: the host runs `gws <service> <argv…> [--params <params>]` with `execFile`, no shell, no other flag. Allowed: gmail `users getProfile`, `users labels list`, `users messages list\|get`, `users threads list\|get`; calendar `calendarList list`, `events list\|get`; sheets `spreadsheets get`, `spreadsheets values get`; drive `files export` only. argv is compared token by token. Anything else is refused (`google_method_not_allowed`) with the allowed set; a token starting with `-` or `+` is also told why flags and helpers are not taken                                                                               | `cd packages/standalone && npx vitest run tests/api/google-read-actions.test.ts`: every allowed method runs with exactly that argv; send, create, insert, update, trash, `drive files list\|get`, an unknown method, `["users messages list"]`, `--output`, `--upload`, `--page-all` and `+triage` are refused before gws runs                                    |
| G2  | Every call runs with its working directory in a fresh directory under `<MAMA home>/runtime/google-read`, which no agent reads, removed in `finally`. A result that is gws's `saved_file` report is refused (`google_read_media_refused`), and the file goes with the directory. `alt`/`$alt` other than `json` and any `callback`/`$callback` (JSONP whatever the name) are refused before gws runs. `files export` takes a `text/*` `mimeType` and the relative `--output export`, read back from the call's directory                                                                                                                                                     | Same file: each call runs in its own directory and leaves none; a stand-in that writes `download.js` and prints `saved_file` is refused, its content is not in the result, and nothing stays in the scratch directory or the test's cwd; `alt`, `$alt`, `callback` (also `"json"`) and `$callback` are refused; a Doc exported as `text/plain` comes back as text |
| G3  | A result over 100,000 characters (the JSON as returned, or the exported text) is refused (`google_read_too_large`). A list's refusal names `maxResults`/`pageSize`, `pageToken` and `fields`. One item's refusal says it is not returned in parts and names a smaller form (`format "metadata"`, a smaller range, `drive.download` for a file). gws's stdout is bounded at 1 MiB on every call, export included; past it, the same refusal. Nothing is truncated                                                                                                                                                                                                            | Same file: an oversized page, an oversized single message, an output past the buffer and an oversized export are each refused with their message                                                                                                                                                                                                                  |
| G4  | Grant: `OWNER_ACTIONS` (the common session: chat, deltas, reports, record orders) and the owner-role DM branch of `resolvePrincipalAccess`, beside `drive.read`; not `MEMBER_ACTIONS`, so neither plain members nor rooms. `readsConnector: {fromInput: 'service'}`, as `drive.read` and `trello.read` declare theirs. Enforced at dispatch only                                                                                                                                                                                                                                                                                                                            | `npx vitest run tests/runtime/google-read-access.test.ts`: a plain member, its room and an owner-role room get `action_not_granted`; an owner-role DM and the common session, with and without a message ref, complete                                                                                                                                            |
| G5  | `google.read` joins `isUntrustedExternalEvidenceTool`. The existing `observeCall` writes each call to `tool_traces`: `input_summary` holds service, argv and params, and `output_summary` a 4,000-character excerpt of the result (both bounded, secrets redacted), as for `drive.read` and `source.read`                                                                                                                                                                                                                                                                                                                                                                   | Same file and `tests/runtime/owner-security.test.ts`, `tests/runtime/native-session.test.ts`: the result is wrapped; a completed call, a refused grant and a refused method each leave a row with their `failure_code`                                                                                                                                            |
| G6  | Errors from gws's own report (`gwsFailure`, `GwsCliError` in `gws-utils.ts`): ENOENT → `gws_missing`; 401 → `google_signed_out`; 403 `insufficientPermissions` → `google_scope_missing`, saying the login must include the service's scope and giving the `--scopes` line with it added; 403 `accessNotConfigured` → `google_api_disabled` with `enable_url`; the same two by Google's message where gws prints `reason: "unknown"` (Sheets v4 answers in the newer error shape, with no `errors[]`); 429 or a rate/quota reason → `google_quota`; else `google_api_error` with gws's message. `gwsReadRefusal` classifies through the same function; its text is unchanged | `npx vitest run tests/api/google-read-actions.test.ts tests/connectors`: each case through a stand-in `gws` on `PATH`; connector tests unchanged                                                                                                                                                                                                                  |
| G7  | The printed login asks for explicit scopes: `gwsTool` takes `--scopes`, and `GWS_LOGIN_SCOPES` maps each Google source's service to `gmail.readonly`, `calendar.readonly`, `spreadsheets.readonly` and `drive`. The line is `gws auth login --scopes <sorted URLs>` in init, `init --section connectors` and doctor's fixes. The four connectors' requirement text names their scope. The install skill and the CHANGELOGs say so; an existing sign-in keeps working                                                                                                                                                                                                        | `npx vitest run tests/cli/onboarding.test.ts tests/cli/doctor.test.ts tests/connectors`; `cd packages/claude-code-plugin && npx vitest run tests/skills`                                                                                                                                                                                                          |
| G8  | Docs: `docs/reference/actions.md` row, count and owner-role list; `docs/guides/security.md` says what `google.read` can reach                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Read                                                                                                                                                                                                                                                                                                                                                              |
| G9  | `credentialReadPaths` adds `gwsCredentialPaths()`: `$GOOGLE_WORKSPACE_CLI_CONFIG_DIR` and `$GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` when set, `~/.config/gws`, and the legacy directory, whichever exists. It reaches Claude's Read rules and sandbox `denyRead`, the Codex permission profile and the document renderer, for the owner and member sessions. AGENTS.md's credential boundary records the decision                                                                                                                                                                                                                                                            | `npx vitest run tests/runtime/owner-native-denies.test.ts`: on both backends and both member settings, Claude's settings and Read rules and the Codex `config.toml` deny each gws path; the paths follow gws's own lookup                                                                                                                                         |
| G10 | A replay turn (`session.replaySourceEndMs` set) is refused (`google_read_replay`, denied) before gws runs: Google read now is past the replay's window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tests/api/google-read-actions.test.ts`: a call with a replay ceiling is refused and gws never runs                                                                                                                                                                                                                                                               |

Polling stays as it is: the four connectors keep their defaults and their unbounded output.
Narrowing the polling defaults is a separate, pending owner decision.

Live proof, after merge and deploy: an owner question on Telegram that needs mail outside the
polled window ("what did the client send about X last spring?") is answered from `google.read`
with evidence; `tool_traces` shows the argv; `daemon.log` is clean.

## Pending owner decisions

1. **Polling defaults**: unchanged here (see above).
2. **Drive's scope when nothing delivers to Drive.** It stays `drive` for every install, so one
   login serves `deliver.drive.file` whenever `delivery.drive` is set, now or later.
   `drive.readonly` would be enough without delivery. It would need the config at print time, and
   an owner who sets `delivery.drive` later would have to sign in again.
3. **Which services the login names.** It names the services of enabled sources (unchanged).
   `drive.read`, `drive.download` and `deliver.drive.file` work without the Drive source, but only
   if Drive is in the sign-in. A `google.read` of a service with no enabled source gets
   `google_scope_missing`, which says the login must include that scope and gives the line with it
   added. Naming all four services always would make every on-demand read work.
4. **Drive listing with any query.** `drive.read` searches by name and content and browses
   folders. It cannot filter by modified time, type or owner, or return fields outside its view.
   Add `drive files list|get` to `google.read` when an owner turn needs that, or when `drive.read`
   is retired. Retiring it means moving its knowledge (link parsing, `corpora=allDrives`, Drive's
   word-prefix matching, `incompleteSearch`) into the files help topic first.
5. **An alert on a refused mutating method** (`messages send`, `files create`). Not built: the
   refusal is in `tool_traces` with its `failure_code`.
6. **The connectors' unbounded gws output** (evidence, last line). Not changed here.
7. **Replay and the other live reads.** `drive.read` and `trello.read` also read live in a replay
   turn, with no as-of limit. Not changed here.

## Notes

- **Why the allowlist is the guard.** The token is not read-only: Drive is `drive` for
  `deliver.drive.file`, and a sign-in made before this change may carry `gmail.modify` and full
  Calendar and Sheets. Only the method list keeps `google.read` from writing.
- **Why argv carries no flags, and why that is not enough.** The host builds the whole command,
  so `--output`, `--upload`, `--json`, `--page-all`, `--format` and `--sanitize` are never inputs.
  `params` still reaches Google, and a parameter can change the response's format (`alt`,
  `callback`), which makes gws write a file. Refusing those parameters by name catches the known
  ones before the call. The guard that holds for any parameter is structural: every call runs in
  a directory of its own that is removed after it, and a `saved_file` result is refused. A response
  that is not JSON never reaches the agent, never stays on disk, and never depends on where the
  daemon runs.
- **Why no turn-mode check.** WebFetch is limited in turns with no person (10-15) because the
  agent chooses the host, and text in a URL reaches it. Here the destination is fixed: Google's
  API, under the owner's own login, which only the host holds. Deltas and reports need the same
  reads as chat. A replay is different: it reads only up to its window, and a live read is past it.
- **Why no security event.** Same reason: nothing the agent passes names another host. Every call
  and refusal is in `tool_traces`. Pending decision 5 is the option if the owner wants an alert.
- **Why one grant check.** `drive.read` also re-checks the role inside exec. The grant list is
  where principals are told apart, rooms included; a second check would cover no case the first
  misses.
- **Why 100,000 characters.** A Codex turn gets the result whole as one tool result. Claude Code's
  default limit for one MCP tool result is 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`), and a
  `code_act` return meets it too; 100,000 characters of ASCII JSON is about that size. Japanese or
  Korean text costs about a token per character, so a CJK page near the cap is several times that
  limit; the agent narrows such a page further. `source.read` pages stored text at 4,000
  characters. An API page cannot be split without breaking its JSON, so the agent narrows the
  request instead. A list narrows by page size; one message, event or range that is itself over
  the cap cannot be read in parts here, and its refusal says so instead of promising that `fields`
  helps. The 1 MiB stdout bound is Node's own default, stated, because gws prints indented JSON.
- **Credentials.** The action runs in the daemon, whose environment is start.sh's: gws finds its
  own sign-in there, as the connectors do. The agent never runs gws for this; its environment is
  scrubbed and its shell is closed. The native read denies go into the backends' own
  configuration (Claude's Read rules and sandbox, the Codex permission profile) and the document
  renderer's sandbox. The daemon's gws, the connectors and doctor run in processes none of those
  configure, so they keep reading the store. With `credentials.enc` (and the `.encryption_key`
  fallback) unreadable inside the sandbox, a sandboxed `gws auth export` has nothing to decrypt.
  The macOS keychain item holds only the key to that file, so whether the sandbox reaches the
  keychain no longer matters. Members already could not read `~/.config/gws` (their denies cover
  the home directory); the deny also covers a configured directory outside it.
- **Export.** gws always writes an export to a file, so the host names it, relative to the call's
  own directory under `runtime/`. The owner agent's native reads exclude that directory, and
  members cannot reach it because their denies cover the home directory.
