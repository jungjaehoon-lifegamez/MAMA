function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const AGENT_ID_PATTERN = /^[a-z0-9_-]+$/;

export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_PATTERN.test(agentId);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidToolPermissions(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.allowed !== undefined && !isStringArray(value.allowed)) {
    return false;
  }
  if (value.blocked !== undefined && !isStringArray(value.blocked)) {
    return false;
  }
  return true;
}

const SUPPORTED_BACKENDS = new Set(['claude', 'codex', 'codex-mcp', 'gemini']);

function isSupportedBackend(value: unknown): boolean {
  return typeof value === 'string' && SUPPORTED_BACKENDS.has(value.trim());
}

export function validateManagedAgentCreateInput(input: Record<string, unknown>): string | null {
  if (typeof input.id !== 'string' || !isValidAgentId(input.id)) {
    return 'Invalid agent id. Use lowercase alphanumeric, dash, underscore.';
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return 'Invalid agent name.';
  }
  if (typeof input.model !== 'string' || input.model.trim().length === 0) {
    return 'Invalid model.';
  }
  if (!Number.isInteger(input.tier) || ![1, 2, 3].includes(Number(input.tier))) {
    return 'Invalid tier. Use 1, 2, or 3.';
  }
  if (input.backend !== undefined && !isSupportedBackend(input.backend)) {
    return 'Invalid backend.';
  }
  if (input.system !== undefined && typeof input.system !== 'string') {
    return 'Invalid system prompt.';
  }
  return null;
}

export function validateManagedAgentChanges(changes: unknown): string | null {
  if (!isRecord(changes)) {
    return 'Invalid changes payload.';
  }

  const validators: Record<string, (value: unknown) => boolean> = {
    name: (value) => typeof value === 'string' && value.trim().length > 0,
    display_name: (value) => typeof value === 'string' && value.trim().length > 0,
    tier: (value) => Number.isInteger(value) && [1, 2, 3].includes(Number(value)),
    backend: isSupportedBackend,
    model: (value) => typeof value === 'string' && value.trim().length > 0,
    enabled: (value) => typeof value === 'boolean',
    trigger_prefix: (value) => typeof value === 'string' && value.trim().length > 0,
    cooldown_ms: (value) => Number.isInteger(value) && Number(value) >= 0,
    can_delegate: (value) => typeof value === 'boolean',
    auto_continue: (value) => typeof value === 'boolean',
    effort: (value) => typeof value === 'string' && value.trim().length > 0,
    tool_permissions: isValidToolPermissions,
    persona_file: (value) => typeof value === 'string' && value.trim().length > 0,
    system: (value) => typeof value === 'string',
  };

  for (const [key, value] of Object.entries(changes)) {
    const validator = validators[key];
    if (!validator) {
      return `Unsupported agent field: ${key}`;
    }
    if (!validator(value)) {
      return `Invalid value for ${key}`;
    }
  }

  return null;
}
