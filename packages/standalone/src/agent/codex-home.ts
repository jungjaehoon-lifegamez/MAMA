import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'node:crypto';

type McpServerConfig = {
  command?: unknown;
  args?: unknown;
  env?: unknown;
};

type UnknownRecord = Record<string, unknown>;

export interface CodexAppServerLaunchConfig {
  args: string[];
  env: Record<string, string | undefined>;
  fingerprint: string;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const AUTH_MODES = new Set(['oauth', 'chatgpt']);
const APPROVAL_MODES = new Set(['auto', 'prompt', 'writes', 'approve']);
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ROOT_FIELDS = new Set(['mcpServers', '_installedBy']);
const SERVER_FIELDS = new Set([
  'command',
  'args',
  'env',
  'env_vars',
  'cwd',
  'experimental_environment',
  'url',
  'auth',
  'bearer_token_env_var',
  'http_headers',
  'env_http_headers',
  'required',
  'supports_parallel_tool_calls',
  'environment_id',
  'startup_timeout_sec',
  'startup_timeout_ms',
  'tool_timeout_sec',
  'tool_timeout_ms',
  'enabled',
  'enabled_tools',
  'disabled_tools',
  'allowed_tools',
  'denied_tools',
  'default_tools_approval_mode',
  'tools',
  'scopes',
  'oauth_resource',
  '_installedBy',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value: UnknownRecord, allowed: Set<string>, location: string): void {
  for (const key of Object.keys(value)) {
    validateTomlString(key, `${location} field name`);
    if (!allowed.has(key)) {
      throw new Error(`Unsupported field ${location}.${key}`);
    }
  }
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  validateTomlString(value, location);
  return value;
}

function validateUnicodeScalarString(value: string, location: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new Error(`${location} must contain only Unicode scalar values`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${location} must contain only Unicode scalar values`);
    }
  }
}

function validateTomlString(value: string, location: string): void {
  validateUnicodeScalarString(value, location);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      throw new Error(`${location} must not contain TOML control characters`);
    }
  }
}

function validateChildEnvValue(value: string, location: string): void {
  validateUnicodeScalarString(value, location);
  if (value.includes('\0')) {
    throw new Error(`${location} must not contain NUL`);
  }
}

function validateHttpHeaderValue(value: string, location: string): void {
  validateUnicodeScalarString(value, location);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if ((codeUnit <= 0x1f && codeUnit !== 0x09) || codeUnit === 0x7f) {
      throw new Error(`${location} contains an invalid HTTP header value`);
    }
  }
}

function optionalString(value: unknown, location: string): string | undefined {
  return value === undefined ? undefined : requireString(value, location);
}

function optionalBoolean(value: unknown, location: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${location} must be a boolean`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown, location: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${location} must be a positive finite number`);
  }
  return value;
}

function optionalStringArray(value: unknown, location: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${location} must be an array of strings`);
  }
  return value.map((entry, index) => {
    validateTomlString(entry, `${location}[${index}]`);
    return entry;
  });
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function optionalStringSet(value: unknown, location: string): string[] | undefined {
  const entries = optionalStringArray(value, location);
  return entries === undefined ? undefined : [...new Set(entries)].sort(codeUnitCompare);
}

function requireEnum(value: unknown, allowed: Set<string>, location: string): string {
  const result = requireString(value, location);
  if (!allowed.has(result)) {
    throw new Error(`${location} has an unsupported value`);
  }
  return result;
}

function stringRecord(
  value: unknown,
  location: string,
  validateValue: (entry: string, entryLocation: string) => void = validateTomlString
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(value).sort()) {
    validateTomlString(key, `${location} key`);
    const entry = value[key];
    if (typeof entry !== 'string') {
      throw new Error(`${location}.${key} must be a string`);
    }
    validateValue(entry, `${location}.${key}`);
    result[key] = entry;
  }
  return result;
}

function validateEnvName(name: string, location: string): void {
  validateUnicodeScalarString(name, location);
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new Error(`${location} contains invalid environment name ${name}`);
  }
}

function validateHeaderName(name: string, location: string): void {
  validateUnicodeScalarString(name, location);
  if (!HTTP_HEADER_NAME_PATTERN.test(name)) {
    throw new Error(`${location} contains an invalid HTTP header name`);
  }
}

function validateHttpUrl(value: string, location: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${location} must be a valid HTTP URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${location} must use http or https`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`${location} must not contain user information`);
  }
  if (value.includes('?')) {
    throw new Error(`${location} must not contain a query; use environment-backed authentication`);
  }
  if (value.includes('#')) {
    throw new Error(`${location} must not contain a fragment`);
  }
  return value;
}

function tomlBooleanOrNumber(value: boolean | number): string {
  return String(value);
}

function tomlInlineApprovalTable(value: unknown, location: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }
  const entries: string[] = [];
  for (const toolName of Object.keys(value).sort()) {
    validateTomlString(toolName, `${location} tool name`);
    if (!SERVER_NAME_PATTERN.test(toolName)) {
      throw new Error(`${location} contains invalid tool name ${toolName}`);
    }
    const tool = value[toolName];
    if (!isRecord(tool)) {
      throw new Error(`${location}.${toolName} must be an object`);
    }
    rejectUnknownFields(tool, new Set(['approval_mode']), `${location}.${toolName}`);
    const approvalMode = requireEnum(
      tool.approval_mode,
      APPROVAL_MODES,
      `${location}.${toolName}.approval_mode`
    );
    entries.push(`${tomlString(toolName)} = { approval_mode = ${tomlString(approvalMode)} }`);
  }
  return `{ ${entries.join(', ')} }`;
}

function normalizedApprovalTools(value: unknown, location: string): UnknownRecord | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }
  const result: UnknownRecord = Object.create(null) as UnknownRecord;
  for (const toolName of Object.keys(value).sort()) {
    const tool = value[toolName];
    if (!isRecord(tool)) {
      throw new Error(`${location}.${toolName} must be an object`);
    }
    const normalizedTool: UnknownRecord = Object.create(null) as UnknownRecord;
    normalizedTool.approval_mode = requireEnum(
      tool.approval_mode,
      APPROVAL_MODES,
      `${location}.${toolName}.approval_mode`
    );
    result[toolName] = normalizedTool;
  }
  return result;
}

function addOverride(args: string[], path: string, value: string): void {
  args.push('-c', `${path}=${value}`);
}

function consolidateMcpOverrides(overrides: string[]): string[] {
  if (overrides.length === 0) {
    return [];
  }
  const servers = new Map<string, Array<[string, string]>>();
  for (let index = 1; index < overrides.length; index += 2) {
    const assignment = overrides[index];
    const separator = assignment.indexOf('=');
    const path = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    const prefix = 'mcp_servers.';
    const fieldSeparator = path.lastIndexOf('.');
    const name = JSON.parse(path.slice(prefix.length, fieldSeparator)) as unknown;
    if (typeof name !== 'string') {
      throw new Error('Internal MCP override name must be a string');
    }
    const fields = servers.get(name) ?? [];
    fields.push([path.slice(fieldSeparator + 1), value]);
    servers.set(name, fields);
  }
  const entries = [...servers.entries()].map(([name, fields]) => {
    const serialized = fields.map(([field, value]) => `${field} = ${value}`).join(', ');
    return `${tomlString(name)} = { ${serialized} }`;
  });
  return ['-c', `mcp_servers={ ${entries.join(', ')} }`];
}

function registerUserBinding(
  userBindings: Set<string>,
  generatedBindings: Map<string, string>,
  name: string
): void {
  if (generatedBindings.has(name)) {
    throw new Error(`Environment binding ${name} collides with a generated secret source`);
  }
  userBindings.add(name);
}

function reserveGeneratedBinding(
  env: Readonly<Record<string, string | undefined>>,
  userBindings: Set<string>,
  generatedBindings: Map<string, string>,
  name: string,
  origin: string
): void {
  const existing = generatedBindings.get(name);
  if (existing !== undefined && existing !== origin) {
    throw new Error(`Generated secret source ${name} has conflicting origins`);
  }
  if (existing === origin) {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(env, name) || userBindings.has(name)) {
    throw new Error(`Generated secret source ${name} collides with a user environment binding`);
  }
  generatedBindings.set(name, origin);
}

function setChildSecret(
  env: Record<string, string | undefined>,
  name: string,
  value: string,
  configuredNames: Map<string, string>
): void {
  const configured = configuredNames.get(name);
  if (configured !== undefined && configured !== value) {
    throw new Error(`Conflicting values configured for environment name ${name}`);
  }
  const inherited = env[name];
  if (inherited !== undefined && inherited !== value) {
    throw new Error(`Configured value conflicts with inherited environment name ${name}`);
  }
  configuredNames.set(name, value);
  env[name] = value;
}

function generatedHeaderEnvName(serverName: string, headerName: string): string {
  const server = serverName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const header = headerName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const suffix = createHash('sha256')
    .update(`${serverName}\0${headerName}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `MAMA_MCP_${server}_HTTP_HEADER_${header}_${suffix}`;
}

function fingerprintPolicy(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tomlString(value: string): string {
  validateTomlString(value, 'TOML string');
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlInlineStringTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => {
    validateTomlString(key, 'TOML table key');
    return `${key} = ${tomlString(value)}`;
  });
  return `{ ${entries.join(', ')} }`;
}

function tomlInlineQuotedStringTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`
  );
  return `{ ${entries.join(', ')} }`;
}

function mcpServersToml(mcpConfigPath: string | undefined): string[] {
  if (!mcpConfigPath || !existsSync(mcpConfigPath)) {
    return [];
  }

  const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as {
    mcpServers?: Record<string, McpServerConfig>;
  };
  const servers = parsed.mcpServers ?? {};
  const lines: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (name === 'mama') {
      continue;
    }
    if (typeof server.command !== 'string') {
      continue;
    }
    const args = Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const env: Record<string, string> = Object.create(null) as Record<string, string>;
    if (server.env && typeof server.env === 'object' && !Array.isArray(server.env)) {
      for (const [name, value] of Object.entries(server.env as Record<string, unknown>)) {
        if (typeof value === 'string') {
          env[name] = value;
        }
      }
    }

    lines.push('', `[mcp_servers.${tomlString(name)}]`, `command = ${tomlString(server.command)}`);
    if (args.length > 0) {
      lines.push(`args = ${tomlStringArray(args)}`);
    }
    if (Object.keys(env).length > 0) {
      lines.push(`env = ${tomlInlineStringTable(env)}`);
    }
  }
  return lines;
}

export function buildMAMACodexConfig(mcpConfigPath?: string): string {
  return [
    'approval_policy = "never"',
    'model_reasoning_effort = "high"',
    'skip_git_repo_check = true',
    '',
    '# MAMA standalone uses GatewayToolExecutor/code_act for mama_* tools.',
    '# Intentionally do not expose a direct mama MCP server here, otherwise Codex',
    '# can bypass the agent loop and call server=mama tools directly.',
    ...mcpServersToml(mcpConfigPath),
  ].join('\n');
}

export function buildMAMACodexAppServerConfig(): string {
  return [
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    'model_reasoning_effort = "high"',
    'instructions = ""',
    'developer_instructions = ""',
    'include_apps_instructions = false',
    'include_environment_context = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    'plugins = false',
    'apps = false',
    'tool_search = false',
    'shell_tool = false',
    'unified_exec = false',
    'web_search = false',
    'browser_use = false',
    'computer_use = false',
    'image_generation = false',
    '',
    '# MAMA standalone owns identity, skills, memory tools, and evidence gates.',
    '# App-server is isolated under the managed MAMA home.',
    '# Runner-specific MCP servers are supplied per process and never written here.',
  ].join('\n');
}

export function buildCodexAppServerLaunchConfig(
  mcpConfigPath: string | undefined,
  processEnv: Readonly<Record<string, string | undefined>>
): CodexAppServerLaunchConfig {
  const childEnv: Record<string, string | undefined> = Object.create(null) as Record<
    string,
    string | undefined
  >;
  for (const [name, value] of Object.entries(processEnv)) {
    childEnv[name] = value;
  }
  if (mcpConfigPath === undefined) {
    return { args: [], env: childEnv, fingerprint: fingerprintPolicy({}) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as unknown;
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : 'unreadable file';
    throw new Error(`MCP config is ${reason}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('MCP config root must be an object');
  }
  rejectUnknownFields(parsed, ROOT_FIELDS, 'root');
  if (!isRecord(parsed.mcpServers)) {
    throw new Error('root.mcpServers must be an object');
  }
  const mcpServers: UnknownRecord = parsed.mcpServers;

  const args: string[] = [];
  const configuredNames = new Map<string, string>();
  const userBindings = new Set<string>();
  const generatedBindings = new Map<string, string>();
  const normalizedServers: UnknownRecord = Object.create(null) as UnknownRecord;

  for (const name of Object.keys(mcpServers).sort()) {
    validateTomlString(name, 'MCP server name');
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid MCP server name ${name}`);
    }
    const raw: unknown = mcpServers[name];
    if (!isRecord(raw)) {
      throw new Error(`mcpServers.${name} must be an object`);
    }
    rejectUnknownFields(raw, SERVER_FIELDS, `mcpServers.${name}`);
    // MAMA and legacy code-act are owned by the canonical native host bridge.
    // Passing either server to app-server would create an unprojected bypass
    // around role, runtime, tier, and envelope enforcement.
    if (name === 'mama' || name === 'code-act') {
      continue;
    }

    const location = `mcpServers.${name}`;
    const command = optionalString(raw.command, `${location}.command`);
    const rawUrl = optionalString(raw.url, `${location}.url`);
    const url = rawUrl === undefined ? undefined : validateHttpUrl(rawUrl, `${location}.url`);
    if ((command === undefined) === (url === undefined)) {
      throw new Error(`${location} must configure exactly one of command or url`);
    }
    const base = `mcp_servers.${tomlString(name)}`;
    const normalized: UnknownRecord = Object.create(null) as UnknownRecord;
    normalized.transport = command === undefined ? 'http' : 'stdio';

    if (command !== undefined) {
      addOverride(args, `${base}.command`, tomlString(command));
      normalized.command = command;
    } else if (url !== undefined) {
      addOverride(args, `${base}.url`, tomlString(url));
      normalized.url = url;
    }

    const serverArgs = optionalStringArray(raw.args, `${location}.args`);
    if (serverArgs !== undefined) {
      if (command === undefined) {
        throw new Error(`${location}.args is only valid for stdio servers`);
      }
      addOverride(args, `${base}.args`, tomlStringArray(serverArgs));
      normalized.args = serverArgs;
    }

    const literalEnv = stringRecord(raw.env, `${location}.env`, validateChildEnvValue);
    const inheritedEnvNames = optionalStringArray(raw.env_vars, `${location}.env_vars`);
    if ((literalEnv !== undefined || inheritedEnvNames !== undefined) && command === undefined) {
      throw new Error(`${location}.env and env_vars are only valid for stdio servers`);
    }
    const allEnvNames = new Set<string>();
    for (const envName of inheritedEnvNames ?? []) {
      validateEnvName(envName, `${location}.env_vars`);
      registerUserBinding(userBindings, generatedBindings, envName);
      allEnvNames.add(envName);
    }
    for (const [envName, value] of Object.entries(literalEnv ?? {})) {
      validateEnvName(envName, `${location}.env`);
      registerUserBinding(userBindings, generatedBindings, envName);
      setChildSecret(childEnv, envName, value, configuredNames);
      allEnvNames.add(envName);
    }
    if (allEnvNames.size > 0) {
      const envNames = [...allEnvNames].sort();
      addOverride(args, `${base}.env_vars`, tomlStringArray(envNames));
      normalized.env_vars = envNames;
    }

    const cwd = optionalString(raw.cwd, `${location}.cwd`);
    if (cwd !== undefined) {
      if (command === undefined) {
        throw new Error(`${location}.cwd is only valid for stdio servers`);
      }
      addOverride(args, `${base}.cwd`, tomlString(cwd));
      normalized.cwd = cwd;
    }
    const experimentalEnvironment = optionalString(
      raw.experimental_environment,
      `${location}.experimental_environment`
    );
    if (experimentalEnvironment !== undefined && command === undefined) {
      throw new Error(`${location}.experimental_environment is only valid for stdio servers`);
    }
    const environmentId = optionalString(raw.environment_id, `${location}.environment_id`);
    if (experimentalEnvironment !== undefined && environmentId !== undefined) {
      throw new Error(`${location} cannot set both experimental_environment and environment_id`);
    }
    const effectiveEnvironmentId = environmentId ?? experimentalEnvironment;
    if (effectiveEnvironmentId !== undefined) {
      addOverride(args, `${base}.environment_id`, tomlString(effectiveEnvironmentId));
      normalized.environment_id = effectiveEnvironmentId;
    }

    const auth =
      raw.auth === undefined ? undefined : requireEnum(raw.auth, AUTH_MODES, `${location}.auth`);
    if (auth !== undefined) {
      if (url === undefined) {
        throw new Error(`${location}.auth is only valid for HTTP servers`);
      }
      addOverride(args, `${base}.auth`, tomlString(auth));
      normalized.auth = auth;
    }
    const bearerTokenEnvVar = optionalString(
      raw.bearer_token_env_var,
      `${location}.bearer_token_env_var`
    );
    if (bearerTokenEnvVar !== undefined) {
      if (url === undefined) {
        throw new Error(`${location}.bearer_token_env_var is only valid for HTTP servers`);
      }
      validateEnvName(bearerTokenEnvVar, `${location}.bearer_token_env_var`);
      registerUserBinding(userBindings, generatedBindings, bearerTokenEnvVar);
      addOverride(args, `${base}.bearer_token_env_var`, tomlString(bearerTokenEnvVar));
      normalized.bearer_token_env_var = bearerTokenEnvVar;
    }

    const literalHeaders = stringRecord(
      raw.http_headers,
      `${location}.http_headers`,
      validateHttpHeaderValue
    );
    const envHeaders: Record<string, string> =
      stringRecord(raw.env_http_headers, `${location}.env_http_headers`) ?? {};
    if ((literalHeaders !== undefined || Object.keys(envHeaders).length > 0) && url === undefined) {
      throw new Error(`${location} HTTP headers are only valid for HTTP servers`);
    }
    const effectiveHeaderBindings: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [headerName, envName] of Object.entries(envHeaders)) {
      validateHeaderName(headerName, `${location}.env_http_headers`);
      validateEnvName(envName, `${location}.env_http_headers.${headerName}`);
      const canonicalHeader = headerName.toLowerCase();
      if (effectiveHeaderBindings[canonicalHeader] !== undefined) {
        throw new Error(`${location} configures header ${canonicalHeader} more than once`);
      }
      registerUserBinding(userBindings, generatedBindings, envName);
      effectiveHeaderBindings[canonicalHeader] = envName;
    }
    for (const [headerName, value] of Object.entries(literalHeaders ?? {})) {
      validateHeaderName(headerName, `${location}.http_headers`);
      const canonicalHeader = headerName.toLowerCase();
      if (effectiveHeaderBindings[canonicalHeader] !== undefined) {
        throw new Error(`${location} configures header ${canonicalHeader} more than once`);
      }
      const generatedName = generatedHeaderEnvName(name, canonicalHeader);
      reserveGeneratedBinding(
        childEnv,
        userBindings,
        generatedBindings,
        generatedName,
        `${name}:generated-header:${canonicalHeader}`
      );
      setChildSecret(childEnv, generatedName, value, configuredNames);
      effectiveHeaderBindings[canonicalHeader] = generatedName;
    }
    if (Object.keys(effectiveHeaderBindings).length > 0) {
      const sortedBindings: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [headerName, envName] of Object.entries(effectiveHeaderBindings).sort(
        ([left], [right]) => codeUnitCompare(left, right)
      )) {
        sortedBindings[headerName] = envName;
      }
      addOverride(args, `${base}.env_http_headers`, tomlInlineQuotedStringTable(sortedBindings));
      normalized.env_http_headers = sortedBindings;
    }

    const required = optionalBoolean(raw.required, `${location}.required`);
    const parallel = optionalBoolean(
      raw.supports_parallel_tool_calls,
      `${location}.supports_parallel_tool_calls`
    );
    const enabled = optionalBoolean(raw.enabled, `${location}.enabled`);
    for (const [field, value] of [
      ['required', required],
      ['supports_parallel_tool_calls', parallel],
      ['enabled', enabled],
    ] as const) {
      if (value !== undefined) {
        addOverride(args, `${base}.${field}`, tomlBooleanOrNumber(value));
        normalized[field] = value;
      }
    }

    const startupSeconds = optionalPositiveNumber(
      raw.startup_timeout_sec,
      `${location}.startup_timeout_sec`
    );
    const startupMilliseconds = optionalPositiveNumber(
      raw.startup_timeout_ms,
      `${location}.startup_timeout_ms`
    );
    const toolSeconds = optionalPositiveNumber(
      raw.tool_timeout_sec,
      `${location}.tool_timeout_sec`
    );
    const toolMilliseconds = optionalPositiveNumber(
      raw.tool_timeout_ms,
      `${location}.tool_timeout_ms`
    );
    if (startupSeconds !== undefined && startupMilliseconds !== undefined) {
      throw new Error(`${location} cannot set both startup timeout units`);
    }
    if (toolSeconds !== undefined && toolMilliseconds !== undefined) {
      throw new Error(`${location} cannot set both tool timeout units`);
    }
    const effectiveStartupSeconds =
      startupSeconds ??
      (startupMilliseconds === undefined ? undefined : startupMilliseconds / 1000);
    const effectiveToolSeconds =
      toolSeconds ?? (toolMilliseconds === undefined ? undefined : toolMilliseconds / 1000);
    if (effectiveStartupSeconds !== undefined) {
      addOverride(args, `${base}.startup_timeout_sec`, String(effectiveStartupSeconds));
      normalized.startup_timeout_sec = effectiveStartupSeconds;
    }
    if (effectiveToolSeconds !== undefined) {
      addOverride(args, `${base}.tool_timeout_sec`, String(effectiveToolSeconds));
      normalized.tool_timeout_sec = effectiveToolSeconds;
    }

    const enabledTools = optionalStringSet(raw.enabled_tools, `${location}.enabled_tools`);
    const allowedTools = optionalStringSet(raw.allowed_tools, `${location}.allowed_tools`);
    const disabledTools = optionalStringSet(raw.disabled_tools, `${location}.disabled_tools`);
    const deniedTools = optionalStringSet(raw.denied_tools, `${location}.denied_tools`);
    if (enabledTools !== undefined && allowedTools !== undefined) {
      throw new Error(`${location} cannot set both enabled_tools and allowed_tools`);
    }
    if (disabledTools !== undefined && deniedTools !== undefined) {
      throw new Error(`${location} cannot set both disabled_tools and denied_tools`);
    }
    const effectiveEnabledTools = enabledTools ?? allowedTools;
    const effectiveDisabledTools = disabledTools ?? deniedTools;
    if (effectiveEnabledTools !== undefined) {
      addOverride(args, `${base}.enabled_tools`, tomlStringArray(effectiveEnabledTools));
      normalized.enabled_tools = effectiveEnabledTools;
    }
    if (effectiveDisabledTools !== undefined) {
      addOverride(args, `${base}.disabled_tools`, tomlStringArray(effectiveDisabledTools));
      normalized.disabled_tools = effectiveDisabledTools;
    }

    const defaultApproval =
      raw.default_tools_approval_mode === undefined
        ? undefined
        : requireEnum(
            raw.default_tools_approval_mode,
            APPROVAL_MODES,
            `${location}.default_tools_approval_mode`
          );
    if (defaultApproval !== undefined) {
      addOverride(args, `${base}.default_tools_approval_mode`, tomlString(defaultApproval));
      normalized.default_tools_approval_mode = defaultApproval;
    }
    const toolsToml = tomlInlineApprovalTable(raw.tools, `${location}.tools`);
    if (toolsToml !== undefined) {
      addOverride(args, `${base}.tools`, toolsToml);
      normalized.tools = normalizedApprovalTools(raw.tools, `${location}.tools`);
    }
    const scopes = optionalStringSet(raw.scopes, `${location}.scopes`);
    if (scopes !== undefined) {
      addOverride(args, `${base}.scopes`, tomlStringArray(scopes));
      normalized.scopes = scopes;
    }
    const rawOauthResource = optionalString(raw.oauth_resource, `${location}.oauth_resource`);
    const oauthResource =
      rawOauthResource === undefined
        ? undefined
        : validateHttpUrl(rawOauthResource, `${location}.oauth_resource`);
    if (oauthResource !== undefined) {
      if (url === undefined) {
        throw new Error(`${location}.oauth_resource is only valid for HTTP servers`);
      }
      addOverride(args, `${base}.oauth_resource`, tomlString(oauthResource));
      normalized.oauth_resource = oauthResource;
    }
    normalizedServers[name] = normalized;
  }

  return {
    args: consolidateMcpOverrides(args),
    env: childEnv,
    fingerprint: fingerprintPolicy(normalizedServers),
  };
}

export function getLocalMCPServerEntry(): string {
  try {
    return require.resolve('@jungjaehoon/mama-server');
  } catch {
    // Fallback to monorepo-relative path for local development
    return join(__dirname, '../../../mcp-server/src/server.js');
  }
}
