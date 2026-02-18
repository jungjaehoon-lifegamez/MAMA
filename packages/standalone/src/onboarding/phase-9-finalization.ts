/**
 * Phase 9: Onboarding Finalization
 *
 * Final phase that:
 * - Saves all profile files to markdown
 * - Generates quick-start.md guide
 * - Sends welcome message
 * - Calls onComplete callback to exit onboarding mode
 */

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { expandPath } from '../cli/config/config-manager.js';
import { clearOnboardingState } from './onboarding-state.js';
import type { ToolDefinition } from '../agent/types.js';

interface FinalizationInput {
  confirmed?: boolean;
  session_id?: string;
}

interface ProfileStatus {
  identity: boolean;
  user: boolean;
  soul: boolean;
  summary: boolean;
  security: boolean;
  integrations: boolean;
}

/**
 * Check which profile files exist
 */
async function checkProfileStatus(): Promise<ProfileStatus> {
  const mamaHome = expandPath('~/.mama');

  return {
    identity: existsSync(`${mamaHome}/IDENTITY.md`),
    user: existsSync(`${mamaHome}/USER.md`),
    soul: existsSync(`${mamaHome}/SOUL.md`),
    summary: existsSync(`${mamaHome}/summary.md`),
    security: existsSync(`${mamaHome}/security-acknowledgment.md`),
    integrations: existsSync(`${mamaHome}/integrations.md`),
  };
}

/**
 * Generate quick-start guide
 */
function generateQuickStartGuide(status: ProfileStatus): string {
  const timestamp = new Date().toISOString();

  return `# MAMA Quick Start Guide

*Generated: ${timestamp}*

## 🎉 Welcome to MAMA!

Your onboarding is complete. Here's everything you need to know to get started.

## 📂 Your Profile Files

${status.identity ? '✅' : '❌'} **IDENTITY.md** - Your AI's personality and origin story
${status.user ? '✅' : '❌'} **USER.md** - Information about you and your preferences
${status.soul ? '✅' : '❌'} **SOUL.md** - How you and MAMA work together
${status.summary ? '✅' : '❌'} **summary.md** - Discovery phase summary
${status.security ? '✅' : '❌'} **security-acknowledgment.md** - Security guidelines
${status.integrations ? '✅' : '❌'} **integrations.md** - Integration setup guide

All files are stored in: \`~/.mama/\`

## 🚀 Getting Started

### 1. Chat with MAMA

MAMA is now ready to assist you. Just start chatting!

- **Discord**: Message your bot in a channel or DM
- **Telegram**: Send a message to your bot
- **Slack**: Mention your bot in a channel
- **Standalone**: Use \`mama chat\` command

### 2. Built-in LLM Backend Integration

MAMA OS supports multiple authenticated CLI backends (Claude/Codex).

- Check active backend: \`mama status\`
- Change backend in config: \`~/.mama/config.yaml\` (\`agent.backend: claude | codex\`)
- Re-initialize with explicit backend: \`mama init --backend auto|claude|codex\`

### 3. Save Important Decisions

Use the memory system to track decisions:

\`\`\`
mama_save({
  type: "decision",
  topic: "project_setup",
  decision: "Use TypeScript with ESM modules",
  reasoning: "Better type safety and modern module system",
  confidence: 0.9
})
\`\`\`

### 4. Search Past Decisions

Find relevant context from your decision history:

\`\`\`
mama_search({
  query: "How did I set up the database?",
  limit: 5
})
\`\`\`

### 5. Save Session Checkpoints

Before ending a work session:

\`\`\`
mama_save({
  type: "checkpoint",
  summary: "Implemented user authentication. JWT working, need to add refresh tokens.",
  next_steps: "1. Add refresh token rotation\\n2. Test token expiration",
  open_files: ["src/auth/jwt.ts", "tests/auth.test.ts"]
})
\`\`\`

### 6. Resume Previous Sessions

Pick up where you left off:

\`\`\`
mama_load_checkpoint()
\`\`\`

## 🤖 Multi-Agent System

MAMA includes a built-in multi-agent team with 4 coordination modes:

| Mode | When | How |
|------|------|-----|
| **Delegation** | Simple single task | Conductor assigns to one agent |
| **Dynamic Workflows** | Multi-step tasks | Parallel DAG pipeline (\`workflow_plan\`) |
| **Council Discussion** | Architecture decisions | Multi-round debate (\`council_plan\`) |
| **UltraWork** | Deep autonomous work | Plan→Build→Retrospective loop |

### Activate Multi-Agent

In \`~/.mama/config.yaml\`:

\`\`\`yaml
multi_agent:
  enabled: true
  default_agent: conductor
\`\`\`

### Customize Personas

Agent persona files are in \`~/.mama/personas/\`:

- \`conductor.md\` — Orchestrator behavior
- \`developer.md\` — Builder behavior
- \`reviewer.md\` — Code review style
- \`architect.md\` — System design approach
- \`pm.md\` — Project management style

Edit these files to customize agent personalities and capabilities.

## 🔧 Customization

### Update Your Profile

Edit these files anytime to update your preferences:

- **IDENTITY.md** - Change AI personality traits
- **USER.md** - Update your information
- **SOUL.md** - Modify collaboration style

### Configure Integrations

${status.integrations ? 'See **integrations.md** for setup instructions for:' : 'Integration guide not found. You can set up:'}

- Discord bot
- Telegram bot
- Slack bot
- Cron jobs (scheduled tasks)
- Heartbeat monitoring
- Custom skills

### Security Settings

${status.security ? 'Review **security-acknowledgment.md** for:' : 'Security guidelines available at ~/.mama/security-acknowledgment.md:'}

- File access risks
- Command execution safety
- Network security
- Sandbox recommendations

## 📚 Key Concepts

### Decision Evolution

MAMA tracks how your decisions evolve over time:

\`\`\`
auth_v1 (failed: too complex)
  ↓ learned from
auth_v2 (partial: good but missing refresh)
  ↓ improved
auth_v3 (success: working well)
\`\`\`

### Edge Types

Connect related decisions:

- **supersedes** - Newer version replaces older (automatic for same topic)
- **builds_on** - Extends prior work
- **debates** - Alternative approach
- **synthesizes** - Merges multiple ideas

### Confidence Levels

Use confidence scores to indicate certainty:

- **0.9-1.0** - Very confident, proven approach
- **0.7-0.9** - Confident, good reasoning
- **0.5-0.7** - Moderate, some uncertainty
- **0.0-0.5** - Low confidence, experimental

## 🆘 Troubleshooting

### Check MAMA Status

\`\`\`bash
# View all profile files
ls ~/.mama/

# Check memory database
sqlite3 ~/.claude/mama-memory.db "SELECT COUNT(*) FROM decisions;"
\`\`\`

### Common Issues

**Bot not responding:**
1. Check bot token is correct
2. Verify permissions (Message Content Intent for Discord)
3. Check bot is online

**Memory not working:**
1. Ensure database exists: \`~/.claude/mama-memory.db\`
2. Check file permissions
3. Verify embedding server is running

**Can't find past decisions:**
1. Try broader search queries
2. Use \`mama_search({})\` to list all decisions
3. Check decision was saved with \`type: "decision"\`

## 🎯 Next Steps

1. **Test the memory system** - Save and search a test decision
2. **Set up integrations** - Configure Discord/Telegram/Slack
3. **Create your first checkpoint** - Practice session continuity
4. **Customize your profile** - Edit IDENTITY.md, USER.md, SOUL.md
5. **Explore the graph viewer** - Visualize decision connections (if HTTP server enabled)

## 📖 Additional Resources

- **MAMA Documentation**: See project README.md
- **Profile Files**: \`~/.mama/\`
- **Memory Database**: \`~/.claude/mama-memory.db\`
- **Integration Examples**: See integrations.md

---

*You're all set! MAMA is ready to help you remember, decide, and evolve.*
`;
}

/**
 * Generate welcome message
 */
function generateWelcomeMessage(status: ProfileStatus): string {
  const completedCount = Object.values(status).filter(Boolean).length;
  const totalCount = Object.keys(status).length;

  return `# 🎉 Onboarding Complete!

Welcome to MAMA! Your profile has been created and saved.

## ✅ Profile Status

Completed: ${completedCount}/${totalCount} files

${Object.entries(status)
  .map(([key, exists]) => {
    const icon = exists ? '✅' : '❌';
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
    return `${icon} ${label}`;
  })
  .join('\n')}

## 📂 Files Location

All your profile files are stored in: \`~/.mama/\`

## 🚀 Quick Start

Your quick-start guide has been saved to: \`~/.mama/quick-start.md\`

This guide includes:
- How to use MAMA's memory system
- How built-in backend routing works in MAMA OS
- How to save and search decisions
- How to set up integrations
- Troubleshooting tips
- Next steps

## 🎯 What's Next?

1. **Start chatting** - MAMA is ready to assist you
2. **Save your first decision** - Use \`mama_save\` to track important choices
3. **Explore integrations** - Set up Discord, Telegram, or Slack bots
4. **Customize your profile** - Edit IDENTITY.md, USER.md, SOUL.md anytime

---

*Onboarding complete. Switching to normal operation mode...*
`;
}

/**
 * Create the Phase 9 finalization tool
 */
export function createPhase9Tool(
  onComplete: () => void
): ToolDefinition & { handler: (input: FinalizationInput) => Promise<Record<string, unknown>> } {
  return {
    name: 'complete_onboarding',
    description:
      'Finalize onboarding by saving all profiles, generating quick-start guide, and completing setup. Call this ONLY when all previous phases are complete.',
    input_schema: {
      type: 'object',
      properties: {
        confirmed: {
          type: 'boolean',
          description: 'Confirm that onboarding is complete and ready to finalize',
        },
        session_id: {
          type: 'string',
          description: 'Session ID from autonomous discovery (optional)',
        },
      },
      required: [],
    },
    handler: async (input: FinalizationInput) => {
      try {
        const status = await checkProfileStatus();

        if (!input.confirmed) {
          const preview = generateWelcomeMessage(status);

          return {
            success: false,
            requires_confirmation: true,
            message: preview,
            profile_status: status,
            ready_to_complete: status.identity && status.user && status.soul,
            next_step: 'Call this tool again with confirmed: true to complete onboarding',
          };
        }

        if (!status.identity || !status.user || !status.soul) {
          return {
            success: false,
            error: 'Missing required profile files. IDENTITY.md, USER.md, and SOUL.md must exist.',
            profile_status: status,
            missing_files: [
              !status.identity && 'IDENTITY.md',
              !status.user && 'USER.md',
              !status.soul && 'SOUL.md',
            ].filter(Boolean),
          };
        }

        const quickStartContent = generateQuickStartGuide(status);
        const quickStartPath = expandPath('~/.mama/quick-start.md');
        await writeFile(quickStartPath, quickStartContent, 'utf-8');

        const welcomeMessage = generateWelcomeMessage(status);

        // Clear onboarding state now that we're done
        clearOnboardingState();

        onComplete();

        return {
          success: true,
          message: welcomeMessage,
          quick_start_path: quickStartPath,
          profile_status: status,
          onboarding_complete: true,
          files_created: {
            profiles: ['IDENTITY.md', 'USER.md', 'SOUL.md'].filter(
              (_, i) => [status.identity, status.user, status.soul][i]
            ),
            guides: ['quick-start.md'],
            optional: [
              status.summary && 'summary.md',
              status.security && 'security-acknowledgment.md',
              status.integrations && 'integrations.md',
            ].filter(Boolean),
          },
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : 'Unknown error during onboarding finalization',
        };
      }
    },
  };
}

/**
 * Export PHASE_9_TOOL for backward compatibility
 * (without handler, just the tool definition)
 */
export const PHASE_9_TOOL: ToolDefinition = {
  name: 'complete_onboarding',
  description:
    'Finalize onboarding by saving all profiles, generating quick-start guide, and completing setup. Call this ONLY when all previous phases are complete.',
  input_schema: {
    type: 'object',
    properties: {
      confirmed: {
        type: 'boolean',
        description: 'Confirm that onboarding is complete and ready to finalize',
      },
      session_id: {
        type: 'string',
        description: 'Session ID from autonomous discovery (optional)',
      },
    },
    required: [],
  },
};
