export type CodeActBackend = 'claude' | 'codex' | 'cline';

export const CODE_ACT_SCRIPT_CONTRACT =
  'Code-Act runs a synchronous script. Host function calls settle before returning. ' +
  'Use plain sequential calls with var and make the desired value the last expression. ' +
  'Do not use top-level return, async, await, Promise, Promise.all, or async IIFEs.';

export const CODE_ACT_SCRIPT_EXAMPLE = 'var first=1; var second=2; ({first:first,second:second})';

export const CODE_ACT_METADATA_DECLARATIONS = `declare function tool_search(input?:{query?:string,category?:string,limit?:number,cursor?:string}): {tools:Array<{name:string,description:string,category:string}>,nextCursor:string|null};
declare function tool_describe(input:{names:string[]}): {contracts:string[]};`;

export function getCodeActInstructions(
  backend: CodeActBackend,
  _allowedTools?: readonly string[]
): string {
  const isCodex = backend === 'codex';
  const isCline = backend === 'cline';
  const transportIntroduction = isCodex
    ? `You have a native app-server tool called \`code_act\` that executes JavaScript in a sandboxed environment.
Use code_act for gateway work; provider-native operations cannot bypass MAMA's current policy.
Do not use the Codex built-ins \`exec_command\` or \`apply_patch\` (they bypass MAMA's pipeline);
\`request_user_input\` and \`update_plan\` are unavailable in this headless daemon.`
    : `You have an MCP tool called \`mcp__code-act__code_act\` that executes JavaScript in a sandboxed environment.
Gateway functions and the metadata functions below are available only inside it. Permitted
${isCline ? 'Cline' : 'Claude'} native local tools remain native and should be called directly.`;

  return `## Code-Act: Gateway Tool Execution via Sandbox

${transportIntroduction}

### Synchronous grammar

- ${CODE_ACT_SCRIPT_CONTRACT}
- \`console.log()\` output is captured

**Example:** Synchronous script shape
\`\`\`
code_act({ code: "${CODE_ACT_SCRIPT_EXAMPLE}" })
\`\`\`

### Progressive gateway discovery

The catalog is the exact gateway policy for this run. \`tool_search\` returns 6 compact,
name-sorted matches by default; \`limit\` must be an integer from 1 to 12. Continue with
\`nextCursor\` until it is null when you need complete
coverage. \`tool_describe\` returns complete contracts for 1 to 4 selected names without
slicing declarations. A gateway function you already know may be called directly; discovery
does not grant access or create a required call order.

Treat the permitted gateway functions as composable primitives and choose the composition needed
for the requested outcome. Never claim that a write, artifact, upload, message, or delivery exists
after its required tool failed or was skipped.

\`\`\`typescript
${CODE_ACT_METADATA_DECLARATIONS}
\`\`\`
`;
}

/**
 * @deprecated Use getCodeActInstructions(backend) instead
 */
export const CODE_ACT_INSTRUCTIONS = getCodeActInstructions('codex');

export const CODE_ACT_MARKER = 'code_act';
