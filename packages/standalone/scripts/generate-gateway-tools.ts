/**
 * Build-time script: generates gateway-tools.md from ToolRegistry (STORY-017)
 *
 * Usage: npx tsx scripts/generate-gateway-tools.ts
 * Called automatically during `pnpm build`.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ToolRegistry } from '../src/agent/tool-registry.js';

// ─── Static sections appended after tool list ────────────────────────────────

const STATIC_SECTIONS = `
## Sending Media to Webchat

To display images in webchat, you MUST include the full file path in your response text.
The viewer auto-converts paths matching \`~/.mama/workspace/media/outbound/<file>\` into inline \`<img>\` tags.

**Steps:**

1. Copy or create the file in \`~/.mama/workspace/media/outbound/\`
2. In your response, write the FULL PATH as plain text on its own line:

Example response:

\`\`\`text
Here is the image:
~/.mama/workspace/media/outbound/screenshot.png
\`\`\`

**CRITICAL:** You must write the actual path \`~/.mama/workspace/media/outbound/filename.ext\` in your response text. Do NOT just describe the image — the path IS the display mechanism. Without the path, nothing is shown to the user.

**Workflow for showing any image:**

1. \`cp /source/image.png ~/.mama/workspace/media/outbound/image.png\` (use Bash tool)
2. In response text, write: \`~/.mama/workspace/media/outbound/image.png\`

The user will ONLY see the image if you write the outbound path. Text descriptions alone show NOTHING.

For user-uploaded files: \`~/.mama/workspace/media/inbound/<filename>\`

## Cron (Scheduled Jobs)

Register and manage recurring tasks via the internal API (port 3847).

- **List jobs**: \`curl -s http://localhost:3847/api/cron | jq\`
- **Create job**: \`curl -s -X POST http://localhost:3847/api/cron -H 'Content-Type: application/json' -d '{"name":"job name","cron_expr":"0 * * * *","prompt":"task prompt here"}'\`
- **Run now**: \`curl -s -X POST http://localhost:3847/api/cron/{id}/run\`
- **Update job**: \`curl -s -X PUT http://localhost:3847/api/cron/{id} -H 'Content-Type: application/json' -d '{"enabled":false}'\`
- **Delete job**: \`curl -s -X DELETE http://localhost:3847/api/cron/{id}\`
- **View logs**: \`curl -s http://localhost:3847/api/cron/{id}/logs | jq\`

The \`prompt\` field is what the agent will execute on each cron tick.
Use cron expressions: \`0 * * * *\` (hourly), \`*/30 * * * *\` (every 30min), \`0 9 * * *\` (daily 9am).

When a user asks to schedule/monitor something periodically, ALWAYS use this API — do NOT create external scripts or system crontab entries.

## IMPORTANT: System Info

- Status: \`mama status\` (shows PID, uptime, config)
- Stop: \`mama stop\`
- Start: \`mama start\`
- NEVER use sudo. NEVER use systemctl.
- Config: \`~/.mama/config.yaml\`
- Logs: \`~/.mama/logs/daemon.log\` (large file — read last 100 lines with Bash: \`tail -100 ~/.mama/logs/daemon.log\`)
- Home: \`~/.mama/\`

## Tool Call Rules

- If a tool call fails, report the error honestly. Do NOT fabricate results.
- Use \`path\` parameter for Read/Write: \`{"name": "Read", "input": {"path": "~/.mama/config.yaml"}}\`
`;

// ─── Generate ────────────────────────────────────────────────────────────────

const header = `# Gateway Tools

Call tools via JSON block:

\`\`\`tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
\`\`\`
`;

const toolList = ToolRegistry.generatePrompt();
// generatePrompt() includes "# Gateway Tools" header — strip it to avoid duplication
const toolListBody = toolList.replace(/^# Gateway Tools\n*/, '');

const output = header + toolListBody + '\n' + STATIC_SECTIONS.trim() + '\n';

// Write to src (for dev hot-reload) and dist (for production)
const srcPath = join(__dirname, '..', 'src', 'agent', 'gateway-tools.md');
writeFileSync(srcPath, output, 'utf-8');

// Also write to dist if it exists
const distDir = join(__dirname, '..', 'dist', 'agent');
try {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'gateway-tools.md'), output, 'utf-8');
} catch {
  // dist may not exist yet during first build
}

console.log(`✓ gateway-tools.md generated (${ToolRegistry.count} tools)`);
