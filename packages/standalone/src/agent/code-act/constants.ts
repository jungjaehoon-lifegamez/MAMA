export type CodeActBackend = 'claude' | 'codex';

export function getCodeActInstructions(
  backend: CodeActBackend,
  allowedTools?: readonly string[]
): string {
  const isCodex = backend === 'codex';
  const allowedSummary = formatAllowedToolsSummary(allowedTools);
  const hasExplicitGatewayAllowlist = allowedSummary !== null;

  const blockedToolsSection = isCodex
    ? `**DO NOT use these built-in tools** (they bypass MAMA's pipeline):
- \`exec_command\`
- \`apply_patch\`
- \`request_user_input\` — not available (headless daemon)
- \`update_plan\` — not available (no plan mode)

Use only functions in the current allowlist below. Never assume that Bash, Write,
or a communication function exists unless it is listed for this run.

`
    : '';

  const gatewayToolsList = isCodex
    ? hasExplicitGatewayAllowlist
      ? `**USE code_act only for these allowed gateway tools:**
${allowedSummary}`
      : `**USE code_act for ALL gateway tools:**
- File ops: Read, Write, Edit, Bash
- Memory: mama_search, mama_save, mama_update
- Communication: discord_send, slack_send, telegram_send, webchat_send
- Browser: browser_navigate, browser_click, browser_screenshot
- System: os_list_bots, os_get_config, os_set_model
- Dashboard: report_publish
- Wiki: wiki_publish`
    : hasExplicitGatewayAllowlist
      ? `**USE code_act only for these allowed gateway tools** (NOT available as direct tools):
${allowedSummary}`
      : `**USE code_act for these gateway tools** (NOT available as direct tools):
- Memory: mama_search, mama_save, mama_update
- Communication: discord_send, slack_send, telegram_send, webchat_send
- Browser: browser_navigate, browser_click, browser_screenshot
- System: os_list_bots, os_get_config, os_set_model
- Dashboard: report_publish
- Wiki: wiki_publish

**Use your native tools directly** (do NOT wrap in code_act):
- Read, Write, Edit, Bash — these are your built-in tools, use them normally`;

  const transportIntroduction = isCodex
    ? `You have a native app-server tool called \`code_act\` that executes JavaScript in a sandboxed environment.
The functions listed below are **ONLY available inside code_act** — they are NOT direct native tools.`
    : `You have an MCP tool called \`code_act\` that executes JavaScript in a sandboxed environment.
The functions listed below are **ONLY available inside code_act** — they are NOT direct MCP tools.`;
  const directToolSection = isCodex
    ? `**Call the native \`code_act\` tool directly** with a normal model tool call.`
    : `**USE these MCP tools directly** (normal tool_use calls):
- \`mcp__code-act__code_act\` — gateway tool execution (see below)
- \`mcp__brave-search__*\` — web search
- \`mcp__brave-devtools__*\` — browser control
- \`mcp__searxng__*\` — search engine`;

  const compositionContract = `
### Composition contract

Treat the listed functions as composable primitives, not as a fixed workflow.
Plan and combine whichever primitives are needed for the user's requested outcome.
Guidance functions are optional; they never replace agent judgment.
For requested writes, uploads, messages, or other side effects, continue until each
required tool returns success. Never claim an artifact or delivery exists after a
failed or skipped call. If a necessary primitive is absent, name that exact missing
function only after checking the current allowlist.
`;

  return `## Code-Act: Gateway Tool Execution via Sandbox

${transportIntroduction}

### IMPORTANT: Tool usage rules

${blockedToolsSection}${directToolSection}

${gatewayToolsList}
${compositionContract}

**code_act rules:**
- Functions are **synchronous** (no async/await needed)
- Use \`var\` for variables (not let/const)
- Last expression is the return value
- \`console.log()\` output is captured

**Example:** Count decisions
\`\`\`
code_act({ code: "var r=mama_search({query:'auth'}); r.results.length" })
\`\`\`

### Gateway Functions (ONLY inside code_act)
`;
}

function formatAllowedToolsSummary(allowedTools?: readonly string[]): string | null {
  if (!allowedTools || allowedTools.includes('*')) {
    return null;
  }
  if (allowedTools.length === 0) {
    return '- No gateway tools are currently allowed.';
  }

  const visibleTools = allowedTools.filter(
    (tool) => tool !== 'code_act' && !tool.startsWith('mcp__')
  );
  if (visibleTools.length === 0) {
    return '- No gateway tools are currently allowed.';
  }

  return visibleTools.map((tool) => `- ${tool}`).join('\n');
}

/**
 * @deprecated Use getCodeActInstructions(backend) instead
 */
export const CODE_ACT_INSTRUCTIONS = getCodeActInstructions('codex');

export const CODE_ACT_MARKER = 'code_act';
