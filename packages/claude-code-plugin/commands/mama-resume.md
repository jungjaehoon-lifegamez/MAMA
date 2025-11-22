---
description: Resume work from the last saved session checkpoint
allowed-tools: Read
argument-hint: ""
---

# Resume Session from Checkpoint

You are helping the user resume work from a previously saved checkpoint.

**User Arguments:** `$ARGUMENTS`

## Instructions

**Default behavior: Load most recent checkpoint automatically**

1. **Call the MCP tool `load_checkpoint`** with no parameters:
   ```javascript
   load_checkpoint()
   ```

2. If checkpoint exists, **display the checkpoint** in this format:
   ```
   🔄 Resuming Session

   **Saved on:** {timestamp}

   📝 **Session Summary:**
   {summary}

   📂 **Relevant Files:**
   {list of files or 'None'}

   👉 **Next Steps:**
   {next_steps or 'None specified'}

   ---

   Ready to continue where you left off!
   ```

3. If no checkpoint exists:
   ```
   ℹ️ No Active Checkpoint Found

   There's no saved session to resume.

   Save a checkpoint at the end of your session with:
   `/mama-checkpoint`
   ```

**Note:** Ignore `$ARGUMENTS` - always load the most recent checkpoint.

## Example Usage

```
/mama-resume
```

That's it! No arguments needed. Claude will:
- Load the most recent checkpoint
- Display session summary and timestamp
- Show relevant files from that session
- Remind you of next steps

## Important Notes

- **Zero configuration**: Just run `/mama-resume` with no arguments
- **Automatic retrieval**: Always gets the most recent checkpoint
- **Session continuity**: Provides full context from previous session
- **Ready to work**: All information you need to continue
