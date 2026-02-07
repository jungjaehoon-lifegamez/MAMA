import type { ToolDefinition } from '../agent/types.js';
import { loadConfig, saveConfig } from '../cli/config/config-manager.js';

export interface IntegrationOptions {
  discord?: {
    enabled: boolean;
    token?: string;
    guilds?: Record<
      string,
      {
        requireMention?: boolean;
        channels?: Record<string, { requireMention?: boolean }>;
      }
    >;
  };
  slack?: {
    enabled: boolean;
    token?: string;
    workspaces?: string[];
  };
  telegram?: {
    enabled: boolean;
    token?: string;
    allowedChats?: string[];
  };
  cronJobs?: Array<{
    id: string;
    cronExpr: string;
    prompt: string;
    enabled: boolean;
  }>;
  heartbeat?: {
    enabled: boolean;
    interval: number;
    quietStart: number;
    quietEnd: number;
    notifyChannelId?: string;
  };
  skills?: Array<{
    id: string;
    path: string;
    enabled: boolean;
  }>;
  role?: string;
  multi_agent?: {
    enabled: boolean;
    agents?: Record<
      string,
      {
        name: string;
        tier: number;
        model?: string;
        enabled: boolean;
      }
    >;
  };
}

const ROLE_EXAMPLES: Record<string, string> = {
  developer: `## Developer Integration Examples

### Discord for Team Notifications
\`\`\`json
{
  "discord": {
    "enabled": true,
    "token": "YOUR_BOT_TOKEN",
    "guilds": {
      "YOUR_GUILD_ID": {
        "requireMention": false,
        "channels": {
          "dev-alerts": { "requireMention": false },
          "general": { "requireMention": true }
        }
      }
    }
  }
}
\`\`\`

### Cron Jobs for Daily Builds
\`\`\`json
{
  "cronJobs": [
    {
      "id": "daily-build-check",
      "cronExpr": "0 9 * * *",
      "prompt": "Check CI/CD pipeline status and report any failures",
      "enabled": true
    },
    {
      "id": "dependency-updates",
      "cronExpr": "0 10 * * 1",
      "prompt": "Check for npm package updates and create update summary",
      "enabled": true
    }
  ]
}
\`\`\`

### Heartbeat for System Monitoring
\`\`\`json
{
  "heartbeat": {
    "enabled": true,
    "interval": 1800000,
    "quietStart": 23,
    "quietEnd": 8,
    "notifyChannelId": "YOUR_DISCORD_CHANNEL_ID"
  }
}
\`\`\`

### Multi-Agent Setup (Optional)
\`\`\`json
{
  "multi_agent": {
    "enabled": true,
    "agents": {
      "sisyphus": { "name": "Sisyphus", "tier": 1, "enabled": true },
      "devbot": { "name": "DevBot", "tier": 2, "enabled": true },
      "reviewer": { "name": "Reviewer", "tier": 3, "enabled": true }
    }
  }
}
\`\`\``,

  researcher: `## Researcher Integration Examples

### Telegram for Mobile Access
\`\`\`json
{
  "telegram": {
    "enabled": true,
    "token": "YOUR_BOT_TOKEN",
    "allowedChats": ["YOUR_CHAT_ID"]
  }
}
\`\`\`

### Cron Jobs for Literature Monitoring
\`\`\`json
{
  "cronJobs": [
    {
      "id": "arxiv-daily",
      "cronExpr": "0 8 * * *",
      "prompt": "Search arXiv for new papers in my research areas and summarize",
      "enabled": true
    },
    {
      "id": "weekly-research-digest",
      "cronExpr": "0 9 * * 1",
      "prompt": "Compile weekly research digest from saved papers",
      "enabled": true
    }
  ]
}
\`\`\`

### Skills for Paper Analysis
\`\`\`json
{
  "skills": [
    {
      "id": "paper-analyzer",
      "path": "~/.mama/skills/paper-analyzer.md",
      "enabled": true
    },
    {
      "id": "citation-tracker",
      "path": "~/.mama/skills/citation-tracker.md",
      "enabled": true
    }
  ]
}
\`\`\`

### Multi-Agent Setup (Optional)
\`\`\`json
{
  "multi_agent": {
    "enabled": true,
    "agents": {
      "researcher": { "name": "Researcher", "tier": 1, "enabled": true },
      "analyst": { "name": "Analyst", "tier": 2, "enabled": true }
    }
  }
}
\`\`\``,

  manager: `## Manager Integration Examples

### Slack for Team Communication
\`\`\`json
{
  "slack": {
    "enabled": true,
    "token": "YOUR_BOT_TOKEN",
    "workspaces": ["team-workspace"]
  }
}
\`\`\`

### Cron Jobs for Team Status
\`\`\`json
{
  "cronJobs": [
    {
      "id": "daily-standup-prep",
      "cronExpr": "0 8 * * 1-5",
      "prompt": "Prepare daily standup summary from team activity",
      "enabled": true
    },
    {
      "id": "weekly-metrics",
      "cronExpr": "0 17 * * 5",
      "prompt": "Generate weekly team metrics and performance summary",
      "enabled": true
    }
  ]
}
\`\`\`

### Heartbeat for Team Monitoring
\`\`\`json
{
  "heartbeat": {
    "enabled": true,
    "interval": 3600000,
    "quietStart": 20,
    "quietEnd": 8,
    "notifyChannelId": "YOUR_SLACK_CHANNEL_ID"
  }
}
\`\`\`

### Multi-Agent Setup (Optional)
\`\`\`json
{
  "multi_agent": {
    "enabled": true,
    "agents": {
      "coordinator": { "name": "Coordinator", "tier": 1, "enabled": true },
      "reporter": { "name": "Reporter", "tier": 2, "enabled": true }
    }
  }
}
\`\`\``,

  default: `## General Integration Examples

### Discord Bot Setup
1. Create bot at https://discord.com/developers/applications
2. Enable Message Content Intent
3. Add bot to your server with proper permissions
4. Copy bot token to configuration

### Cron Expression Guide
\`\`\`
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of week (0 - 6) (Sunday to Saturday)
│ │ │ │ │
* * * * *
\`\`\`

Examples:
- \`0 9 * * *\` - Every day at 9:00 AM
- \`*/30 * * * *\` - Every 30 minutes
- \`0 0 * * 0\` - Every Sunday at midnight
- \`0 9 * * 1-5\` - Weekdays at 9:00 AM

### Heartbeat Configuration
- **interval**: Milliseconds between checks (30min = 1800000)
- **quietStart**: Hour to stop checking (0-23)
- **quietEnd**: Hour to resume checking (0-23)
- **notifyChannelId**: Discord/Slack channel for notifications

### Skills System
Skills are markdown files that define specialized behaviors:
- Location: \`~/.mama/skills/\`
- Format: Markdown with frontmatter metadata
- Trigger: Pattern matching on user queries
- Response: Custom prompts and tool sequences`,
};

/**
 * Integration setup instructions
 */
const INTEGRATION_INSTRUCTIONS = `# MAMA Integrations Guide

## Overview

MAMA Standalone supports multiple integration types to fit your workflow:

1. **Chat Gateways** - Discord, Slack, Telegram
2. **Scheduled Tasks** - Cron jobs for recurring work
3. **Proactive Monitoring** - Heartbeat checks
4. **Custom Skills** - Specialized behaviors and workflows

## Chat Gateways

### Discord Integration

**Setup:**
1. Go to https://discord.com/developers/applications
2. Create New Application
3. Bot tab → Add Bot
4. Enable "Message Content Intent" under Privileged Gateway Intents
5. Copy bot token
6. OAuth2 → URL Generator → Select "bot" scope and permissions
7. Use generated URL to add bot to your server

**Configuration:**
- \`guilds\`: Guild-specific settings (use "*" for all guilds)
- \`requireMention\`: If true, bot only responds to @mentions
- \`channels\`: Channel-specific overrides

**Features:**
- DM support (always responds in DMs)
- Channel-specific mention requirements
- Image attachment handling (OCR, translation)
- Message history tracking for context
- Typing indicators during processing

### Telegram Integration

**Setup:**
1. Message @BotFather on Telegram
2. Send /newbot and follow instructions
3. Copy bot token
4. Get your chat ID by messaging @userinfobot

**Configuration:**
- \`token\`: Bot token from BotFather
- \`allowedChats\`: List of allowed chat IDs (security)

**Features:**
- Private chat support
- Group chat support
- Image handling
- Inline queries

### Slack Integration

**Setup:**
1. Go to https://api.slack.com/apps
2. Create New App → From scratch
3. OAuth & Permissions → Add scopes (channels:read, chat:write, etc.)
4. Install to Workspace
5. Copy Bot User OAuth Token

**Configuration:**
- \`token\`: Bot User OAuth Token
- \`workspaces\`: List of workspace IDs

## Scheduled Tasks (Cron Jobs)

Cron jobs run automated tasks on a schedule:

**Job Configuration:**
- \`id\`: Unique identifier
- \`cronExpr\`: Cron expression (see guide below)
- \`prompt\`: Task description for Claude
- \`enabled\`: Enable/disable job

**Cron Expression Format:**
\`\`\`
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of week (0 - 6)
│ │ │ │ │
* * * * *
\`\`\`

**Examples:**
- \`0 9 * * *\` - Daily at 9 AM
- \`*/15 * * * *\` - Every 15 minutes
- \`0 0 * * 0\` - Weekly on Sunday midnight
- \`0 9 * * 1-5\` - Weekdays at 9 AM
- \`0 0 1 * *\` - Monthly on 1st at midnight

**Use Cases:**
- Daily build status checks
- Weekly report generation
- Hourly data synchronization
- Monthly maintenance tasks
- Custom automation workflows

## Heartbeat Monitoring

Proactive system that periodically checks HEARTBEAT.md for tasks:

**Configuration:**
- \`interval\`: Check frequency in milliseconds
  - 30 minutes: \`1800000\`
  - 1 hour: \`3600000\`
  - 2 hours: \`7200000\`
- \`quietStart\`: Hour to pause (e.g., 23 for 11 PM)
- \`quietEnd\`: Hour to resume (e.g., 8 for 8 AM)
- \`notifyChannelId\`: Discord/Slack channel for alerts

**How It Works:**
1. Every interval, reads \`~/.mama/HEARTBEAT.md\`
2. Sends content to Claude for processing
3. Claude checks for tasks and executes them
4. Responds with status (OK, NOTIFY, DONE)
5. Sends notifications if configured

**HEARTBEAT.md Example:**
\`\`\`markdown
# Heartbeat Tasks

## Pending
- [ ] Check if new GitHub issues need triage
- [ ] Monitor server uptime (alert if down)

## Completed
- [x] Daily backup verified (2025-01-31)
\`\`\`

## Skills System

Skills are reusable markdown-based workflows:

**Skill Structure:**
\`\`\`markdown
---
id: skill-name
triggers:
  - "keyword or phrase"
  - "another trigger"
description: "What this skill does"
---

# Skill Instructions

Claude, when this skill is triggered:

1. Do step one
2. Do step two
3. Return result in this format
\`\`\`

**Loading Skills:**
- Place skills in \`~/.mama/skills/\`
- Configure in integrations.md
- Skills auto-load on startup
- Pattern matching triggers execution

**Skill Examples:**
- Paper analysis workflows
- Code review checklists
- Report generation templates
- Custom tool sequences

## Security Considerations

**API Tokens:**
- Store in environment variables, not in configs
- Use \`.env\` file with \`.gitignore\`
- Never commit tokens to version control

**Access Control:**
- Discord: Use channel/guild restrictions
- Telegram: Whitelist specific chat IDs
- Slack: Limit workspace access

**Network Security:**
- All integrations run localhost by default
- Use tunnels (cloudflared) for external access
- Enable authentication for exposed endpoints

## Testing Integrations

**Discord:**
\`\`\`bash
# Test bot responds to DM
# Test mention in channel
# Test image upload and analysis
\`\`\`

**Cron Jobs:**
\`\`\`bash
# Run job immediately for testing
mama cron run JOB_ID

# List all jobs and next run times
mama cron list
\`\`\`

**Heartbeat:**
\`\`\`bash
# Trigger heartbeat check now
mama heartbeat trigger

# View heartbeat status
mama heartbeat status
\`\`\`

## Troubleshooting

**Bot Not Responding:**
1. Check token is correct
2. Verify bot has required permissions
3. Check Message Content Intent enabled (Discord)
4. Review logs for errors

**Cron Job Not Running:**
1. Validate cron expression syntax
2. Check job is enabled
3. Verify timezone configuration
4. Review scheduler logs

**Heartbeat Not Working:**
1. Check interval configuration
2. Verify not in quiet hours
3. Check HEARTBEAT.md exists and is readable
4. Review heartbeat logs

## Advanced Configuration

**Multi-Gateway Setup:**
Run Discord + Telegram simultaneously for different user groups

**Conditional Cron Jobs:**
Use prompts with conditions (e.g., "Only send report if data changed")

**Cascading Heartbeats:**
Chain heartbeat tasks (one task can schedule another)

**Skill Composition:**
Skills can invoke other skills for complex workflows

## Next Steps

After integration setup:
1. Test each integration individually
2. Monitor logs for errors
3. Adjust configurations as needed
4. Document your integration patterns
5. Share successful configurations with team
`;

export const PHASE_7_TOOL: ToolDefinition = {
  name: 'present_integration_options',
  description: `Present integration options for Discord, Slack, Telegram, cron jobs, heartbeat monitoring, and skills.
  Provide role-specific examples and save integrations.md with comprehensive setup guide.`,
  input_schema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        description: 'User role for tailored examples (developer, researcher, manager, or custom)',
        enum: ['developer', 'researcher', 'manager', 'custom'],
      },
      selected_integrations: {
        type: 'string',
        description:
          'Comma-separated list of integrations to enable (discord,slack,telegram,cron,heartbeat,skills)',
      },
      timezone: {
        type: 'string',
        description: 'User timezone for cron job scheduling (e.g., America/New_York, Asia/Seoul)',
      },
      quiet_hours: {
        type: 'string',
        description: 'Preferred quiet hours for heartbeat (e.g., "23-8" means 11PM to 8AM)',
      },
    },
    required: ['role'],
  },
};

/**
 * Tool to save integration tokens (Discord, Slack, Telegram) to config.yaml
 */
export const SAVE_INTEGRATION_TOKEN_TOOL: ToolDefinition = {
  name: 'save_integration_token',
  description: `Save a Discord, Slack, or Telegram bot token to config.yaml.
  Use this when user provides their bot token during onboarding.
  The token will be saved securely and the integration will be enabled.`,
  input_schema: {
    type: 'object',
    properties: {
      platform: {
        type: 'string',
        description: 'Platform name: discord, slack, or telegram',
        enum: ['discord', 'slack', 'telegram'],
      },
      token: {
        type: 'string',
        description: 'The bot token to save',
      },
      guild_id: {
        type: 'string',
        description: 'Discord guild ID (optional, for Discord only)',
      },
      chat_id: {
        type: 'string',
        description: 'Telegram chat ID (optional, for Telegram only)',
      },
    },
    required: ['platform', 'token'],
  },
};

/**
 * Handler for save_integration_token tool
 */
export async function handleSaveIntegrationToken(input: {
  platform: 'discord' | 'slack' | 'telegram';
  token: string;
  guild_id?: string;
  chat_id?: string;
}): Promise<{ success: boolean; message: string; error?: string }> {
  try {
    const config = await loadConfig();

    switch (input.platform) {
      case 'discord':
        config.discord = {
          enabled: true,
          token: input.token,
          default_channel_id: input.guild_id, // guild_id used as default channel
        };
        break;

      case 'slack':
        config.slack = {
          enabled: true,
          bot_token: input.token,
        };
        break;

      case 'telegram':
        config.telegram = {
          enabled: true,
          token: input.token,
          allowed_chats: input.chat_id ? [input.chat_id] : [],
        };
        break;
    }

    await saveConfig(config);

    return {
      success: true,
      message: `${input.platform} token saved successfully! Integration is now enabled.`,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to save token',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handler for saving multi-agent configuration
 */
export async function handleSaveMultiAgent(input: {
  enabled: boolean;
  agents?: Record<
    string,
    {
      name: string;
      tier: number;
      model?: string;
      enabled: boolean;
    }
  >;
}): Promise<{ success: boolean; message: string; error?: string }> {
  try {
    const config = await loadConfig();

    // Transform simple agent config to full AgentPersonaConfig format
    const agents: Record<string, any> = {};
    if (input.agents) {
      for (const [id, agent] of Object.entries(input.agents)) {
        agents[id] = {
          name: agent.name,
          display_name: agent.name,
          tier: agent.tier,
          model: agent.model || 'claude-sonnet-4-20250514',
          enabled: agent.enabled,
          trigger_prefix: `!${id.toLowerCase()}`,
          persona_file: `~/.mama/personas/${id}.md`,
        };
      }
    }

    config.multi_agent = {
      enabled: input.enabled,
      agents,
      loop_prevention: {
        max_chain_length: 3,
        cooldown_seconds: 300,
      },
    } as any;

    await saveConfig(config);

    return {
      success: true,
      message:
        'Multi-agent configuration saved successfully! Edit config.yaml to customize agent personas.',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to save multi-agent configuration',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function generateIntegrationGuide(options: IntegrationOptions): string {
  const role = options.role || 'default';
  const examples = ROLE_EXAMPLES[role] || ROLE_EXAMPLES.default;

  let content = INTEGRATION_INSTRUCTIONS;

  content += '\n\n---\n\n';
  content += examples;
  if (
    options.discord ||
    options.slack ||
    options.telegram ||
    options.cronJobs ||
    options.heartbeat ||
    options.skills
  ) {
    content += '\n\n---\n\n## Your Configuration\n\n';

    if (options.discord?.enabled) {
      content += '### Discord\n';
      content += '✅ Enabled\n';
      content += `- Guilds configured: ${Object.keys(options.discord.guilds || {}).length}\n\n`;
    }

    if (options.slack?.enabled) {
      content += '### Slack\n';
      content += '✅ Enabled\n';
      content += `- Workspaces: ${options.slack.workspaces?.length || 0}\n\n`;
    }

    if (options.telegram?.enabled) {
      content += '### Telegram\n';
      content += '✅ Enabled\n';
      content += `- Allowed chats: ${options.telegram.allowedChats?.length || 0}\n\n`;
    }

    if (options.cronJobs && options.cronJobs.length > 0) {
      content += '### Cron Jobs\n';
      content += `✅ ${options.cronJobs.length} job(s) configured:\n`;
      for (const job of options.cronJobs) {
        content += `- **${job.id}**: ${job.cronExpr} ${job.enabled ? '(enabled)' : '(disabled)'}\n`;
      }
      content += '\n';
    }

    if (options.heartbeat?.enabled) {
      content += '### Heartbeat\n';
      content += '✅ Enabled\n';
      content += `- Interval: ${(options.heartbeat.interval / 60000).toFixed(0)} minutes\n`;
      content += `- Quiet hours: ${options.heartbeat.quietStart}:00 - ${options.heartbeat.quietEnd}:00\n\n`;
    }

    if (options.skills && options.skills.length > 0) {
      content += '### Skills\n';
      content += `✅ ${options.skills.length} skill(s) configured:\n`;
      for (const skill of options.skills) {
        content += `- **${skill.id}**: ${skill.path} ${skill.enabled ? '(enabled)' : '(disabled)'}\n`;
      }
      content += '\n';
    }
  }

  return content;
}

export function parseQuietHours(quietHours: string): { start: number; end: number } | null {
  const match = quietHours.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);

  if (start < 0 || start > 23 || end < 0 || end > 23) return null;

  return { start, end };
}
