# Private Connector Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Kagemusha fully available to its configured owner installation while removing it
from every fresh/default MAMA catalog, role, prompt, brief, API, and worker capability.

**Architecture:** Load `connectors.json` once into an immutable private-connector policy snapshot.
All discovery, role projection, prompt overlays, envelope scopes, and operator-lane policies consume
that snapshot. Generic defaults remain source-neutral; enabled private behavior is appended at
runtime and participates in the TG-05 session fingerprint.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest single-fork, Commander, Express, MAMA role and
envelope policy layers.

## Global Constraints

- Preserve TG-01, TG-05, and TG-06 from `docs/development/kagemusha-telegram-parity.md`.
- Node.js must remain `>=22.13.0`; do not change the Vitest single-fork configuration.
- Do not edit `packages/mcp-server/`; this work is standalone-only.
- Kagemusha source may remain loadable, but a fresh installation must not discover its name, tools,
  recipes, API route, or catalog entry.
- A malformed connector config fails private projection closed and logs the loader error loudly.
- Configured-enabled policy, not successful connector initialization, controls owner visibility.
- Never overwrite user-owned files under `~/.mama/briefs/`; projection is in-memory only.
- Disabled private tools must be blocked even when an old role uses `allowedTools: ['*']`.
- No `any`, silent fallback data, or committed `TODO`/`FIXME` markers.

---

## File Structure

- Create `packages/standalone/src/connectors/private-connector-policy.ts`: single owner of private
  connector names, surface tool bundles, overlays, role projection, and policy fingerprint.
- Create `packages/standalone/tests/connectors/private-connector-policy.test.ts`: pure policy
  contracts.
- Create `packages/standalone/tests/cli/connector-command.test.ts`: public/private CLI discovery.
- Create `packages/standalone/tests/api/private-connector-api.test.ts`: status and route gating.
- Modify `packages/standalone/src/connectors/index.ts`: public/private/loadable catalog split.
- Modify `packages/standalone/src/cli/commands/connector.ts`: visible configured-private behavior.
- Modify `packages/standalone/src/cli/commands/start.ts`: one boot snapshot and projected lane grants.
- Modify `packages/standalone/src/cli/runtime/envelope-bootstrap.ts`: reuse the boot config result.
- Modify `packages/standalone/src/cli/runtime/connector-init.ts`: reuse the boot config result.
- Modify `packages/standalone/src/cli/runtime/api-server-init.ts` and
  `packages/standalone/src/api/index.ts`: API status consumes visible snapshot.
- Modify `packages/standalone/src/cli/runtime/api-routes-init.ts`: private API route registration.
- Modify `packages/standalone/src/cli/config/types.ts`: generic owner role only.
- Modify `packages/standalone/src/gateways/message-router.ts`: projected owner role, prompt, brief,
  and TG-05 fingerprint.
- Modify `packages/standalone/src/agent/tool-registry.ts`,
  `packages/standalone/src/agent/agent-loop.ts`, and
  `packages/standalone/src/multi-agent/agent-process-manager.ts`: source-neutral registry prose and
  policy-keyed runtime catalogs for every direct and Code-Act agent path.
- Modify `packages/standalone/src/agent/code-act/tool-policy.ts` and
  `packages/standalone/src/agent/gateway-tool-executor.ts`: fail-closed private-tool projection and
  execution checks for generic/wildcard roles, while keyed `/api/code-act` derives its principal
  only from the trusted run context.
- Modify `packages/standalone/src/envelope/reactive-config.ts`: configured-enabled private raw scope.
- Modify `packages/standalone/src/envelope/tool-connector-scope.ts` and
  `packages/standalone/src/envelope/enforcer.ts`: map and enforce all four Kagemusha readers, not
  only `kagemusha_messages`.
- Modify `packages/standalone/src/operator/console-brief.ts` and
  `packages/standalone/src/operator/briefs.ts`: generic defaults and in-memory legacy cleanup.
- Modify `packages/standalone/src/operator/worker-run.ts`,
  `packages/standalone/src/operator/situation-report.ts`, and relevant persona constants: generic
  procedure language.
- Modify `packages/standalone/scripts/generate-gateway-tools.ts` and generated
  `packages/standalone/src/agent/gateway-tools.md`: generic generated catalog.

### Task 1: Immutable private policy and catalog boundary

**Files:**

- Create: `packages/standalone/src/connectors/private-connector-policy.ts`
- Create: `packages/standalone/tests/connectors/private-connector-policy.test.ts`
- Modify: `packages/standalone/src/connectors/index.ts`
- Test: `packages/standalone/tests/connectors/config-loader.test.ts`

**Interfaces:**

- Consumes: `ConnectorConfigLoadResult`, `RoleConfig`, and gateway tool-name strings.
- Produces:

```ts
export type ConnectorCapabilitySurface =
  | 'owner_console'
  | 'os_agent'
  | 'legacy-unbound'
  | 'multi-agent-generic'
  | 'workorder-board'
  | 'workorder-memory-curation'
  | 'workorder-temporal'
  | 'operator-report';

export interface PrivateConnectorPolicy {
  readonly fingerprint: string;
  readonly configuredPrivateConnectors: readonly string[];
  readonly enabledPrivateConnectors: readonly string[];
  isConfigured(name: string): boolean;
  isEnabled(name: string): boolean;
  toolsFor(surface: ConnectorCapabilitySurface): readonly string[];
  toolDefinitionsFor(
    surface: ConnectorCapabilitySurface
  ): readonly PrivateConnectorToolDefinition[];
  projectRole(surface: ConnectorCapabilitySurface, role: RoleConfig): RoleConfig;
  promptOverlayFor(surface: ConnectorCapabilitySurface): string;
}

export interface PrivateConnectorToolDefinition {
  readonly name: GatewayToolName;
  readonly description: string;
  readonly category: 'business_data';
  readonly params?: string;
}

export function resolvePrivateConnectorPolicy(
  result: ConnectorConfigLoadResult
): PrivateConnectorPolicy;
export function visibleConnectorNames(configuredNames: readonly string[]): readonly string[];
export function resolvePrivatePrincipalSurface(
  context: Pick<GatewayToolExecutionContext, 'agentContext'>
): ConnectorCapabilitySurface;

export interface ProjectedToolPolicy {
  readonly allowedTools: readonly string[];
  readonly blockedTools: readonly string[];
}

export function projectPrivateToolPolicy(
  surface: ConnectorCapabilitySurface,
  role: Pick<RoleConfig, 'allowedTools' | 'blockedTools'>,
  policy: PrivateConnectorPolicy
): ProjectedToolPolicy;
```

`resolvePrivatePrincipalSurface()` uses this exact mapping: no `agentContext` becomes
`legacy-unbound`; `owner_console` and the four eligible internal role names map to their same-named
surface; a viewer context maps to `os_agent`; every other role maps to `multi-agent-generic`.
Caller-supplied API fields are not part of the input type.

`owner_console` and the four internal owner-operator lanes are eligible for the enabled bundle.
Code-Act is a transport, not a capability principal: a keyed run maps the registry-supplied trusted
`agentContext.roleName` to `owner_console`, `workorder-board`, `workorder-memory-curation`,
`workorder-temporal`, or `operator-report`. Missing/invalid-key legacy API runs map to
`legacy-unbound`; every other role maps to its generic surface. `os_agent`, `legacy-unbound`, and
`multi-agent-generic` are never eligible: projection adds all private tool names to `blockedTools`,
even when the input role contains `allowedTools: ['*']`. Every path must use the projection before
catalog generation and again before executor authorization.

- [ ] **Step 1: Write the failing public/private policy tests**

```ts
const connectorResult = (enabled: boolean): ConnectorConfigLoadResult => ({
  ok: true,
  config: {
    kagemusha: {
      enabled,
      pollIntervalMinutes: 60,
      channels: {},
      auth: { type: 'none' },
    },
  },
  enabledNames: enabled ? ['kagemusha'] : [],
});

it('keeps a fresh install free of private discovery and grants', () => {
  const policy = resolvePrivateConnectorPolicy({
    ok: true,
    config: Object.freeze(Object.create(null)),
    enabledNames: Object.freeze([]),
  });
  expect(AVAILABLE_CONNECTORS).not.toContain('kagemusha');
  expect(visibleConnectorNames([])).not.toContain('kagemusha');
  expect(policy.toolsFor('owner_console')).toEqual([]);
  expect(policy.promptOverlayFor('owner_console')).toBe('');
});

it('projects the configured private bundle and blocks stale wildcard grants when disabled', () => {
  const enabled = resolvePrivateConnectorPolicy(connectorResult(true));
  expect(enabled.toolsFor('owner_console')).toEqual([
    'kagemusha_overview',
    'kagemusha_entities',
    'kagemusha_tasks',
    'kagemusha_messages',
  ]);
  const disabled = resolvePrivateConnectorPolicy(connectorResult(false));
  const role = disabled.projectRole('owner_console', {
    ...DEFAULT_ROLES.definitions.owner_console!,
    allowedTools: ['*'],
  });
  expect(role.blockedTools).toEqual(expect.arrayContaining(enabled.toolsFor('owner_console')));
});

it.each(['os_agent', 'legacy-unbound', 'multi-agent-generic'] as const)(
  'blocks all private tools from the ineligible %s wildcard surface',
  (surface) => {
    const enabled = resolvePrivateConnectorPolicy(connectorResult(true));
    const projected = projectPrivateToolPolicy(surface, { allowedTools: ['*'] }, enabled);
    expect(projected.blockedTools).toEqual(
      expect.arrayContaining(enabled.toolsFor('owner_console'))
    );
  }
);
```

- [ ] **Step 2: Run the tests and confirm the missing policy/catalog split fails**

Run:

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/connectors/private-connector-policy.test.ts \
  tests/connectors/config-loader.test.ts
```

Expected: FAIL because the policy module and public/private catalog exports do not exist.

- [ ] **Step 3: Implement the immutable policy and catalog split**

```ts
export const AVAILABLE_CONNECTORS = [
  'slack',
  'telegram',
  'discord',
  'chatwork',
  'gmail',
  'calendar',
  'notion',
  'obsidian',
  'sheets',
  'trello',
  'drive',
  'imessage',
  'claude-code',
] as const;
export const PRIVATE_CONNECTORS = ['kagemusha'] as const;
export const LOADABLE_CONNECTORS = [...AVAILABLE_CONNECTORS, ...PRIVATE_CONNECTORS] as const;
```

In `private-connector-policy.ts`, keep every Kagemusha tool name, description, parameter hint, and
overlay literal inside the one module. `ToolRegistry` may register those exported structural
definitions for execution dispatch, but must not duplicate their text. Compute `fingerprint` from
canonical JSON containing configured/enabled private names and
surface bundles. `projectRole()` must clone arrays, add enabled tools, and add all disabled private
tools to `blockedTools` so wildcard grants fail closed. `projectPrivateToolPolicy()` applies the
same deny set to every ineligible surface regardless of configured state, so a private connector
never leaks into generic OS, unbound legacy Code-Act, or multi-agent roles.
`resolvePrivatePrincipalSurface()` derives keyed Code-Act capability only from the trusted registry
context; HTTP-supplied `agentId`, `allowedTools`, or `blockedTools` cannot upgrade the principal.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/connectors/private-connector-policy.test.ts \
  tests/connectors/config-loader.test.ts
pnpm --dir packages/standalone typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/standalone/src/connectors/index.ts \
  packages/standalone/src/connectors/private-connector-policy.ts \
  packages/standalone/tests/connectors/private-connector-policy.test.ts \
  packages/standalone/tests/connectors/config-loader.test.ts
git commit -m "feat(standalone): isolate private connector policy"
```

### Task 2: Public CLI and API discovery

**Files:**

- Modify: `packages/standalone/src/cli/commands/connector.ts`
- Modify: `packages/standalone/src/api/index.ts`
- Modify: `packages/standalone/src/cli/runtime/api-server-init.ts`
- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`
- Create: `packages/standalone/tests/cli/connector-command.test.ts`
- Create: `packages/standalone/tests/api/private-connector-api.test.ts`

**Interfaces:**

- Consumes: `visibleConnectorNames()`, `PrivateConnectorPolicy`, validated boot connector config.
- Produces: public-only `add` help; configured-private `list/remove/status`; conditional
  `/api/kagemusha/tasks` registration.
- Make the CLI path and output explicit test seams instead of capturing an import-time `homedir()`:

```ts
export interface ConnectorCommandOptions {
  configPath?: string;
  writeOut?: (line: string) => void;
  writeError?: (line: string) => void;
}

export function createConnectorCommand(options?: ConnectorCommandOptions): Command;

export interface KagemushaTaskQueryInput {
  sourceRoom?: string;
  status?: string;
  priority?: string;
  search?: string;
  limit?: number;
}

export type KagemushaTaskQuery = (input: KagemushaTaskQueryInput) => TaskInfo[];
export type KagemushaTaskQueryLoader = () => Promise<KagemushaTaskQuery>;

export function registerKagemushaTaskRoute(
  app: Express,
  policy: PrivateConnectorPolicy,
  loadQuery: KagemushaTaskQueryLoader = async () =>
    (await import('../../connectors/kagemusha/query-tools.js')).queryTasks
): void;
```

`createApiServer()` receives the already validated `ConnectorConfigLoadResult` and
`PrivateConnectorPolicy` through `ApiServerOptions`; it never rereads `~/.mama/connectors.json`.
The route helper accepts an async query-loader seam so an absent/disabled policy never imports the
module-global `~/.kagemusha/kagemusha.db`; tests inject a temp fixture loader.

- [ ] **Step 1: Add failing CLI tests**

```ts
async function runConnectorCommand(
  args: string[],
  configPath: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.exitCode = undefined;
  const command = createConnectorCommand({
    configPath,
    writeOut: (line) => stdout.push(line),
    writeError: (line) => stderr.push(line),
  });
  await command.parseAsync(args, { from: 'user' });
  const exitCode = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode };
}

it('does not advertise or add the private connector on a fresh install', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mama-connector-command-'));
  const configPath = join(tempDir, 'fresh-connectors.json');
  const result = await runConnectorCommand(['list'], configPath);
  expect(result.stdout).not.toContain('kagemusha');
  const add = await runConnectorCommand(['add', 'kagemusha'], configPath);
  expect(add.exitCode).toBe(1);
  expect(add.stderr).not.toContain('kagemusha,');
});

it('shows and removes an already configured private connector', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mama-connector-command-'));
  const configPath = join(tempDir, 'configured-connectors.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      kagemusha: {
        enabled: true,
        pollIntervalMinutes: 60,
        channels: {},
        auth: { type: 'none' },
      },
    })
  );
  expect((await runConnectorCommand(['list'], configPath)).stdout).toContain('kagemusha');
  expect((await runConnectorCommand(['remove', 'kagemusha'], configPath)).exitCode).toBe(0);
});
```

- [ ] **Step 2: Add failing API route/status tests**

```ts
const authHeader = 'Bearer test-auth-token';

it('returns no private catalog entry and 404s the private route when absent', async () => {
  process.env.MAMA_AUTH_TOKEN = 'test-auth-token';
  const policy = resolvePrivateConnectorPolicy({
    ok: true,
    config: {},
    enabledNames: [],
  });
  const server = createApiServer({
    scheduler: new CronScheduler(),
    port: 0,
    connectorConfigLoadResult: { ok: true, config: {}, enabledNames: [] },
    privateConnectorPolicy: policy,
  });
  registerKagemushaTaskRoute(server.app, policy, async () => () => []);
  expect(
    (await request(server.app).get('/api/connectors/status').set('Authorization', authHeader)).body
      .connectors
  ).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'kagemusha' })]));
  await request(server.app)
    .get('/api/kagemusha/tasks')
    .set('Authorization', authHeader)
    .expect(404);
});

it('registers the private route only for configured-enabled policy', async () => {
  process.env.MAMA_AUTH_TOKEN = 'test-auth-token';
  const loadResult: ConnectorConfigLoadResult = {
    ok: true,
    config: {
      kagemusha: {
        enabled: true,
        pollIntervalMinutes: 60,
        channels: {},
        auth: { type: 'none' },
      },
    },
    enabledNames: ['kagemusha'],
  };
  const policy = resolvePrivateConnectorPolicy(loadResult);
  const server = createApiServer({
    scheduler: new CronScheduler(),
    port: 0,
    connectorConfigLoadResult: loadResult,
    privateConnectorPolicy: policy,
  });
  registerKagemushaTaskRoute(server.app, policy, async () => () => []);
  await request(server.app)
    .get('/api/kagemusha/tasks')
    .set('Authorization', authHeader)
    .expect(200, { success: true, tasks: [], total: 0 });
});
```

- [ ] **Step 3: Run tests to observe unconditional discovery/route failures**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/cli/connector-command.test.ts \
  tests/api/private-connector-api.test.ts
```

Expected: FAIL because `AVAILABLE_CONNECTORS` and the private route are currently unconditional.

- [ ] **Step 4: Implement visibility rules and inject the boot policy into API builders**

Use public names for `add` validation and help. Use `visibleConnectorNames(Object.keys(config))`
for `list/status/remove`, while `remove` accepts a private name only if it already owns a local
config entry. Replace `api/index.ts`'s direct file read and empty catch with the validated snapshot
passed through `api-server-init.ts`. Wrap private route registration:

```ts
registerKagemushaTaskRoute(apiServer.app, privateConnectorPolicy);
```

- [ ] **Step 5: Re-run focused tests and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/cli/connector-command.test.ts \
  tests/api/private-connector-api.test.ts
git add packages/standalone/src/cli/commands/connector.ts \
  packages/standalone/src/api/index.ts \
  packages/standalone/src/cli/runtime/api-server-init.ts \
  packages/standalone/src/cli/runtime/api-routes-init.ts \
  packages/standalone/tests/cli/connector-command.test.ts \
  packages/standalone/tests/api/private-connector-api.test.ts
git commit -m "fix(standalone): hide private connector discovery"
```

### Task 3: One boot snapshot and dynamic role/lane projection

**Files:**

- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/src/cli/runtime/envelope-bootstrap.ts`
- Modify: `packages/standalone/src/cli/runtime/connector-init.ts`
- Modify: `packages/standalone/src/cli/config/types.ts`
- Modify: `packages/standalone/src/gateways/message-router.ts`
- Modify: `packages/standalone/src/agent/agent-loop.ts`
- Modify: `packages/standalone/src/agent/code-act/tool-policy.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/multi-agent/agent-process-manager.ts`
- Modify: `packages/standalone/src/envelope/reactive-config.ts`
- Modify: `packages/standalone/src/envelope/tool-connector-scope.ts`
- Modify: `packages/standalone/src/envelope/enforcer.ts`
- Test: `packages/standalone/tests/gateways/message-router.test.ts`
- Test: `packages/standalone/tests/gateways/tool-ad-coherence.test.ts`
- Test: `packages/standalone/tests/cli/code-act-policy.test.ts`
- Test: `packages/standalone/tests/cli/lane-wiring.test.ts`
- Test: `packages/standalone/tests/cli/runtime/envelope-bootstrap.test.ts`
- Test: `packages/standalone/tests/envelope/reactive-config.test.ts`
- Create: `packages/standalone/tests/envelope/tool-connector-scope.test.ts`
- Test: `packages/standalone/tests/envelope/enforcer.test.ts`
- Test: `packages/standalone/tests/agent/agent-loop.test.ts`
- Test: `packages/standalone/tests/agent/codex-app-server-process.test.ts`
- Test: `packages/standalone/tests/agent/gateway-tool-executor.test.ts`
- Test: `packages/standalone/tests/code-act/tool-policy.test.ts`
- Test: `packages/standalone/tests/cli/runtime/code-act-executor.test.ts`
- Test: `packages/standalone/tests/multi-agent/per-agent-tool-filtering.test.ts`

**Interfaces:**

- `buildRuntimeEnvelopeBootstrap(db, config, env, connectorConfigLoadResult)`.
- `initConnectors(extract, { connectorConfigLoadResult, nudge })`.
- `buildWorkOrderAgentPolicy(kind, model, backend, privateConnectorPolicy)`.
- `buildOperatorReportAgentPolicy(model, backend, privateConnectorPolicy)`.

This task owns the router dependency seam. Create and export it from `message-router.ts`; do not add
policy state to behavioral `MessageRouterConfig`:

```ts
export interface MessageRouterDependencies {
  privateConnectorPolicy?: PrivateConnectorPolicy;
}

constructor(
  sessionStore: SessionStore,
  agentLoop: AgentLoopClient,
  mamaApi: MamaApiClient,
  config: MessageRouterConfig = {},
  envelopeConfig?: ReactiveEnvelopeConfig,
  envelopeAuthority?: EnvelopeAuthority,
  dependencies: MessageRouterDependencies = {}
)
```

- [ ] **Step 1: Add failing projection and TG-05 fingerprint tests**

```ts
it('grants raw kagemusha scope only to an enabled verified owner', () => {
  const owner: NormalizedMessage = {
    source: 'telegram',
    channelId: 'owner-chat',
    userId: 'owner-id',
    text: 'status',
    metadata: { chatType: 'private' },
  };
  const config = makeConfig({
    telegram: { enabled: true, token: 'test-token', allowed_chats: ['owner-chat'] },
    roles: DEFAULT_ROLES,
  } as Partial<MAMAConfig>);
  expect(
    getReactiveRoutePolicy(owner, config, { HOME: '/tmp/mama-home' }, ['kagemusha']).rawConnectors
  ).toContain('kagemusha');
  expect(
    getReactiveRoutePolicy(owner, config, { HOME: '/tmp/mama-home' }, []).rawConnectors
  ).not.toContain('kagemusha');
});

it.each([
  'kagemusha_overview',
  'kagemusha_entities',
  'kagemusha_tasks',
  'kagemusha_messages',
] as const)('maps and denies %s without an enabled private raw scope', (tool) => {
  expect(directConnectorReadForTool(tool)).toBe('kagemusha');
  expect(() => new EnvelopeEnforcer().check(makeEnvelope(), tool, {})).toThrow(
    /connector_out_of_scope/
  );
});
```

Also assert board/memory/temporal/report policy builders add only their surface bundle and that the
disabled snapshot strips old explicit/wildcard grants. In `gateway-tool-executor.test.ts`,
`tool-policy.test.ts`, and `per-agent-tool-filtering.test.ts`, use both default and custom wildcard
roles and assert all four private tools are absent from advertisements and rejected at execution for
`os_agent`, unbound legacy `/api/code-act`, and generic multi-agent principals.

In `cli/runtime/code-act-executor.test.ts`, register trusted contexts for `owner_console` and
`operator-report` and assert their keyed calls preserve those eligible principal surfaces: enabled
policy admits the appropriate Kagemusha bundle and disabled policy rejects it. Also assert a missing
key takes the legacy path without a grant, an invalid key fails before gateway execution, and an
HTTP-supplied `agentId` cannot upgrade either path. This keeps Code-Act transport-neutral while
making the registry context the only authority.

- [ ] **Step 2: Add the full TG-05 durable-thread replacement tests**

In `message-router.test.ts`, construct two routers over the same real `SessionStore` and the same
capturing `AgentLoopClient`: first with a disabled policy, then with an enabled policy. Process the
same Telegram owner channel and assert the second call still requests `resumeSession: true`, has a
different `sessionPolicyFingerprint`, and supplies a `freshSessionSystemPrompt` rebuild callback
whose result contains the full enabled private definitions. Repeat enabled→disabled and assert the
callback rebuild contains no Kagemusha name, definition, or overlay. The router requests
continuation; it does not decide whether the backend thread is reusable.

In `agent-loop.test.ts`, exercise both disabled→enabled and enabled→disabled. Assert the actual
backend transition is `resumeSession: false` with the full rebuilt policy exactly once after a
fingerprint mismatch, followed by `resumeSession: true` and a minimal prompt on the next unchanged
turn. Extend `codex-app-server-process.test.ts` so the mismatch discards/replaces the old durable
thread, the replacement receives the full current policy once, and its next unchanged-policy turn
resumes the replacement minimally. These tests prove replacement at the layers that own it, not
merely unequal hashes.

- [ ] **Step 3: Run tests and confirm static grants/wildcard paths fail**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/gateways/message-router.test.ts \
  tests/gateways/tool-ad-coherence.test.ts \
  tests/cli/code-act-policy.test.ts \
  tests/cli/lane-wiring.test.ts \
  tests/cli/runtime/envelope-bootstrap.test.ts \
  tests/envelope/reactive-config.test.ts \
  tests/envelope/tool-connector-scope.test.ts \
  tests/envelope/enforcer.test.ts \
  tests/agent/agent-loop.test.ts \
  tests/agent/codex-app-server-process.test.ts \
  tests/agent/gateway-tool-executor.test.ts \
  tests/code-act/tool-policy.test.ts \
  tests/multi-agent/per-agent-tool-filtering.test.ts
```

- [ ] **Step 4: Reuse one validated config load across boot surfaces**

At the start of `runAgentLoop`, call `loadConnectorConfig()` once, log its error once, build the
private policy, and pass both objects to envelope bootstrap, connector initialization, router,
API assembly, and lane policy builders. Do not derive private visibility from
`connectorRegistry.getActive()` because initialization failure must stay visible and loud.

- [ ] **Step 5: Remove static private grants and project every runtime role**

Remove Kagemusha from `DEFAULT_ROLES.owner_console`, `WORKORDER_TOOL_POLICIES`, and
`OPERATOR_REPORT_TOOL_POLICY`. In `MessageRouter.createAgentContext`, project the resolved
`owner_console` role before deriving capabilities. Include `privateConnectorPolicy.fingerprint`
and projected brief text in the stable policy fingerprint. Apply `projectPrivateToolPolicy()` to
the default `os_agent`, unbound legacy `/api/code-act`, multi-agent prompt/Code-Act paths, and the
executor's final authorization check. For keyed Code-Act, derive the eligible or generic surface
from the registry-supplied `agentContext`; never from HTTP request fields. Map all four Kagemusha
readers to the `kagemusha` connector scope so envelope authorization cannot be bypassed by calling
overview/entities/tasks instead of messages.

- [ ] **Step 6: Re-run projection tests, typecheck, and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/gateways/message-router.test.ts \
  tests/gateways/tool-ad-coherence.test.ts \
  tests/cli/code-act-policy.test.ts \
  tests/cli/lane-wiring.test.ts \
  tests/cli/runtime/envelope-bootstrap.test.ts \
  tests/envelope/reactive-config.test.ts \
  tests/envelope/tool-connector-scope.test.ts \
  tests/envelope/enforcer.test.ts \
  tests/agent/agent-loop.test.ts \
  tests/agent/codex-app-server-process.test.ts \
  tests/agent/gateway-tool-executor.test.ts \
  tests/code-act/tool-policy.test.ts \
  tests/cli/runtime/code-act-executor.test.ts \
  tests/multi-agent/per-agent-tool-filtering.test.ts
pnpm --dir packages/standalone typecheck
git add packages/standalone/src/cli/commands/start.ts \
  packages/standalone/src/cli/runtime/envelope-bootstrap.ts \
  packages/standalone/src/cli/runtime/connector-init.ts \
  packages/standalone/src/cli/config/types.ts \
  packages/standalone/src/gateways/message-router.ts \
  packages/standalone/src/agent/agent-loop.ts \
  packages/standalone/src/agent/code-act/tool-policy.ts \
  packages/standalone/src/agent/gateway-tool-executor.ts \
  packages/standalone/src/multi-agent/agent-process-manager.ts \
  packages/standalone/src/envelope/reactive-config.ts \
  packages/standalone/src/envelope/tool-connector-scope.ts \
  packages/standalone/src/envelope/enforcer.ts \
  packages/standalone/tests/gateways/message-router.test.ts \
  packages/standalone/tests/gateways/tool-ad-coherence.test.ts \
  packages/standalone/tests/cli/code-act-policy.test.ts \
  packages/standalone/tests/cli/lane-wiring.test.ts \
  packages/standalone/tests/cli/runtime/envelope-bootstrap.test.ts \
  packages/standalone/tests/envelope/reactive-config.test.ts \
  packages/standalone/tests/envelope/tool-connector-scope.test.ts \
  packages/standalone/tests/envelope/enforcer.test.ts \
  packages/standalone/tests/agent/agent-loop.test.ts \
  packages/standalone/tests/agent/codex-app-server-process.test.ts \
  packages/standalone/tests/agent/gateway-tool-executor.test.ts \
  packages/standalone/tests/code-act/tool-policy.test.ts \
  packages/standalone/tests/cli/runtime/code-act-executor.test.ts \
  packages/standalone/tests/multi-agent/per-agent-tool-filtering.test.ts
git commit -m "feat(standalone): project private connector capabilities"
```

### Task 4: Generic prompts and in-memory brief overlays

**Files:**

- Create: `packages/standalone/src/agent/gateway-tool-catalog.ts`
- Modify: `packages/standalone/src/agent/tool-registry.ts`
- Modify: `packages/standalone/src/agent/agent-loop.ts`
- Modify: `packages/standalone/src/gateways/message-router.ts`
- Modify: `packages/standalone/src/multi-agent/agent-process-manager.ts`
- Modify: `packages/standalone/src/operator/console-brief.ts`
- Modify: `packages/standalone/src/operator/briefs.ts`
- Modify: `packages/standalone/src/operator/worker-run.ts`
- Modify: `packages/standalone/src/operator/temporal-worker.ts`
- Modify: `packages/standalone/src/operator/board-slot-instructions.ts`
- Modify: `packages/standalone/src/operator/situation-report.ts`
- Modify: `packages/standalone/src/multi-agent/dashboard-agent-persona.ts`
- Modify: `packages/standalone/src/multi-agent/memory-agent-persona.ts`
- Modify: `packages/standalone/src/multi-agent/wiki-agent-persona.ts`
- Modify: `packages/standalone/scripts/generate-gateway-tools.ts`
- Modify: `packages/standalone/src/agent/gateway-tools.md`
- Test: `packages/standalone/tests/operator/console-brief.test.ts`
- Test: `packages/standalone/tests/operator/briefs.test.ts`
- Test: `packages/standalone/tests/operator/worker-run.test.ts`
- Test: `packages/standalone/tests/operator/situation-report.test.ts`
- Test: `packages/standalone/tests/agent/gateway-tools-generation.test.ts`
- Create: `packages/standalone/tests/agent/gateway-tool-catalog.test.ts`
- Test: `packages/standalone/tests/agent/agent-loop.test.ts`
- Test: `packages/standalone/tests/gateways/tool-ad-coherence.test.ts`
- Test: `packages/standalone/tests/multi-agent/per-agent-tool-filtering.test.ts`

**Interfaces:**

```ts
export function projectConsoleBriefForPrompt(raw: string, policy: PrivateConnectorPolicy): string;
export function projectWorkOrderBriefForPrompt(
  kind: WorkOrderKind,
  raw: string,
  policy: PrivateConnectorPolicy
): string;

export interface GatewayToolCatalogInput {
  surface: ConnectorCapabilitySurface;
  allowedTools?: readonly string[];
  blockedTools?: readonly string[];
  privateConnectorPolicy: PrivateConnectorPolicy;
}

export interface GatewayToolCatalog {
  cacheKey: string;
  toolNames: readonly string[];
  prompt: string;
}

export function buildGatewayToolCatalog(input: GatewayToolCatalogInput): GatewayToolCatalog;
```

`buildGatewayToolCatalog()` expands wildcards through `ToolRegistry`, applies
`projectPrivateToolPolicy()`, filters blocked patterns, and calls `ToolRegistry.generatePrompt()`
with the final exact names. Its cache key is canonical JSON of surface, sorted allowed/blocked
patterns, and `privateConnectorPolicy.fingerprint`. `message-router.ts`, `agent-loop.ts`, and both
normal/Code-Act branches of `agent-process-manager.ts` consume this one result; no caller appends an
unkeyed private string to a cached public catalog.

- [ ] **Step 1: Add failing generic-default and non-mutating projection tests**

```ts
it('keeps packaged defaults source-neutral', () => {
  expect(CONSOLE_BRIEF_DEFAULT.toLowerCase()).not.toContain('kagemusha');
  for (const kind of WORKORDER_KINDS) {
    expect(buildDefaultBrief(kind).toLowerCase()).not.toContain('kagemusha');
  }
});

it('hides legacy managed text without changing the user file', () => {
  const raw = '# Owner Console Operating Brief\n\n## Lessons\n- Use kagemusha_tasks first.\n';
  ensureConsoleBrief(home);
  writeFileSync(consoleBriefPath(home), raw);
  const policy = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });
  const projected = projectConsoleBriefForPrompt(raw, policy);
  expect(projected).not.toContain('kagemusha_tasks');
  expect(loadConsoleBrief(home)).toBe(raw);
});

it('appends the enabled overlay exactly once', () => {
  const loadResult: ConnectorConfigLoadResult = {
    ok: true,
    config: {
      kagemusha: {
        enabled: true,
        pollIntervalMinutes: 60,
        channels: {},
        auth: { type: 'none' },
      },
    },
    enabledNames: ['kagemusha'],
  };
  const policy = resolvePrivateConnectorPolicy(loadResult);
  const projected = projectWorkOrderBriefForPrompt('board', '# Board brief\n', policy);
  expect(projected.match(/kagemusha_tasks/g)).toHaveLength(1);
});

it('builds and caches catalogs from final projected names', () => {
  const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });
  const generic = buildGatewayToolCatalog({
    surface: 'multi-agent-generic',
    allowedTools: ['*'],
    privateConnectorPolicy: disabled,
  });
  expect(generic.prompt.toLowerCase()).not.toContain('kagemusha');
  expect(generic.toolNames).not.toContain('kagemusha_tasks');
  expect(generic.cacheKey).toContain(disabled.fingerprint);
});
```

- [ ] **Step 2: Run the prompt suites and observe hard-coded private text**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/console-brief.test.ts \
  tests/operator/briefs.test.ts \
  tests/operator/worker-run.test.ts \
  tests/operator/situation-report.test.ts \
  tests/agent/gateway-tools-generation.test.ts
```

- [ ] **Step 3: Make packaged prompts generic and add projection helpers**

Remove source-specific recipes and canonicity prose from defaults/personas. Replace the static
`situation-report.ts` tool-call example with `task_list`. Strip only enumerated legacy managed
blocks; in `## Lessons`, suppress individual lines that name a disabled private connector. Append
the current policy overlay at prompt-read time, never on disk. Remove Kagemusha names from generic
`mama_search`, `mama_recall`, `task_list`, and other `ToolRegistry` descriptions as well as from
persona/default prose.

- [ ] **Step 4: Generate a public gateway catalog and inject private definitions at runtime**

Have `generate-gateway-tools.ts` call `buildGatewayToolCatalog()` with a disabled generic policy so
the checked-in file is public-only. At runtime every direct and Code-Act caller uses the same
policy-keyed builder with its exact surface/role; an eligible enabled surface receives its private
definitions in the returned prompt, while generic/wildcard callers cannot advertise them. Assert a
policy change produces a different cache key and never reuses the prior prompt.

- [ ] **Step 5: Run focused suites, search the generic surfaces, and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/console-brief.test.ts \
  tests/operator/briefs.test.ts \
  tests/operator/worker-run.test.ts \
  tests/operator/situation-report.test.ts \
  tests/agent/gateway-tools-generation.test.ts \
  tests/agent/gateway-tool-catalog.test.ts \
  tests/agent/agent-loop.test.ts \
  tests/gateways/tool-ad-coherence.test.ts \
  tests/multi-agent/per-agent-tool-filtering.test.ts
rg -n "kagemusha" \
  packages/standalone/src/operator/console-brief.ts \
  packages/standalone/src/operator/briefs.ts \
  packages/standalone/src/operator/worker-run.ts \
  packages/standalone/src/operator/situation-report.ts \
  packages/standalone/src/multi-agent/*persona.ts \
  packages/standalone/src/agent/gateway-tools.md
```

Expected: any remaining match is an explicit legacy-removal pattern or private policy reference,
not a generic prompt/catalog instruction.

```bash
git add packages/standalone/src/operator/console-brief.ts \
  packages/standalone/src/agent/gateway-tool-catalog.ts \
  packages/standalone/src/agent/tool-registry.ts \
  packages/standalone/src/agent/agent-loop.ts \
  packages/standalone/src/gateways/message-router.ts \
  packages/standalone/src/multi-agent/agent-process-manager.ts \
  packages/standalone/src/operator/briefs.ts \
  packages/standalone/src/operator/worker-run.ts \
  packages/standalone/src/operator/temporal-worker.ts \
  packages/standalone/src/operator/board-slot-instructions.ts \
  packages/standalone/src/operator/situation-report.ts \
  packages/standalone/src/multi-agent/dashboard-agent-persona.ts \
  packages/standalone/src/multi-agent/memory-agent-persona.ts \
  packages/standalone/src/multi-agent/wiki-agent-persona.ts \
  packages/standalone/scripts/generate-gateway-tools.ts \
  packages/standalone/src/agent/gateway-tools.md \
  packages/standalone/tests/operator/console-brief.test.ts \
  packages/standalone/tests/operator/briefs.test.ts \
  packages/standalone/tests/operator/worker-run.test.ts \
  packages/standalone/tests/operator/situation-report.test.ts \
  packages/standalone/tests/agent/gateway-tools-generation.test.ts \
  packages/standalone/tests/agent/gateway-tool-catalog.test.ts \
  packages/standalone/tests/agent/agent-loop.test.ts \
  packages/standalone/tests/gateways/tool-ad-coherence.test.ts \
  packages/standalone/tests/multi-agent/per-agent-tool-filtering.test.ts
git commit -m "fix(standalone): remove private connector from generic prompts"
```

### Task 5: Private-isolation verification checkpoint

**Files:**

- Test: all files listed above.

- [ ] **Step 1: Run the complete private-isolation suite**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/connectors/private-connector-policy.test.ts \
  tests/connectors/config-loader.test.ts \
  tests/cli/connector-command.test.ts \
  tests/api/private-connector-api.test.ts \
  tests/gateways/tool-ad-coherence.test.ts \
  tests/gateways/message-router.test.ts \
  tests/cli/code-act-policy.test.ts \
  tests/cli/lane-wiring.test.ts \
  tests/cli/runtime/envelope-bootstrap.test.ts \
  tests/envelope/reactive-config.test.ts \
  tests/operator/briefs.test.ts \
  tests/operator/console-brief.test.ts \
  tests/operator/worker-run.test.ts \
  tests/operator/situation-report.test.ts \
  tests/agent/gateway-tools-generation.test.ts \
  tests/agent/gateway-tool-catalog.test.ts \
  tests/agent/agent-loop.test.ts \
  tests/agent/codex-app-server-process.test.ts \
  tests/agent/gateway-tool-executor.test.ts \
  tests/code-act/tool-policy.test.ts \
  tests/multi-agent/per-agent-tool-filtering.test.ts \
  tests/envelope/tool-connector-scope.test.ts \
  tests/envelope/enforcer.test.ts
pnpm --dir packages/standalone typecheck
pnpm --dir packages/standalone build
pnpm --dir packages/standalone test
pnpm test
pnpm build
git diff --exit-code -- packages/standalone/src/agent/gateway-tools.md
```

- [ ] **Step 2: Confirm the checkpoint introduced no uncommitted files**

```bash
git status --short
```

Expected: no output. If verification exposed a defect, return to the owning task, add a failing
test, patch it, and commit the exact files there before repeating this checkpoint.
