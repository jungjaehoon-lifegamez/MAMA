export type CodeActBackend = 'claude' | 'codex-mcp';

export function getCodeActInstructions(backend: CodeActBackend): string {
  const isCodex = backend === 'codex-mcp';

  const blockedToolsSection = isCodex
    ? `**DO NOT use these built-in tools** (they bypass MAMA's pipeline):
- \`exec_command\` → use \`code_act({ code: "Bash({command: '...'})" })\` instead
- \`apply_patch\` → use \`code_act({ code: "Write({file_path: '...', content: '...'})" })\` instead
- \`request_user_input\` — not available (headless daemon)
- \`update_plan\` — not available (no plan mode)

`
    : '';

  const gatewayToolsList = isCodex
    ? `**USE code_act for ALL gateway tools:**
- File ops: Read, Write, Edit, Bash
- Memory: mama_search, mama_save, mama_update
- Communication: discord_send, slack_send, webchat_send
- Browser: browser_navigate, browser_click, browser_screenshot
- System: os_list_bots, os_get_config, os_set_model`
    : `**USE code_act for these gateway tools** (NOT available as direct tools):
- Memory: mama_search, mama_save, mama_update
- Communication: discord_send, slack_send, webchat_send
- Browser: browser_navigate, browser_click, browser_screenshot
- System: os_list_bots, os_get_config, os_set_model

**Use your native tools directly** (do NOT wrap in code_act):
- Read, Write, Edit, Bash — these are your built-in tools, use them normally`;

  return `## Code-Act: Gateway Tool Execution via Sandbox

You have an MCP tool called \`code_act\` that executes JavaScript in a sandboxed environment.
The functions listed below are **ONLY available inside code_act** — they are NOT direct MCP tools.

### IMPORTANT: Tool usage rules

${blockedToolsSection}**USE these MCP tools directly** (normal tool_use calls):
- \`mcp__code-act__code_act\` — gateway tool execution (see below)
- \`mcp__brave-search__*\` — web search
- \`mcp__brave-devtools__*\` — browser control
- \`mcp__searxng__*\` — search engine

${gatewayToolsList}

**code_act rules:**
- Functions are **synchronous** (no async/await needed)
- Use \`var\` for variables (not let/const)
- Last expression is the return value
- \`console.log()\` output is captured

**Example:** Search and aggregate decisions
\`\`\`
code_act({ code: "var results = mama_search({ query: 'auth' }); var topics = results.results.map(function(r) { return r.topic; }); ({ count: topics.length, topics: topics })" })
\`\`\`

### Gateway Functions (ONLY inside code_act)
`;
}

/**
 * @deprecated Use getCodeActInstructions(backend) instead
 */
export const CODE_ACT_INSTRUCTIONS = getCodeActInstructions('codex-mcp');

export const CODE_ACT_MARKER = 'code_act';
