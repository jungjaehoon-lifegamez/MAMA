/**
 * Build-time script: generates gateway-tools.md from ToolRegistry (STORY-017)
 *
 * Usage: npx tsx scripts/generate-gateway-tools.ts
 * Called automatically during `pnpm build`.
 */

import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildGatewayToolCatalog } from '../src/agent/gateway-tool-catalog.js';
import { resolvePrivateConnectorPolicy } from '../src/connectors/private-connector-policy.js';

// ─── Static sections appended after tool list ────────────────────────────────

const STATIC_SECTIONS = `
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

## Telegram Stickers

When a user sends a sticker, it arrives as \`[sticker: emoji]\` text.
You can send stickers back using telegram_send with the sticker_emotion parameter:
\`{"name": "telegram_send", "input": {"chat_id": "<current_chat_id>", "sticker_emotion": "happy"}}\`

Available emotions: happy, love, sad, thanks, sorry, hello, bye, laugh, thinking, excited, angry, surprised, ok, tired

When a user sends you a sticker, respond with an appropriate sticker using telegram_send(sticker_emotion) before or after your text reply.
The chat_id is the channelId from the current conversation metadata.

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

const publicCatalog = buildGatewayToolCatalog({
  surface: 'multi-agent-generic',
  allowedTools: ['*'],
  privateConnectorPolicy: resolvePrivateConnectorPolicy({
    ok: true,
    config: {},
    enabledNames: [],
  }),
});
const toolList = publicCatalog.prompt;
// generatePrompt() includes "# Gateway Tools" header — strip it to avoid duplication
const toolListBody = toolList.replace(/^# Gateway Tools\n*/, '');

const output = header + toolListBody.trimEnd() + '\n\n' + STATIC_SECTIONS.trim() + '\n';

// Write to src (for dev hot-reload) and dist (for production)
const srcPath = join(__dirname, '..', 'src', 'agent', 'gateway-tools.md');
writeFileSync(srcPath, output, 'utf-8');

// Also write to dist if it exists
const distDir = join(__dirname, '..', 'dist', 'agent');
try {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'gateway-tools.md'), output, 'utf-8');
  const osAgentCapabilitiesSrc = join(__dirname, '..', 'src', 'agent', 'os-agent-capabilities.md');
  if (existsSync(osAgentCapabilitiesSrc)) {
    copyFileSync(osAgentCapabilitiesSrc, join(distDir, 'os-agent-capabilities.md'));
  }
} catch {
  // dist may not exist yet during first build
}

console.log(`✓ gateway-tools.md generated (${publicCatalog.toolNames.length} public tools)`);
