import { describe, expect, it } from 'vitest';

import {
  assertEffortSupportedByBackend,
  effortSupportedByBackend,
  backendForModel,
  defaultModelForBackend,
  modelMatchesBackend,
  rescopeConfigModels,
  resolveBackendScopedModel,
} from '../../src/agent/backend-model-policy.js';

/**
 * Story F4: agent.effort is validated once, at boot, against the active backend
 *
 * An unsupported effort used to boot clean and then throw on EVERY model call - in
 * the owner-event lane that is a retry-then-dead page per batch, forever. The boot
 * gate fails once instead, naming the key and the accepted values. Because the
 * setting is GLOBAL and sub-agents may run a different backend than the active one,
 * a value no backend understands must be rejected whichever backend is active.
 *
 * Acceptance Criteria:
 * - AC: an unset effort is accepted on every backend
 * - AC: each backend accepts exactly its own effort levels
 * - AC: a codex-only effort is rejected when claude is active
 * - AC: an unknown effort is rejected on every backend, cline included
 * - AC: the predicate keeps a codex-only effort off the claude thinking flag
 */
describe('backend model policy', () => {
  describe('backendForModel', () => {
    it.each([
      ['claude-sonnet-4-6', 'claude'],
      ['claude-sonnet-5', 'claude'],
      ['claude-opus-4-1', 'claude'],
      ['claude-opus-4-1-20250805', 'claude'],
      ['CLAUDE-sonnet-5', 'claude'],
      ['gpt-5.4', 'codex'],
      ['GPT-5.4', 'codex'],
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
        warnings: [
          {
            target: 'roles.definitions.reviewer.model',
            from: 'custom-local-model',
            to: 'custom-local-model',
            backend: 'codex',
            unknownFamily: true,
          },
        ],
      });
    });

    it('passes through a short unknown model with an explicit warning entry', () => {
      expect(
        rescopeConfigModels({
          backend: 'claude',
          agentModel: 'claude-sonnet-4-6',
          roleModels: { reviewer: 'sonnet' },
        })
      ).toMatchObject({
        roleModels: { reviewer: 'sonnet' },
        changes: [],
        warnings: [
          {
            target: 'roles.definitions.reviewer.model',
            from: 'sonnet',
            to: 'sonnet',
            backend: 'claude',
            unknownFamily: true,
          },
        ],
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

  describe('assertEffortSupportedByBackend', () => {
    it('accepts an unset effort on every backend', () => {
      for (const backend of ['claude', 'codex', 'cline'] as const) {
        expect(() => assertEffortSupportedByBackend(backend, undefined)).not.toThrow();
      }
    });

    it.each(['low', 'medium', 'high', 'max'] as const)('accepts %s on claude', (effort) => {
      expect(() => assertEffortSupportedByBackend('claude', effort)).not.toThrow();
    });

    it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('accepts %s on codex', (effort) => {
      expect(() => assertEffortSupportedByBackend('codex', effort)).not.toThrow();
    });

    it('rejects a codex-only effort on claude, naming the key and the allowed values', () => {
      expect(() => assertEffortSupportedByBackend('claude', 'xhigh')).toThrow(
        /agent\.effort.*xhigh.*claude.*low, medium, high, max/s
      );
    });

    it('rejects an unknown effort on codex, naming the key and the allowed values', () => {
      expect(() => assertEffortSupportedByBackend('codex', 'ultra')).toThrow(
        /agent\.effort.*ultra.*codex.*low, medium, high, xhigh, max/s
      );
    });

    // agent.effort is global: a cline runtime still hands it to codex sub-agents, so
    // an unknown value must not slip through the boot gate just because cline itself
    // ignores the knob. Otherwise it boots clean and throws on every codex call.
    it('rejects an unknown effort while cline is active, since sub-agents still read it', () => {
      expect(() => assertEffortSupportedByBackend('cline', 'ultra')).toThrow(
        /agent\.effort.*ultra.*cline/s
      );
    });

    it.each(['low', 'medium', 'high', 'max', 'xhigh'] as const)(
      'accepts %s while cline is active, because another backend may use it',
      (effort) => {
        expect(() => assertEffortSupportedByBackend('cline', effort)).not.toThrow();
      }
    );
  });

  describe('effortSupportedByBackend', () => {
    it('keeps a codex-only effort off the claude thinking flag', () => {
      expect(effortSupportedByBackend('claude', 'xhigh')).toBe(false);
      expect(effortSupportedByBackend('codex', 'xhigh')).toBe(true);
    });

    it('accepts max on both backends and rejects unknown values everywhere', () => {
      expect(effortSupportedByBackend('claude', 'max')).toBe(true);
      expect(effortSupportedByBackend('codex', 'max')).toBe(true);
      expect(effortSupportedByBackend('claude', 'ultra')).toBe(false);
      expect(effortSupportedByBackend('codex', 'ultra')).toBe(false);
    });

    it('reports an unset effort as unsupported so callers skip the flag', () => {
      expect(effortSupportedByBackend('claude', undefined)).toBe(false);
    });
  });
});
