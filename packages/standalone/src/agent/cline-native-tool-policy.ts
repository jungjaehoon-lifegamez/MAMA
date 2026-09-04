const CLINE_NATIVE_TOOL_NAMES = new Set([
  'read_files',
  'search_codebase',
  'run_commands',
  'fetch_web_content',
  'apply_patch',
  'editor',
  'skills',
  'ask_question',
  'submit_and_exit',
]);

const CLINE_NATIVE_TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
  Read: ['read_files'],
  Grep: ['search_codebase'],
  Glob: ['search_codebase'],
  Bash: ['run_commands'],
  WebSearch: ['fetch_web_content'],
  WebFetch: ['fetch_web_content'],
  Write: ['apply_patch', 'editor'],
  Edit: ['apply_patch', 'editor'],
  NotebookEdit: ['apply_patch', 'editor'],
};

const CLINE_MCP_TOOL_PATTERN = /^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/;

export function isClineMcpToolGrant(tool: string): boolean {
  return CLINE_MCP_TOOL_PATTERN.test(tool);
}

/**
 * Cline's native shell and editor bypass MAMA's gateway executor (workspace cwd, destructive
 * guard, receipts). The main persona's gateway Bash/Write grant (owner chat, 2026-09-04) must
 * never become these; managed tier-2/3 runners keep the plain mapping below.
 */
export const CLINE_NATIVE_GUARD_BYPASS: readonly string[] = [
  'run_commands',
  'apply_patch',
  'editor',
];

export function projectClineNativeTools(tools: readonly string[] | undefined): string[] {
  if (!tools) {
    return [];
  }
  if (tools.includes('*')) {
    return ['*'];
  }
  return [
    ...new Set(
      tools.flatMap((tool) => {
        if (CLINE_NATIVE_TOOL_NAMES.has(tool)) {
          return [tool];
        }
        if (isClineMcpToolGrant(tool)) {
          return [tool];
        }
        return CLINE_NATIVE_TOOL_MAP[tool] ?? [];
      })
    ),
  ];
}
