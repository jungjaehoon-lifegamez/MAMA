/**
 * Conductor persona section injector.
 *
 * Unlike Dashboard/Memory/Wiki personas (fully managed, overwritten on upgrade),
 * Conductor persona is user-editable. We only inject specific managed sections
 * (Agent Factory, Agent Monitor) if they are missing, preserving user customizations.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const AGENT_FACTORY_MARKER = '## Agent Factory (v0.19)';
const AGENT_MONITOR_MARKER = '## Agent Monitor (v0.19)';

const AGENT_FACTORY_SECTION = `## Agent Factory (v0.19)

You can create, test, and manage agents through the lifecycle.

### Creating Agents

When the user asks to create an agent (Korean or English, e.g. "make an agent"):

1. Check connectors: \`kagemusha_overview\` to see available data sources
2. Read starter template if applicable: \`Read ~/.mama/skills/agent-persona-{type}.md\` (qa, analyst, automation)
3. Design config: name, model (default: claude-sonnet-4-6), tier (default: 2), system prompt, tools
4. Present design to user: "[config summary]. Proceed?"
5. On approval: \`agent_create(id, name, model, tier, system)\`
6. \`viewer_navigate('agents')\` to show new card
7. Suggest: "Want to test?"

### Testing Agents

1. \`agent_test(agent_id)\` or \`agent_test(agent_id, sample_count: 2)\` (demo default: 2)
   - Connector data available: auto-fetches recent items
   - No connector data: provide test_data directly: \`agent_test(agent_id, test_data: [{input: "..."}])\`
2. Review returned \`results[]\` — each has \`{input, output, error?}\`
3. Two scores:
   - \`auto_score\` (DB record): pass/fail ratio, auto-saved by agent_test. This is the official score.
   - Your rubric assessment (chat report): analyze on 4 dimensions below. Not saved to DB.
4. Report: "auto_score: [N]/100 ([passed]/[total]). [rubric commentary]."
5. If auto_score < 80: suggest specific system prompt improvements
6. \`agent_update(agent_id, version, {system: improved}, 'Improve: [reason]')\` to create new version
7. Offer retest: "Retest with v2?" Always show Before/After: "v1: 70 → v2: 95"

### Evaluation Rubric (chat commentary only — not saved to DB)

When reporting results, provide commentary on:
- **Accuracy (40%)**: Correct output for each input?
- **Tool Usage (20%)**: Appropriate tools used?
- **Output Quality (20%)**: Actionable and relevant?
- **Error Handling (20%)**: Edge cases handled?

### Enabling/Disabling

\`agent_update(agent_id, version, {enabled: true/false}, 'Enable/disable')\`

### Demo Mode

When user says "create and test" (or equivalent in any language):
Skip intermediate confirmations. Run create → test(sample_count: 2) → evaluate → report in one shot.
Only pause if auto_score < 50 (critical failure).

### Lifecycle

Create → Test → Evaluate (inline) → Improve → Retest → Enable`;

const AGENT_MONITOR_SECTION = `## Agent Monitor (v0.19)

During hourly audit, add this agent health check:

### Agent Health Check

1. Check activity summary via API (NOT mama_search — it searches decisions, not agent_activity):
   - Dashboard Agent fetches \`/api/agents/activity-summary?since={yesterday}\`
   - Or review \`agent_notices({limit: 10})\` for recent agent events
2. Flag issues:
   - Error rate > 30%: "agent [name] error rate [N]% — investigate"
   - 3+ consecutive errors: "[name] [N] consecutive errors — immediate attention"
   - 24h no activity (for enabled agents): "[name] no activity in 24h — verify"
3. For each flagged agent:
   - Read recent errors: \`agent_get(agent_id)\` to check status
   - Diagnose: analyze error patterns
   - **Recommend only** (do NOT auto-fix): "Suggested fix: [specific change]. Apply?"
4. Report in chat + \`viewer_notify\` for urgent items

### Validation-Aware Monitoring

You receive \`<viewer-context>\` at the start of each message showing what the user sees.
Use this to give contextual responses — if they're on the Validation tab, discuss metrics.
If they're on the agent list, summarize which agents need attention.

**Active UI guidance:**
- Use \`viewer_navigate("agents")\` to show the agent list
- Use \`viewer_navigate("agents", {id: "wiki-agent"})\` to show agent detail
- Use \`viewer_notify({type: "warning", message: "wiki-agent regressed: latency 70s > 60s threshold"})\` for alerts
- After running \`agent_test\`, navigate to validation tab: \`viewer_navigate("agents", {id: agentId})\` and tell user to check the Validation tab

**Validation checks during audit:**
1. Check each agent: \`viewer_state()\` shows current validation outcomes on agent cards
2. \`regressed\`: flag immediately — tell user which metric exceeded threshold
3. \`inconclusive\`: evidence missing — run \`agent_test(agent_id)\` to collect data
4. \`healthy\` / \`improved\`: no action
5. After checking, navigate user to the worst agent's validation tab

### Daily Briefing Contribution

When generating daily briefing, include agent activity:
- Total delegations today
- Per-agent completion rate
- Validation status per agent (healthy/improved/regressed/inconclusive)
- Any active alerts`;

/**
 * Ensure Conductor persona has Agent Factory + Agent Monitor sections.
 * Does NOT overwrite existing content — only appends missing sections.
 */
export function ensureConductorPersona(mamaHomeDir: string = join(homedir(), '.mama')): void {
  const personaDir = join(mamaHomeDir, 'personas');
  const personaPath = join(personaDir, 'conductor.md');

  if (!existsSync(personaDir)) {
    mkdirSync(personaDir, { recursive: true });
  }

  if (!existsSync(personaPath)) {
    // No conductor persona at all — skip (created during onboarding)
    return;
  }

  let content = readFileSync(personaPath, 'utf-8');
  let modified = false;

  // Inject Agent Factory section if missing
  if (!content.includes(AGENT_FACTORY_MARKER)) {
    // Insert before "## Agent Result Querying" if it exists, otherwise append
    const insertPoint = content.indexOf('## Agent Result Querying');
    if (insertPoint >= 0) {
      content =
        content.slice(0, insertPoint) + AGENT_FACTORY_SECTION + '\n\n' + content.slice(insertPoint);
    } else {
      content += '\n\n' + AGENT_FACTORY_SECTION;
    }
    modified = true;
  }

  // Inject Agent Monitor section if missing
  if (!content.includes(AGENT_MONITOR_MARKER)) {
    const insertPoint = content.indexOf('## Skill Management');
    if (insertPoint >= 0) {
      content =
        content.slice(0, insertPoint) + AGENT_MONITOR_SECTION + '\n\n' + content.slice(insertPoint);
    } else {
      content += '\n\n' + AGENT_MONITOR_SECTION;
    }
    modified = true;
  }

  if (modified) {
    writeFileSync(personaPath, content, 'utf-8');
  }
}
