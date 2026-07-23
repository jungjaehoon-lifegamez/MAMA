import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOperatorReportAgentPolicy,
  buildWorkOrderAgentPolicy,
  deriveCodeActToolPolicy,
  resolveCodeActMemoryScopes,
  resolveCodeActRawConnectors,
  scopeDaemonRawConnectors,
  resolveCodeActAgentPolicy,
} from '../../src/cli/commands/start.js';
import { projectCodeActToolPolicy } from '../../src/agent/code-act/tool-policy.js';
import { CODE_ACT_MARKER } from '../../src/agent/code-act/index.js';
import { ToolRegistry } from '../../src/agent/tool-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

    it('grants Trello only to host-issued board and temporal workorder principals', () => {
      const enabled = ['trello', 'kagemusha', 'telegram'];

      expect(scopeDaemonRawConnectors(enabled, 'workorder-board')).toEqual(enabled);
      expect(scopeDaemonRawConnectors(enabled, 'workorder-temporal')).toEqual(enabled);
      for (const principal of [
        'workorder-wiki',
        'workorder-memory-curation',
        'api-code-act',
        'operator-report',
      ] as const) {
        expect(scopeDaemonRawConnectors(enabled, principal)).toEqual(['kagemusha', 'telegram']);
      }
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
    const cases = [
      {
        kind: 'board' as const,
        roleName: 'workorder-board',
        innerTools: [
          'agent_notices',
          'context_compile',
          'contract_no_update',
          'kagemusha_entities',
          'kagemusha_messages',
          'kagemusha_overview',
          'kagemusha_tasks',
          'mama_search',
          'report_publish',
          'task_create',
          'task_list',
          'task_update',
        ],
      },
      {
        kind: 'wiki' as const,
        roleName: 'workorder-wiki',
        innerTools: ['agent_notices', 'context_compile', 'mama_search', 'obsidian', 'wiki_publish'],
      },
      {
        kind: 'memory-curation' as const,
        roleName: 'workorder-memory-curation',
        innerTools: [
          'agent_notices',
          'kagemusha_entities',
          'kagemusha_messages',
          'mama_save',
          'mama_search',
        ],
      },
    ];

    it.each(cases)(
      'uses the built-in least-privilege $kind policy without standing agent config',
      ({ kind, roleName, innerTools }) => {
        const policy = buildWorkOrderAgentPolicy(kind, 'gpt-5.4', 'codex');
        const context = policy.agentContext;
        const projected = projectCodeActToolPolicy({ tier: context.tier, role: context.role });

        expect(context).toMatchObject({
          source: 'operator',
          platform: 'cli',
          roleName,
          backend: 'codex',
          tier: 2,
          role: {
            blockedTools: [],
            model: 'gpt-5.4',
          },
        });
        expect(context.role.allowedTools).toEqual(['code_act', ...innerTools]);
        expect(projected.names).toEqual(innerTools);
      }
    );

    it.each(['codex', 'claude'] as const)(
      'uses one least-privilege temporal catalog for the %s backend',
      (backend) => {
        const policy = buildWorkOrderAgentPolicy('temporal', 'worker-model', backend);
        const projected = projectCodeActToolPolicy({
          tier: policy.agentContext.tier,
          role: policy.agentContext.role,
        });
        const advertised = [
          ...policy.gatewayToolsPrompt.matchAll(/^- \*\*([A-Za-z0-9_]+)\*\*/gm),
        ].map((match) => match[1]);

        expect(policy.agentContext.backend).toBe(backend);
        expect(advertised.sort()).toEqual([...projected.names].sort());
        expect(policy.gatewayToolsPrompt).toMatch(
          /task_temporal_reconcile[\s\S]*context_packet_id/
        );
        expect(projected.names).toEqual([
          'agent_notices',
          'context_compile',
          'kagemusha_entities',
          'kagemusha_messages',
          'kagemusha_overview',
          'kagemusha_tasks',
          'schedule_upcoming',
          'task_list',
          'task_temporal_reconcile',
        ]);
        for (const forbidden of [
          'task_create',
          'task_update',
          'mama_save',
          'mama_update',
          'Read',
          'Write',
          'Bash',
          'os_set_model',
          'browser_click',
          'report_publish',
        ]) {
          expect(projected.names).not.toContain(forbidden);
          expect(policy.gatewayToolsPrompt).not.toContain(`**${forbidden}**`);
        }
      }
    );

    it('gives the operator report lane a Code-Act role so it can execute gather tools', () => {
      const policy = buildOperatorReportAgentPolicy('gpt-5.4', 'codex');
      const context = policy.agentContext;
      const projected = projectCodeActToolPolicy({ tier: context.tier, role: context.role });

      expect(context).toMatchObject({
        source: 'operator',
        platform: 'cli',
        roleName: 'operator-report',
        backend: 'codex',
        // The report may mama_save, matching the write tier its envelope already carries.
        tier: 2,
        role: { blockedTools: [], model: 'gpt-5.4' },
      });
      // The regression this guards: without a role, roleAllowsOuterCodeAct() returns
      // false, the generic gateway catalog is stripped, and the report agent runs with
      // ZERO tool definitions - every full report then logs "executed NO gateway gather
      // tools" while still being sent.
      expect(
        ToolRegistry.getHostToolDefinitions({
          allowedTools: context.role.allowedTools,
          blockedTools: context.role.blockedTools,
        }).some((tool) => tool.name === CODE_ACT_MARKER)
      ).toBe(true);
      expect(projected.names).toEqual([
        'context_compile',
        'kagemusha_entities',
        'kagemusha_messages',
        'kagemusha_overview',
        'kagemusha_tasks',
        'mama_recall',
        'mama_save',
        'mama_search',
        'report_publish',
        'schedule_upcoming',
        'task_list',
      ]);
      // Prompt/permission coherence: advertise exactly what the executor will run.
      const advertised = [
        ...policy.gatewayToolsPrompt.matchAll(/^- \*\*([A-Za-z0-9_]+)\*\*/gm),
      ].map((match) => match[1]);
      expect(advertised.sort()).toEqual([...projected.names].sort());
      // The report envelope grants no send surface and filters trello out of its raw
      // connectors, so no destination or task-mutation tool may be advertised.
      for (const forbidden of ['task_create', 'task_update', 'send_message', 'Bash', 'Write']) {
        expect(projected.names).not.toContain(forbidden);
        expect(policy.gatewayToolsPrompt).not.toContain(`**${forbidden}**`);
      }
    });

    it('covers every gather tool the report audit counts as substance', () => {
      const policy = buildOperatorReportAgentPolicy('gpt-5.4', 'codex');
      const projected = projectCodeActToolPolicy({
        tier: policy.agentContext.tier,
        role: policy.agentContext.role,
      });
      // report-run.ts GATHER_TOOLS: a full report that executes none of these is WARNED
      // as substance-unverified, so the role must be able to execute all of them.
      for (const gather of [
        'kagemusha_overview',
        'kagemusha_entities',
        'kagemusha_tasks',
        'kagemusha_messages',
        'mama_recall',
        'mama_search',
        'context_compile',
      ]) {
        expect(projected.names).toContain(gather);
      }
    });

    it('passes the report role into the report lane run', () => {
      const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');
      const reportRun = startSource.slice(
        startSource.indexOf('sessionKey: OPERATOR_REPORT_SESSION_KEY')
      );
      // A report run without agentContext is exactly the zero-tool regression; the
      // freshSession marker anchors the assertion to the report lane's run options.
      expect(reportRun).toMatch(
        /agentContext:\s*buildOperatorReportAgentPolicy\([\s\S]{0,120}?\)\s*\.?\s*\n?\s*\.?agentContext/
      );
      expect(reportRun.slice(0, reportRun.indexOf('freshSession: true'))).toContain('agentContext');
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
