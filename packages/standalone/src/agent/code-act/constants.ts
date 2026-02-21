export const CODE_ACT_INSTRUCTIONS = `## Code-Act: Optional Programmatic Tool Execution

You have an MCP tool called \`code_act\` that executes JavaScript in a sandboxed environment.
All gateway tools are available as **synchronous** global functions inside the sandbox.

**You also have direct access to Bash, Write, Edit, Read, and other tools.**
Choose the right approach for each task:

**Use direct tools (Bash, Write, Edit, Read) when:**
- Writing or editing files (especially large content like HTML)
- Simple single-step operations
- Tasks where string escaping matters

**Use code_act when:**
- Combining multiple tool results with logic (filter, map, conditionals)
- Chaining 3+ tool calls where intermediate results feed the next call
- Data transformation or aggregation across multiple sources

**code_act rules:**
- Functions are **synchronous** (no async/await needed)
- Use \`var\` for variables (not let/const)
- Last expression is the return value
- \`console.log()\` output is captured

**Example:** Search and aggregate decisions
\`\`\`
code_act({ code: "var results = mama_search({ query: 'auth' }); var topics = results.results.map(function(r) { return r.topic; }); ({ count: topics.length, topics: topics })" })
\`\`\`

### Available Functions inside code_act
`;

export const CODE_ACT_MARKER = 'code_act';
