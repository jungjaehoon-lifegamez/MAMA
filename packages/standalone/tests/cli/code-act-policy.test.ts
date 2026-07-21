import { describe, expect, it } from 'vitest';

import {
  buildWorkOrderCodexAgentContext,
  deriveCodeActToolPolicy,
  resolveCodeActMemoryScopes,
  resolveCodeActRawConnectors,
  resolveCodeActAgentPolicy,
} from '../../src/cli/commands/start.js';

describe('STORY-B6: Code-Act runtime policy hardening', () => {
  describe('AC #1: deriveCodeActToolPolicy enforces configured agent allowlists', () => {
    it('does not let request allowed_tools widen configured agent permissions', () => {
      const policy = deriveCodeActToolPolicy(
        {
          agentId: 'dashboard',
          allowedTools: ['*'],
          blockedTools: ['mama_update'],
        },
        {
          name: 'dashboard',
          display_name: 'Dashboard',
          trigger_prefix: '!dashboard',
          tier: 2,
          useCodeAct: true,
          gateway_tool_permissions: {
            allowed: ['mama_search', 'report_publish'],
            blocked: ['mama_save'],
          },
        }
      );

      expect(policy).toEqual({
        allowedTools: ['mama_search', 'report_publish'],
        blockedTools: ['mama_save', 'mama_update'],
      });
    });

    it('allows request allowed_tools to narrow wildcard-configured agents', () => {
      const policy = deriveCodeActToolPolicy(
        {
          agentId: 'developer',
          allowedTools: ['mama_search'],
        },
        {
          name: 'developer',
          display_name: 'Developer',
          trigger_prefix: '!developer',
          tier: 1,
          useCodeAct: true,
          gateway_tool_permissions: {
            allowed: ['*'],
          },
        }
      );

      expect(policy.allowedTools).toEqual(['mama_search']);
    });
  });

  describe('AC #2: resolveCodeActAgentPolicy rejects malformed or unsupported agents', () => {
    it('rejects request-specified unknown Code-Act agents', () => {
      const resolved = resolveCodeActAgentPolicy(
        {
          agentId: 'unknown',
          allowedTools: ['*'],
        },
        {
          dashboard: {
            name: 'dashboard',
            display_name: 'Dashboard',
            trigger_prefix: '!dashboard',
            tier: 2,
          },
        },
        'dashboard'
      );

      expect(resolved).toMatchObject({
        error: 'Unknown Code-Act agent: unknown',
      });
    });

    it('rejects a missing default Code-Act agent', () => {
      const resolved = resolveCodeActAgentPolicy(
        undefined,
        {
          dashboard: {
            name: 'dashboard',
            display_name: 'Dashboard',
            trigger_prefix: '!dashboard',
            tier: 2,
            useCodeAct: true,
          },
        },
        'conductor'
      );

      expect(resolved).toMatchObject({
        error: 'Unknown Code-Act agent: conductor',
      });
    });

    it('rejects existing agents that have not opted into Code-Act', () => {
      const resolved = resolveCodeActAgentPolicy(
        {
          agentId: 'memory',
          allowedTools: ['*'],
        },
        {
          memory: {
            name: 'memory',
            display_name: 'Memory',
            trigger_prefix: '!memory',
            tier: 3,
          },
        },
        'memory'
      );

      expect(resolved).toMatchObject({
        error: 'Agent is not configured for Code-Act: memory',
      });
    });
  });

  describe('AC #3: resolveCodeActRawConnectors deduplicates connector visibility', () => {
    it('uses enabled connector names as Code-Act raw connector visibility', () => {
      expect(resolveCodeActRawConnectors(['kagemusha', 'kagemusha', ''])).toEqual(['kagemusha']);
    });
  });

  describe('AC #4: resolveCodeActMemoryScopes aggregates active raw-backed memory scopes', () => {
    it('adds active raw-backed memory scopes to Code-Act context_compile envelopes', () => {
      const adapter = {
        prepare: () => ({
          all: () => [
            { kind: 'project', id: 'project_tinklestar' },
            { kind: 'project', id: 'project_tinklestar' },
            { kind: 'project', id: 'kakao:user_alpha' },
            { kind: 'not-a-scope', id: 'ignored' },
            { kind: 'project', id: '  ' },
          ],
        }),
      };

      expect(
        resolveCodeActMemoryScopes([{ kind: 'global', id: 'system' }], adapter as never)
      ).toEqual([
        { kind: 'global', id: 'system' },
        { kind: 'project', id: 'project_tinklestar' },
        { kind: 'project', id: 'kakao:user_alpha' },
      ]);
    });
  });

  describe('AC #5: workorder runners receive an explicit Code-Act role', () => {
    it('maps board workorders to the dashboard agent gateway allowlist', () => {
      const context = buildWorkOrderCodexAgentContext(
        'board',
        {
          'dashboard-agent': {
            name: 'dashboard-agent',
            display_name: 'Dashboard',
            trigger_prefix: '!dashboard',
            tier: 2,
            useCodeAct: true,
            gateway_tool_permissions: {
              allowed: ['kagemusha_tasks', 'task_list', 'report_publish'],
              blocked: ['mama_save'],
            },
          },
        },
        'gpt-5.4'
      );

      expect(context).toMatchObject({
        source: 'operator',
        platform: 'cli',
        roleName: 'dashboard-agent',
        backend: 'codex',
        tier: 2,
        role: {
          allowedTools: ['code_act', 'kagemusha_tasks', 'task_list', 'report_publish'],
          blockedTools: ['mama_save'],
          model: 'gpt-5.4',
        },
      });
    });
  });
});
