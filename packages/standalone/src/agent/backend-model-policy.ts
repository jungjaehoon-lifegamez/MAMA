import type { BackendType } from './model-runner.js';

const DEFAULT_MODEL_BY_BACKEND: Readonly<Record<BackendType, string>> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
  cline: 'deepseek/deepseek-v4-flash',
};

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
