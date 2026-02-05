# Architecture: Context-First Contract Flow (BMAD)

**Owner:** Team MAMA  
**Date:** 2026-02-05  
**Status:** Draft

## **B — Boundary**

The system spans two planes.

- Execution plane: Claude Code plugin hooks (PreToolUse, PostToolUse)
- Knowledge plane: MAMA MCP server and storage

## **M — Modules**

- PreToolUse Hook (plugin)
  - Executes MCP search
  - Filters and summarizes contracts
  - Outputs reasoning summary and blocking guidance
- PostToolUse Hook (plugin)
  - Extracts contracts from code changes
  - Emits explicit save instructions
- MCP Client (plugin)
  - Calls MCP tools via stdio
- MCP Server (mcp package)
  - Stores and retrieves contracts/decisions
  - Provides search and save endpoints

## **A — Architecture Flow**

### **1) PreToolUse**

1. Tool invocation begins (Read/Edit/Grep).
2. PreToolUse searches MCP for matching contracts.
3. Results are filtered to contract topics only.
4. Reasoning summary is generated from actual results.
5. Hook emits blocking guidance if no contract exists.

### **2) PostToolUse**

1. Code change detected (Write/Edit).
2. Contract extractor identifies API contracts.
3. Hook emits save instructions with exact schema.
4. User saves contract via MCP (explicit action).

## **D — Data Model**

### **Contract (neutral schema)**

- `topic`: `contract_<method>_<path>` or `contract_action_<name>`
- `decision`: normalized summary
- `reasoning`: evidence source
- `confidence`: 0.0–1.0
- `aliases`: optional list of field-name variants
- `layer`: `frontend|backend|db|game|mobile`

## **Interfaces**

### MCP Tools

- `search` (query, limit)
- `save` (type, topic, decision, reasoning, confidence)

### Plugin Hook Output

- `hookSpecificOutput.systemMessage`
- `hookSpecificOutput.additionalContext`

## **Reasoning Integrity**

Reasoning summaries are derived only from:

- Actual MCP search results
- Extracted code content
- Explicit rule transformations (case mapping)

If evidence is missing, output is marked `unknown` or `needs confirmation`.

## **Failure Modes**

- MCP unavailable: PreToolUse outputs search failure and blocks guessing.
- No contract found: PreToolUse outputs blocking template for new contract.
- Low-confidence extraction: PostToolUse does not auto-save.

## **Security & Privacy**

- No sensitive data should be logged in hooks.
- Contracts should not store secrets.
- Optional redaction via prompt sanitizer.

## **Extensibility**

The system supports multiple domains by:

- Allowing neutral contract types (API, action, event)
- Adding case mapping rules per language
- Storing role-based profiles in MCP
