import { CODEX_REASONING_EFFORTS } from './codex-home.js';
import type { BackendType } from './model-runner.js';

const DEFAULT_MODEL_BY_BACKEND: Readonly<Record<BackendType, string>> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
  cline: 'deepseek/deepseek-v4-flash',
};

const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const;

/** Every level any backend understands. agent.effort is global, so it must be one of these. */
const KNOWN_REASONING_EFFORTS: readonly string[] = [
  ...new Set<string>([...CLAUDE_REASONING_EFFORTS, ...CODEX_REASONING_EFFORTS]),
];

/**
 * Reasoning efforts each backend accepts. Codex mirrors CODEX_REASONING_EFFORTS - the
 * managed-config writer is the enforcer, this table only lets the boot say so before
 * the first model call.
 *
 * Cline reads no effort of its own, but it must NOT be unconstrained: agent.effort is
 * global, so a cline runtime still hands the value to codex and claude sub-agents. An
 * unknown value there would pass the boot gate and then throw on every codex call.
 */
const EFFORTS_BY_BACKEND: Readonly<Record<BackendType, readonly string[]>> = {
  claude: CLAUDE_REASONING_EFFORTS,
  codex: CODEX_REASONING_EFFORTS,
  cline: KNOWN_REASONING_EFFORTS,
};

/**
 * True only for an effort this backend actually accepts. Unset reads as false so a
 * caller can use it to decide whether to apply the knob at all.
 */
export function effortSupportedByBackend(
  backend: BackendType,
  effort: string | undefined | null
): boolean {
  if (effort === undefined || effort === null || effort === '') {
    return false;
  }
  return EFFORTS_BY_BACKEND[backend].includes(effort);
}

/**
 * The effort to hand an AgentLoop as `codexEffort`. Only a codex-backed loop writes the
 * shared managed config, so every other backend gets undefined - passing one backend's
 * level to another is how the flip-flop returns.
 *
 * The VALUE is deliberately not filtered here: codex accepts every level the boot gate
 * lets through, so a bad one is a real defect and must reach the loud throw in
 * buildMAMACodexAppServerConfig rather than be quietly downgraded to the default.
 */
export function codexEffortForBackend(
  backend: BackendType,
  effort: string | undefined | null
): string | undefined {
  return backend === 'codex' && effort ? effort : undefined;
}

/**
 * Boot gate for `agent.effort`. Without it an unsupported value boots clean and then
 * throws on EVERY model call - in the owner-event lane that is a retry-then-dead page
 * per batch, forever. Fail once, at boot, naming the key and the accepted values.
 */
export function assertEffortSupportedByBackend(
  backend: BackendType,
  effort: string | undefined | null
): void {
  if (effort === undefined || effort === null || effort === '') {
    return;
  }
  const allowed = EFFORTS_BY_BACKEND[backend];
  if (allowed.includes(effort)) {
    return;
  }
  throw new Error(
    `Invalid agent.effort "${effort}" for backend "${backend}" in ~/.mama/config.yaml; ` +
      `expected one of ${allowed.join(', ')}`
  );
}

export interface BackendModelChange {
  target: string;
  from: string | undefined;
  to: string;
}

export interface UnknownModelFamilyWarning {
  target: string;
  from: string;
  to: string;
  backend: BackendType;
  unknownFamily: true;
}

export type BackendModelPolicyEntry = BackendModelChange | UnknownModelFamilyWarning;

const emittedWarningKeys = new Set<string>();

export function defaultModelForBackend(backend: BackendType): string {
  return DEFAULT_MODEL_BY_BACKEND[backend];
}

export function backendForModel(model: string): BackendType | null {
  const normalizedModel = model.trim().toLowerCase();

  if (/^claude[-.]/.test(normalizedModel)) {
    return 'claude';
  }
  if (/^(?:gpt[-.]|o[0-9]|codex)/.test(normalizedModel)) {
    return 'codex';
  }
  if (normalizedModel.includes('/')) {
    return 'cline';
  }
  return null;
}

export function modelMatchesBackend(model: string, backend: BackendType): boolean {
  const modelBackend = backendForModel(model);
  return modelBackend === null || modelBackend === backend;
}

export function resolveBackendScopedModel(input: {
  backend: BackendType;
  model?: string;
  inheritedBackend?: BackendType;
  inheritedModel?: string;
  warningTarget?: string;
  onWarning?: (warning: UnknownModelFamilyWarning) => void;
}): string {
  const model = input.model?.trim();
  if (model) {
    const modelBackend = backendForModel(model);
    if (modelBackend === null) {
      input.onWarning?.({
        target: input.warningTarget ?? 'model',
        from: model,
        to: model,
        backend: input.backend,
        unknownFamily: true,
      });
      return model;
    }
    if (modelBackend === input.backend) {
      return model;
    }
  }
  if (input.backend === input.inheritedBackend && input.inheritedModel?.trim()) {
    return input.inheritedModel.trim();
  }
  return defaultModelForBackend(input.backend);
}

export function rescopeConfigModels(input: {
  backend: BackendType;
  agentModel?: string;
  roleModels: Record<string, string | undefined>;
}): {
  agentModel: string;
  roleModels: Record<string, string>;
  changes: BackendModelChange[];
  warnings?: UnknownModelFamilyWarning[];
} {
  const changes: BackendModelChange[] = [];
  const warnings: UnknownModelFamilyWarning[] = [];
  const agentModel = resolveBackendScopedModel({
    backend: input.backend,
    model: input.agentModel,
    warningTarget: 'agent.model',
    onWarning: (warning) => warnings.push(warning),
  });

  if (input.agentModel !== agentModel) {
    changes.push({ target: 'agent.model', from: input.agentModel, to: agentModel });
  }

  const roleModels: Record<string, string> = {};
  for (const [role, configuredModel] of Object.entries(input.roleModels)) {
    const roleModel = resolveBackendScopedModel({
      backend: input.backend,
      model: configuredModel,
      inheritedBackend: input.backend,
      inheritedModel: agentModel,
      warningTarget: `roles.definitions.${role}.model`,
      onWarning: (warning) => warnings.push(warning),
    });
    roleModels[role] = roleModel;

    if (configuredModel !== roleModel) {
      changes.push({
        target: `roles.definitions.${role}.model`,
        from: configuredModel,
        to: roleModel,
      });
    }
  }

  const result = { agentModel, roleModels, changes };
  return warnings.length > 0 ? { ...result, warnings } : result;
}

export function emitBackendModelWarnings(
  entries: readonly BackendModelPolicyEntry[],
  emit: (message: string) => void = console.warn
): void {
  for (const entry of entries) {
    const key = `${entry.target}|${String(entry.from)}|${entry.to}`;
    if (emittedWarningKeys.has(key)) {
      continue;
    }
    emittedWarningKeys.add(key);

    if ('unknownFamily' in entry && entry.unknownFamily) {
      emit(
        `[MAMA CONFIG WARNING] model ${JSON.stringify(entry.from)} not recognized as a ${entry.backend}-family model; passing through for ${entry.target}.`
      );
      continue;
    }

    emit(
      `[MAMA CONFIG WARNING] Rescoped ${entry.target} from ${JSON.stringify(entry.from)} to ${JSON.stringify(entry.to)}.`
    );
  }
}
