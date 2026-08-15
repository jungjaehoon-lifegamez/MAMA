import { describe, expect, it } from 'vitest';

import {
  backendForModel,
  defaultModelForBackend,
  modelMatchesBackend,
  rescopeConfigModels,
  resolveBackendScopedModel,
} from '../../src/agent/backend-model-policy.js';

describe('backend model policy', () => {
  describe('backendForModel', () => {
    it.each([
      ['claude-sonnet-4-6', 'claude'],
      ['claude-sonnet-5', 'claude'],
      ['claude-opus-4-1', 'claude'],
      ['claude-opus-4-1-20250805', 'claude'],
      ['gpt-5.4', 'codex'],
      ['gpt-5.6-sol', 'codex'],
      ['gpt-5.6-luna', 'codex'],
      ['o4-mini', 'codex'],
      ['deepseek/deepseek-v4-flash', 'cline'],
    ] as const)('classifies %s as %s', (model, backend) => {
      expect(backendForModel(model)).toBe(backend);
    });

    it('returns null for an unknown model family', () => {
      expect(backendForModel('custom-local-model')).toBeNull();
    });
  });

  describe('modelMatchesBackend', () => {
    it('accepts models classified for the active backend', () => {
      expect(modelMatchesBackend('gpt-5.6-sol', 'codex')).toBe(true);
    });

    it('rejects models classified for another backend', () => {
      expect(modelMatchesBackend('claude-sonnet-5', 'codex')).toBe(false);
    });

    it('conservatively accepts unknown model strings', () => {
      expect(modelMatchesBackend('custom-local-model', 'claude')).toBe(true);
    });
  });

  describe('resolveBackendScopedModel', () => {
    it('respects a same-backend explicit model', () => {
      expect(
        resolveBackendScopedModel({
          backend: 'codex',
          model: 'gpt-5.4',
          inheritedBackend: 'codex',
          inheritedModel: 'gpt-5.6-sol',
        })
      ).toBe('gpt-5.4');
    });

    it('ignores a cross-backend explicit model and uses the inherited model', () => {
      expect(
        resolveBackendScopedModel({
          backend: 'codex',
          model: 'claude-sonnet-5',
          inheritedBackend: 'codex',
          inheritedModel: 'gpt-5.6-sol',
        })
      ).toBe('gpt-5.6-sol');
    });

    it('keeps an unknown explicit model on the active backend', () => {
      expect(
        resolveBackendScopedModel({
          backend: 'codex',
          model: 'custom-local-model',
          inheritedBackend: 'codex',
          inheritedModel: 'gpt-5.6-sol',
        })
      ).toBe('custom-local-model');
    });
  });

  describe('rescopeConfigModels', () => {
    it('keeps a same-backend role override', () => {
      expect(
        rescopeConfigModels({
          backend: 'codex',
          agentModel: 'gpt-5.6-sol',
          roleModels: { reviewer: 'gpt-5.4' },
        })
      ).toEqual({
        agentModel: 'gpt-5.6-sol',
        roleModels: { reviewer: 'gpt-5.4' },
        changes: [],
      });
    });

    it('rescopes a cross-backend role override to the resolved agent model', () => {
      expect(
        rescopeConfigModels({
          backend: 'codex',
          agentModel: 'gpt-5.6-sol',
          roleModels: { reviewer: 'claude-sonnet-5' },
        })
      ).toEqual({
        agentModel: 'gpt-5.6-sol',
        roleModels: { reviewer: 'gpt-5.6-sol' },
        changes: [
          {
            target: 'roles.definitions.reviewer.model',
            from: 'claude-sonnet-5',
            to: 'gpt-5.6-sol',
          },
        ],
      });
    });

    it('does not rescope an unknown role model', () => {
      expect(
        rescopeConfigModels({
          backend: 'codex',
          agentModel: 'gpt-5.6-sol',
          roleModels: { reviewer: 'custom-local-model' },
        })
      ).toEqual({
        agentModel: 'gpt-5.6-sol',
        roleModels: { reviewer: 'custom-local-model' },
        changes: [],
      });
    });

    it('uses and records the backend default when the agent model is unset', () => {
      expect(
        rescopeConfigModels({
          backend: 'codex',
          roleModels: {},
        })
      ).toEqual({
        agentModel: defaultModelForBackend('codex'),
        roleModels: {},
        changes: [
          {
            target: 'agent.model',
            from: undefined,
            to: 'gpt-5.4',
          },
        ],
      });
    });

    it('rescopes and records a cross-backend agent model', () => {
      expect(
        rescopeConfigModels({
          backend: 'claude',
          agentModel: 'gpt-5.6-sol',
          roleModels: {},
        })
      ).toEqual({
        agentModel: 'claude-sonnet-4-6',
        roleModels: {},
        changes: [
          {
            target: 'agent.model',
            from: 'gpt-5.6-sol',
            to: 'claude-sonnet-4-6',
          },
        ],
      });
    });

    it('fills and records an unset role model from the resolved agent model', () => {
      expect(
        rescopeConfigModels({
          backend: 'codex',
          agentModel: 'gpt-5.6-sol',
          roleModels: { reviewer: undefined },
        })
      ).toEqual({
        agentModel: 'gpt-5.6-sol',
        roleModels: { reviewer: 'gpt-5.6-sol' },
        changes: [
          {
            target: 'roles.definitions.reviewer.model',
            from: undefined,
            to: 'gpt-5.6-sol',
          },
        ],
      });
    });
  });
});
