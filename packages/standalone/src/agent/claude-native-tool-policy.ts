/**
 * Role tool names that resolve to Claude CLI builtin tools. Catalog/MCP actions
 * are granted through a different surface; this map covers only the CLI's own
 * builtins.
 */
const CLAUDE_NATIVE_TOOL_MAP: Readonly<Record<string, string>> = {
  native_subagent: 'Agent',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  NotebookEdit: 'NotebookEdit',
  Bash: 'Bash',
  Glob: 'Glob',
  Grep: 'Grep',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
};

const CLAUDE_BUILTIN_TOOLS: readonly string[] = [
  'Agent',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

/**
 * Owner decision 2026-09-26: the Claude owner runtime writes only inside its workspace and has
 * web access. The rules go on the CLI (--allowedTools): measured with Claude Code 2.1.282, project
 * settings permissions were not applied to non-interactive runs while their sandbox was. An Edit
 * path rule also governs Write and NotebookEdit; "//" anchors it at an absolute path. Under dontAsk
 * an unmatched call is denied. Bash is confined by the sandbox in the workspace project settings.
 */
export function claudeOwnerAllowedTools(workspaceDir: string): string[] {
  return [
    'Read',
    'Glob',
    'Grep',
    `Edit(/${workspaceDir}/**)`,
    'Bash',
    'WebFetch',
    'WebSearch',
    'mcp__mama__*',
    'Agent',
  ];
}

/** CLI deny rules also govern native children; project permission rules are ignored in -p. */
export function claudeOwnerDisallowedTools(
  paths: readonly string[],
  workspaceDir: string
): string[] {
  return [
    ...paths.flatMap((path) => [`Read(/${path})`, `Read(/${path}/**)`]),
    ...['Edit', 'Write', 'NotebookEdit'].flatMap((tool) => [
      `${tool}(/${workspaceDir}/.claude)`,
      `${tool}(/${workspaceDir}/.claude/**)`,
    ]),
  ];
}

/** Member boundary also covers NotebookEdit through Edit; retain owner rules unchanged. */
export function claudeMemberDisallowedTools(
  paths: readonly string[],
  workspaceDir: string
): string[] {
  return [
    ...claudeOwnerDisallowedTools(paths, workspaceDir),
    ...paths.flatMap((path) => [`Edit(/${path})`, `Edit(/${path}/**)`]),
  ];
}

export interface ClaudeToolRole {
  allowedTools?: readonly string[];
  blockedTools?: readonly string[];
}

function isBlocked(cliName: string, blocked: ReadonlySet<string>): boolean {
  if (blocked.has(cliName)) return true;
  return Object.entries(CLAUDE_NATIVE_TOOL_MAP).some(
    ([roleName, mapped]) => mapped === cliName && blocked.has(roleName)
  );
}

/** Project the turn's native builtin grant onto Claude's --tools value. */
export function projectClaudeNativeTools(role: ClaudeToolRole | undefined): string | undefined {
  const allowed = role?.allowedTools ?? [];
  const blocked = new Set(role?.blockedTools ?? []);
  if (blocked.has('*')) return '';
  if (allowed.includes('*')) {
    const granted = CLAUDE_BUILTIN_TOOLS.filter((tool) => !isBlocked(tool, blocked));
    return granted.join(',');
  }
  const granted = new Set<string>();
  for (const [roleName, cliName] of Object.entries(CLAUDE_NATIVE_TOOL_MAP)) {
    if (allowed.includes(roleName) && !blocked.has(roleName) && !blocked.has(cliName)) {
      granted.add(cliName);
    }
  }
  return [...granted].join(',');
}
