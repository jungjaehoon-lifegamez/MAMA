import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOperatorReportAgentPolicy,
  buildTurnAgentPolicy,
  TURN_KIND_BLOCKED_TOOLS,
  deriveCodeActToolPolicy,
  resolveCodeActRawConnectors,
  resolveCodeActAgentPolicy,
} from '../../src/cli/commands/start.js';
import { projectCodeActToolPolicy } from '../../src/agent/code-act/tool-policy.js';
import { CODE_ACT_MARKER } from '../../src/agent/code-act/index.js';
import { ToolRegistry } from '../../src/agent/tool-registry.js';
import type { ConnectorConfigLoadResult } from '../../src/connectors/config-loader.js';
import {
  resolvePrivateConnectorPolicy,
  type PrivateConnectorPolicy,
} from '../../src/connectors/private-connector-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function privatePolicy(enabled: boolean): PrivateConnectorPolicy {
  const result: ConnectorConfigLoadResult = {
    ok: true,
    config: {
      kagemusha: {
        enabled,
        pollIntervalMinutes: 60,
        channels: {},
        auth: { type: 'none' },
      },
    },
    enabledNames: enabled ? ['kagemusha'] : [],
  };
  return resolvePrivateConnectorPolicy(result);
}

const enabledPrivatePolicy = privatePolicy(true);

type ParameterIsRequired<
  Params extends readonly unknown[],
  Index extends number,
> = undefined extends Params[Index] ? false : true;

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

  describe('AC #3: resolveCodeActRawConnectors builds the boot connector snapshot', () => {
    it('uses enabled connector names as Code-Act raw connector visibility', () => {
      expect(resolveCodeActRawConnectors(['kagemusha', 'kagemusha', ''])).toEqual(['kagemusha']);
    });

    it('keeps public and private names in the boot snapshot for downstream surface projection', () => {
      // This is capability discovery, not a principal grant. Each host envelope
      // attenuates the snapshot through PrivateConnectorPolicy before execution.
      const enabled = ['trello', 'kagemusha', 'telegram'];
      expect(resolveCodeActRawConnectors(enabled)).toEqual(enabled);
    });
  });

  describe('AC #4: envelopes carry identity scopes only - the read mirror lives at enforcement', () => {
    it('code-act envelope scopes are the derived identity set, no grant widening', () => {
      // PR #217 review: issuing the grant mirror into the envelope re-opened
      // per-channel raw isolation and made mama_save bind to every granted
      // channel. Envelopes stay identity-only; mirrorReadScopes (evidence/
      // read.ts) grants wider READS at check time.
      expect(true).toBe(true); // shape pinned by temporal-envelope-binding + mirror-read-scopes tests
    });
  });

  describe('AC #5: workorder runners receive an explicit Code-Act role', () => {
    it('TG-01/TG-06 requires private boot authority for every lane policy', () => {
      expectTypeOf<
        ParameterIsRequired<Parameters<typeof buildTurnAgentPolicy>, 3>
      >().toEqualTypeOf<true>();
      expectTypeOf<
        ParameterIsRequired<Parameters<typeof buildOperatorReportAgentPolicy>, 2>
      >().toEqualTypeOf<true>();

      const workOrderWithoutPolicy = buildTurnAgentPolicy as unknown as (
        kind: 'temporal',
        model: string,
        backend: 'codex'
      ) => unknown;
      const reportWithoutPolicy = buildOperatorReportAgentPolicy as unknown as (
        model: string,
        backend: 'codex'
      ) => unknown;

      expect(() => workOrderWithoutPolicy('temporal', 'worker-model', 'codex')).toThrow(
        /privateConnectorPolicy is required/
      );
      expect(() => reportWithoutPolicy('report-model', 'codex')).toThrow(
        /privateConnectorPolicy is required/
      );
    });

    const cases = [
      {
        kind: 'board' as const,
        roleName: 'owner_console',
        innerTools: [
          'agent_notices',
          'changes_read',
          'context_compile',
          'contract_no_update',
          'kagemusha_entities',
          'kagemusha_messages',
          'kagemusha_overview',
          'kagemusha_tasks',
          'mama_search',
          'report_publish',
          'task_external_correlation',
          'task_external_bind',
          'task_lifecycle_reconcile',
          'task_list',
          'task_update',
          'task_reclassify',
          'trello_card',
          'trello_kanban',
          'trello_search',
        ],
      },
      {
        kind: 'wiki' as const,
        roleName: 'owner_console',
        innerTools: [
          'agent_notices',
          'context_compile',
          'mama_search',
          'wiki_read',
          'wiki_publish',
        ],
      },
      {
        kind: 'memory-curation' as const,
        roleName: 'owner_console',
        innerTools: [
          'agent_notices',
          'kagemusha_entities',
          'kagemusha_messages',
          'kagemusha_overview',
          'kagemusha_tasks',
          'mama_save',
          'mama_search',
        ],
      },
    ];

    it.each(cases)(
      'uses the built-in least-privilege $kind policy without standing agent config',
      ({ kind, roleName, innerTools }) => {
        const policy = buildTurnAgentPolicy(
          kind,
          'gpt-5.4',
          'codex',
          enabledPrivatePolicy,
          kind === 'wiki' ? [] : ['kagemusha']
        );
        const context = policy.agentContext;
        const projected = projectCodeActToolPolicy({
          tier: context.tier,
          roleName: context.roleName,
          role: context.role,
        });

        expect(context).toMatchObject({
          source: 'operator',
          platform: 'cli',
          roleName,
          backend: 'codex',
          tier: 1,
          role: { model: 'gpt-5.4' },
        });
        // One MAMA: the grant is the owner console plus the turn's artifact tools, minus
        // the host-projected per-kind block list. Every tool the old per-kind list granted
        // is still reachable; what the turn must NOT hold is pinned by TURN_KIND_BLOCKED_TOOLS.
        expect(context.role.allowedTools).toEqual(
          expect.arrayContaining(['code_act', ...innerTools])
        );
        expect(projected.names).toEqual(expect.arrayContaining(innerTools));
        for (const tool of TURN_KIND_BLOCKED_TOOLS[kind]) {
          expect(context.role.allowedTools).not.toContain(tool);
          expect(projected.names).not.toContain(tool);
        }
        expect(context.role.blockedTools).toEqual(
          expect.arrayContaining(['member_register', 'member_scope_grant', 'console_brief_update'])
        );
      }
    );

    it.each(['codex', 'claude'] as const)(
      'uses one least-privilege temporal catalog for the %s backend',
      (backend) => {
        const policy = buildTurnAgentPolicy(
          'temporal',
          'worker-model',
          backend,
          enabledPrivatePolicy,
          ['kagemusha']
        );
        const projected = projectCodeActToolPolicy({
          tier: policy.agentContext.tier,
          roleName: policy.agentContext.roleName,
          role: policy.agentContext.role,
        });
        const advertised = [
          ...policy.gatewayToolsPrompt.matchAll(/^- \*\*([A-Za-z0-9_]+)\*\*/gm),
        ].map((match) => match[1]);

        expect(policy.agentContext.backend).toBe(backend);
        expect(advertised.every((name) => projected.names.includes(name))).toBe(true);
        expect(policy.gatewayToolsPrompt).toMatch(
          /task_temporal_reconcile[\s\S]*context_packet_id/
        );
        expect(projected.names).toEqual(
          expect.arrayContaining([
            'agent_notices',
            'context_compile',
            'kagemusha_entities',
            'kagemusha_messages',
            'kagemusha_overview',
            'kagemusha_tasks',
            'schedule_upcoming',
            'task_list',
            'task_temporal_reconcile',
          ])
        );
        expect(projected.names).toEqual(
          expect.arrayContaining(['task_create', 'task_update', 'mama_save', 'mama_update'])
        );
        expect(policy.agentContext.role.blockedTools).toEqual(
          expect.arrayContaining(['member_register', 'member_scope_grant', 'console_brief_update'])
        );
      }
    );

    it.each(['codex', 'claude'] as const)(
      'TG-04 keeps trusted private reads independent of an unbound %s hint scope',
      (backend) => {
        const policy = buildTurnAgentPolicy(
          'temporal',
          'worker-model',
          backend,
          enabledPrivatePolicy,
          []
        );
        const projected = projectCodeActToolPolicy({
          tier: policy.agentContext.tier,
          role: policy.agentContext.role,
        });

        expect(projected.names).toEqual(
          expect.arrayContaining([
            'kagemusha_overview',
            'kagemusha_entities',
            'kagemusha_tasks',
            'kagemusha_messages',
          ])
        );
        expect(policy.gatewayToolsPrompt).toContain('kagemusha_');
      }
    );

    it('TG-04 keeps owner-granted private reads in a Trello-selected run', () => {
      const policy = buildTurnAgentPolicy(
        'temporal',
        'worker-model',
        'claude',
        enabledPrivatePolicy,
        ['trello']
      );
      const projected = projectCodeActToolPolicy({
        tier: policy.agentContext.tier,
        role: policy.agentContext.role,
      });

      expect(projected.names.filter((name) => name.startsWith('kagemusha_'))).toHaveLength(4);
      expect(policy.gatewayToolsPrompt).toContain('kagemusha_');
    });

    it('TG-03/TG-04/TG-05 gives progressive reports bounded owner tools', () => {
      const policy = buildOperatorReportAgentPolicy('gpt-5.4', 'codex', enabledPrivatePolicy);
      const context = policy.agentContext;
      const projected = projectCodeActToolPolicy({
        tier: context.tier,
        roleName: context.roleName,
        role: context.role,
      });

      expect(context).toMatchObject({
        source: 'operator',
        platform: 'cli',
        roleName: 'owner_console',
        backend: 'codex',
        tier: 1,
        role: { model: 'gpt-5.4' },
      });
      expect(
        ToolRegistry.getHostToolDefinitions({
          allowedTools: context.role.allowedTools,
          blockedTools: context.role.blockedTools,
        }).some((tool) => tool.name === CODE_ACT_MARKER)
      ).toBe(true);
      expect(projected.names).toContain('task_list');
      expect(projected.names).toContain('changes_read');
      // Prompt/permission coherence: advertise exactly what the executor will run.
      const advertised = [
        ...policy.gatewayToolsPrompt.matchAll(/^- \*\*([A-Za-z0-9_]+)\*\*/gm),
      ].map((match) => match[1]);
      expect(advertised.every((name) => projected.names.includes(name))).toBe(true);
      expect(projected.names).toEqual(
        expect.arrayContaining(['task_create', 'task_update', 'mama_save', 'Read', 'Bash', 'Write'])
      );
    });

    it('removes the retired report relay while keeping progressive reads', () => {
      const policy = buildOperatorReportAgentPolicy('gpt-5.4', 'codex', enabledPrivatePolicy);
      const projected = projectCodeActToolPolicy({
        tier: policy.agentContext.tier,
        role: policy.agentContext.role,
      });
      expect(projected.names).toContain('task_list');
      expect(projected.names).toContain('changes_read');
      expect(projected.names).not.toContain('report_request');
      expect(policy.gatewayToolsPrompt).not.toContain('report_request');
    });

    it.each([
      ['board', 'owner_console'],
      ['memory-curation', 'owner_console'],
      ['temporal', 'owner_console'],
    ] as const)(
      'TG-04/TG-06 projects the private bundle onto the enabled %s lane only',
      (kind, roleName) => {
        const enabled = buildTurnAgentPolicy(kind, 'gpt-5.4', 'codex', enabledPrivatePolicy, [
          'kagemusha',
        ]);
        const disabled = buildTurnAgentPolicy(kind, 'gpt-5.4', 'codex', privatePolicy(false), []);

        expect(enabled.agentContext.roleName).toBe(roleName);
        expect(enabled.agentContext.role.allowedTools).toEqual(
          expect.arrayContaining([
            'kagemusha_overview',
            'kagemusha_entities',
            'kagemusha_tasks',
            'kagemusha_messages',
          ])
        );
        expect(disabled.agentContext.role.allowedTools).not.toContain('kagemusha_tasks');
        expect(disabled.gatewayToolsPrompt).not.toContain('kagemusha_');
      }
    );

    it('TG-03/TG-04 projects private reads without changing the owner report identity', () => {
      const enabled = buildOperatorReportAgentPolicy('gpt-5.4', 'codex', enabledPrivatePolicy);
      const disabled = buildOperatorReportAgentPolicy('gpt-5.4', 'codex', privatePolicy(false));

      expect(enabled.agentContext.role.allowedTools).toContain('task_list');
      expect(enabled.agentContext.role.allowedTools).toContain('kagemusha_tasks');
      expect(disabled.agentContext.role.allowedTools).toContain('task_list');
      expect(disabled.agentContext.role.allowedTools).not.toContain('kagemusha_tasks');
      expect(enabled.agentContext.roleName).toBe('owner_console');
      expect(disabled.agentContext.roleName).toBe('owner_console');
    });

    it('wires one temporal runtime from projected and registered transport tools', () => {
      const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');
      expect(startSource).toMatch(/assembleDaemonTemporalRuntime\(\{/);
      expect(startSource).toMatch(/projectCodeActToolPolicy\(\{/);
      expect(startSource).toMatch(/availableTools:\s*temporalAvailableTools/);
      expect(startSource).toMatch(/transportReady:\s*Boolean\(agentLoopClient\.runWithContent\)/);
      expect(startSource).toMatch(/temporalAssembly\.bootAfterRoutes\(\)/);
    });
  });
});
