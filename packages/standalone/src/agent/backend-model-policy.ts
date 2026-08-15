import type { BackendType } from './model-runner.js';

const DEFAULT_MODEL_BY_BACKEND: Readonly<Record<BackendType, string>> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
  cline: 'deepseek/deepseek-v4-flash',
};

export function defaultModelForBackend(backend: BackendType): string {
  return DEFAULT_MODEL_BY_BACKEND[backend];
}

export function backendForModel(model: string): BackendType | null {
  const normalizedModel = model.trim();

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
}): string {
  const model = input.model?.trim();
  if (model && modelMatchesBackend(model, input.backend)) {
    return model;
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
  changes: Array<{ target: string; from: string | undefined; to: string }>;
} {
  const changes: Array<{ target: string; from: string | undefined; to: string }> = [];
  const agentModel = resolveBackendScopedModel({
    backend: input.backend,
    model: input.agentModel,
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

  return { agentModel, roleModels, changes };
}
