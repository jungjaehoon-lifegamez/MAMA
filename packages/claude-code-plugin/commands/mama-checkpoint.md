---
description: Save the current session state for later resumption
allowed-tools: Read
argument-hint: ""
---

# Save Session Checkpoint

You are helping the user save the current session state to MAMA memory.

**User Arguments:** `$ARGUMENTS`

## Instructions

**Default behavior: Always auto-generate checkpoint from session context**

1. **Analyze the conversation history** to automatically generate:
   - `summary`: What was accomplished in this session (2-3 sentences max, focus on concrete changes)
   - `open_files`: Array of file paths that were Read, Edit, or Write (extract from tool usage)
   - `next_steps`: What remains to be done based on incomplete todos or pending work

2. **Call the MCP tool `save_checkpoint`** with generated parameters:
   ```javascript
   save_checkpoint({
     summary: "...",
     open_files: ["file1.js", "file2.md"],
     next_steps: "..."
   })
   ```

3. **Display confirmation** in this format:
   ```
   ✅ Session Checkpoint Saved

   **Summary:** {generated_summary}
   **Open Files:** {extracted_files or 'None'}
   **Next Steps:** {inferred_next_steps or 'None'}

   Resume this session later with:
   `/mama-resume`
   ```

**Note:** Ignore `$ARGUMENTS` - always auto-generate from session context.

## Example Usage

```
/mama-checkpoint
```

That's it! No arguments needed. Claude will:
- Analyze the conversation history
- Extract files from tool usage (Read/Edit/Write)
- Infer next steps from todos or pending work
- Save everything automatically

## Important Notes

- **Zero configuration**: Just run `/mama-checkpoint` with no arguments
- **Smart analysis**: Claude automatically extracts relevant context
- **File tracking**: Captures all Read/Edit/Write operations
- **Next steps**: Inferred from incomplete todos or mentioned tasks
