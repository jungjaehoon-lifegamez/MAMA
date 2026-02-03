# Role Management System

**Last Updated:** 2026-02-03

This document explains the role-based permission system for MAMA agents.

---

## Overview

Different message sources (Discord, Viewer, Telegram) have different trust levels and capabilities. The Role Management system ensures:

1. **Security** - External bots can't execute dangerous commands
2. **Context** - Agents know their capabilities and limitations
3. **Flexibility** - Roles are configurable per deployment

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Role-Aware Execution Flow                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Message arrives from source (discord, viewer, telegram)         │
│       ↓                                                          │
│  RoleManager.getRoleForSource(source)                            │
│       ↓                                                          │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ Source Mapping:                                       │       │
│  │   viewer  → os_agent    (full access)                │       │
│  │   discord → chat_bot    (limited)                    │       │
│  │   telegram → chat_bot   (limited)                    │       │
│  │   slack   → chat_bot    (limited)                    │       │
│  │   chatwork → chat_bot   (limited)                    │       │
│  │   cron    → scheduler   (background tasks)           │       │
│  └──────────────────────────────────────────────────────┘       │
│       ↓                                                          │
│  AgentContext created with:                                      │
│   - platform (source)                                            │
│   - roleName                                                     │
│   - role (RoleConfig)                                            │
│   - capabilities[]                                               │
│   - limitations[]                                                │
│       ↓                                                          │
│  ContextPromptBuilder.build(context)                             │
│   → Generates role-aware system prompt section                   │
│       ↓                                                          │
│  GatewayToolExecutor.execute(toolName, input, context)           │
│   → Validates tool permission before execution                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Role Configuration

### RoleConfig Interface

```typescript
interface RoleConfig {
  /** Tools this role can use (* = all) */
  allowedTools: string[];

  /** Tools explicitly blocked */
  blockedTools: string[];

  /** File paths this role can access (glob patterns) */
  allowedPaths: string[];

  /** Can execute system commands */
  systemControl: boolean;

  /** Can access sensitive config (tokens, keys) */
  sensitiveAccess: boolean;

  /** Maximum agentic turns per request */
  maxTurns?: number;

  /** Model override for this role */
  model?: string;
}
```

### Default Roles

#### os_agent (Viewer)

```typescript
{
  model: 'claude-sonnet-4-20250514',
  allowedTools: ['*'],
  allowedPaths: ['~/**'],
  systemControl: true,
  sensitiveAccess: true,
  maxTurns: 20,
}
```

Full system access. Used by MAMA OS Viewer for:

- System configuration
- Bot management (add_bot, set_permissions)
- File operations anywhere
- Bash execution

#### chat_bot (Discord/Telegram/Slack)

```typescript
{
  model: 'claude-sonnet-4-20250514',
  allowedTools: ['mama_*', 'Read', 'discord_send', 'translate_image'],
  blockedTools: ['Bash', 'Write', 'save_integration_token'],
  allowedPaths: ['~/.mama/workspace/**'],
  systemControl: false,
  sensitiveAccess: false,
  maxTurns: 10,
}
```

Limited access for external messengers:

- MAMA memory tools (search, save, etc.)
- Platform-specific send tools
- Read-only file access in workspace
- No system commands

---

## Context Prompt Injection

The `ContextPromptBuilder` generates a prompt section that tells the agent:

```markdown
## Current Context

**Platform**: Discord
**Channel**: #lifegamez (LifeGamez)
**Role**: chat_bot

### Capabilities

- Search and save decisions (mama_search, mama_save)
- Send messages to Discord (discord_send)
- Read files in workspace (~/.mama/workspace/)

### Limitations

- Cannot execute system commands (Bash blocked)
- Cannot write or edit files outside workspace
- Cannot access sensitive configuration
- Maximum 10 turns per conversation

### Guidelines

- Be helpful but concise (messenger format)
- Save important decisions to MAMA memory
- Ask user to use MAMA OS Viewer for system tasks
```

---

## Permission Validation

### Tool Validation

```typescript
// In GatewayToolExecutor
if (!roleManager.isToolAllowed(role, toolName)) {
  return {
    error: `Tool '${toolName}' is not allowed for role '${roleName}'`,
    blocked: true,
  };
}
```

### Path Validation

```typescript
// For file operations
if (!roleManager.isPathAllowed(role, filePath)) {
  return {
    error: `Access denied to path '${filePath}'`,
    blocked: true,
  };
}
```

---

## Configuration (config.yaml)

### Custom Role Definitions

```yaml
roles:
  # Override default chat_bot role
  chat_bot:
    allowedTools:
      - mama_*
      - discord_send
      - Read
      - browser_screenshot # Allow screenshots
    blockedTools:
      - Bash
      - Write
    maxTurns: 15
    model: claude-sonnet-4-20250514

  # Custom role for specific use case
  data_analyst:
    allowedTools:
      - mama_*
      - Read
      - browser_*
    allowedPaths:
      - ~/.mama/workspace/data/**
      - ~/.mama/workspace/reports/**
    systemControl: false
    sensitiveAccess: false
```

### Source to Role Mapping

```yaml
source_roles:
  viewer: os_agent
  discord: chat_bot
  telegram: chat_bot
  slack: data_analyst # Custom mapping
```

---

## Security Considerations

### Sensitive Patterns

These patterns are blocked for non-viewer sources:

```typescript
const SENSITIVE_PATTERNS = [
  /discord.*token/i,
  /slack.*token/i,
  /telegram.*token/i,
  /api[_-]?key/i,
  /secret[_-]?key/i,
  /bot[_-]?token/i,
];
```

### Token Masking

When `get_config` tool is called by non-os_agent:

```typescript
// Original
{
  discord: {
    token: 'MTQ4ODkw...';
  }
}

// Masked
{
  discord: {
    token: '***';
  }
}
```

### Viewer-Only Operations

These operations require `os_agent` role:

- `add_bot` - Add new messenger bot
- `set_permissions` - Modify role permissions
- `delete_session` - Remove conversation sessions
- Direct config file modification

---

## Testing

```bash
# Run role manager tests
pnpm test tests/agent/role-manager.test.ts

# Run context prompt builder tests
pnpm test tests/agent/context-prompt-builder.test.ts
```

### Test Cases

1. Source correctly maps to role
2. Tool permission validation works
3. Path validation with glob patterns
4. Capabilities/limitations generation
5. Context prompt includes correct info
