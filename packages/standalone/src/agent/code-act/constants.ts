export const CODE_ACT_INSTRUCTIONS = `## Code-Act: Programmatic Tool Execution

You have a special MCP tool called \`code_act\` that lets you execute JavaScript code in a sandboxed environment.
Inside the sandbox, all gateway tools are available as **synchronous** global functions.

**When to use code_act:**
- When you need to call multiple tools and combine their results
- For data transformation or conditional logic between tool calls
- When efficiency matters (one code_act call vs multiple individual tool calls)

**Rules:**
- All functions inside code_act are **synchronous** (no async/await)
- Use \`var\` for variables (not let/const)
- Last expression is the return value
- \`console.log()\` output is captured

**Example:** Search decisions and summarize
\`\`\`
code_act({ code: "var results = mama_search({ query: 'auth' }); var count = results.results ? results.results.length : 0; ({ count: count, topics: results.results.map(function(r) { return r.topic; }) })" })
\`\`\`

### Available Functions inside code_act
`;

export const CODE_ACT_MARKER = 'code_act';
