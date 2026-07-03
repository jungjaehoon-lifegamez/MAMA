import { describe, expect, it } from 'vitest';

import {
  buildVNextBootstrapPlan,
  isVNextStartupStepAllowed,
  shouldSkipVNextFanout,
  startVNextBootstrapRuntime,
} from '../../src/runtime-vnext/bootstrap.js';
import { resolveVNextRuntimeFlags } from '../../src/runtime-vnext/feature-flags.js';

describe('STORY-VNEXT-PR1-BOOTSTRAP: vNext bootstrap contract', () => {
  describe('AC: vNext mode is explicit and allowlist-driven', () => {
    it('enables vNext bootstrap only through explicit runtime opt-in', () => {
      expect(resolveVNextRuntimeFlags({}, { MAMA_VNEXT_RUNTIME: '1' })).toEqual({
        enabled: true,
        mode: 'bootstrap',
        source: 'env',
      });
      expect(resolveVNextRuntimeFlags({}, { MAMA_VNEXT_RUNTIME: 'true' })).toEqual({
        enabled: true,
        mode: 'bootstrap',
        source: 'env',
      });
      expect(resolveVNextRuntimeFlags({}, { MAMA_VNEXT_RUNTIME: 'bootstrap' })).toEqual({
        enabled: true,
        mode: 'bootstrap',
        source: 'env',
      });
      expect(resolveVNextRuntimeFlags({}, { MAMA_VNEXT_RUNTIME: 'off' })).toEqual({
        enabled: false,
        mode: 'legacy',
        source: 'env',
      });
      expect(resolveVNextRuntimeFlags({}, {})).toEqual({
        enabled: false,
        mode: 'legacy',
        source: 'default',
      });
    });

    it('parses numeric config flags and rejects invalid numeric config values', () => {
      expect(resolveVNextRuntimeFlags({ runtime: { vnext: 1 } }, {})).toEqual({
        enabled: true,
        mode: 'bootstrap',
        source: 'config',
      });
      expect(resolveVNextRuntimeFlags({ runtime_vnext: { enabled: 0 } }, {})).toEqual({
        enabled: false,
        mode: 'legacy',
        source: 'config',
      });
      expect(() => resolveVNextRuntimeFlags({ runtime: { vnext: 2 } }, {})).toThrow(
        'Invalid MAMA_VNEXT_RUNTIME value: 2'
      );
    });

    it('falls back to runtime_vnext.enabled when runtime.vnext is null-like', () => {
      expect(
        resolveVNextRuntimeFlags(
          {
            runtime: { vnext: undefined },
            runtime_vnext: { enabled: true },
          },
          {}
        )
      ).toEqual({
        enabled: true,
        mode: 'bootstrap',
        source: 'config',
      });
    });

    it('publishes the PR3 startup allowlist and ready primary operator contract', () => {
      const plan = buildVNextBootstrapPlan({
        enabled: true,
        mode: 'bootstrap',
        source: 'env',
      });

      expect(plan.allowedStartupSteps).toEqual([
        'config_read',
        'db_initialization',
        'primary_operator_schema',
        'primary_operator_runtime',
        'api_server_health',
        'manual_status_endpoints',
      ]);
      expect(plan.primaryOperator).toEqual({
        kind: 'primary_operator',
        status: 'prepared',
        mode: 'manual_batch',
        ingress: 'not_wired',
        cursorName: 'operator:primary',
        connector: 'manual',
        advancedThroughSeq: 0,
      });
      expect(isVNextStartupStepAllowed(plan, 'config_read')).toBe(true);
      expect(isVNextStartupStepAllowed(plan, 'connector_polling')).toBe(false);
    });

    it('marks every legacy fanout source as skipped only when vNext is enabled', () => {
      const enabledPlan = buildVNextBootstrapPlan({
        enabled: true,
        mode: 'bootstrap',
        source: 'env',
      });
      const disabledPlan = buildVNextBootstrapPlan({
        enabled: false,
        mode: 'legacy',
        source: 'default',
      });

      const forbiddenFanout = [
        'dashboard_agent_interval',
        'wiki_agent_interval',
        'ledger_memory_compose',
        'obsidian_launch',
        'mcp_config_rewrite',
        'agent_config_mutation',
        'persona_write',
        'heartbeat_timer',
        'token_keepalive_timer',
        'conductor_audit',
        'message_router_autonomous_process',
        'connector_polling',
        'connector_mode',
      ] as const;

      expect(enabledPlan.forbiddenFanout).toEqual([...forbiddenFanout]);
      for (const fanout of forbiddenFanout) {
        expect(shouldSkipVNextFanout(enabledPlan, fanout)).toBe(true);
        expect(shouldSkipVNextFanout(disabledPlan, fanout)).toBe(false);
      }
    });

    it('starts vNext bootstrap through the central allowlist only', async () => {
      const calls: string[] = [];
      const database = { close: () => calls.push('db.close') };
      const primaryOperator = {
        status: {
          kind: 'primary_operator' as const,
          status: 'prepared' as const,
          mode: 'manual_batch' as const,
          ingress: 'not_wired' as const,
          cursorName: 'operator:primary',
          connector: 'manual',
          advancedThroughSeq: 7,
        },
        processBatch: async () => ({
          status: 'idle' as const,
          processed: 0,
          advancedThroughSeq: 7,
          commits: [],
        }),
        processBatchWithChangedCommit: async () => ({
          status: 'idle' as const,
          processed: 0,
          advancedThroughSeq: 7,
          commits: [],
        }),
      };
      const apiServer = {
        start: async () => {
          calls.push('api.start');
        },
        stop: async () => {
          calls.push('api.stop');
        },
      };
      const plan = buildVNextBootstrapPlan({
        enabled: true,
        mode: 'bootstrap',
        source: 'env',
      });

      const result = await startVNextBootstrapRuntime(plan, {
        openDatabase: () => {
          calls.push('db.open');
          return database;
        },
        initializeOperatorSchema: () => {
          calls.push('operator.schema');
        },
        createPrimaryOperator: () => {
          calls.push('operator.create');
          return primaryOperator;
        },
        createApiServer: (status) => {
          calls.push(
            `api.create:${status.primaryOperator.status}:${status.primaryOperator.cursorName}`
          );
          return apiServer;
        },
        installShutdownHandlers: () => {
          calls.push('shutdown.install');
        },
        now: () => 1234,
      });

      expect(result.status.executedStartupSteps).toEqual(plan.allowedStartupSteps);
      expect(result.primaryOperator).toBe(primaryOperator);
      expect(result.status.primaryOperator).toEqual(primaryOperator.status);
      expect(calls).toEqual([
        'db.open',
        'operator.schema',
        'operator.create',
        'api.create:prepared:operator:primary',
        'api.start',
        'shutdown.install',
      ]);
    });

    it('closes the opened database if primary operator bootstrap fails', async () => {
      const calls: string[] = [];
      const database = { close: () => calls.push('db.close') };
      const plan = buildVNextBootstrapPlan({
        enabled: true,
        mode: 'bootstrap',
        source: 'env',
      });

      await expect(
        startVNextBootstrapRuntime(plan, {
          openDatabase: () => {
            calls.push('db.open');
            return database;
          },
          initializeOperatorSchema: () => {
            calls.push('operator.schema');
            throw new Error('schema unavailable');
          },
          createPrimaryOperator: () => {
            throw new Error('should not create operator');
          },
          createApiServer: () => ({
            start: async () => {
              calls.push('api.start');
            },
            stop: async () => {
              calls.push('api.stop');
            },
          }),
        })
      ).rejects.toThrow('schema unavailable');

      expect(calls).toEqual(['db.open', 'operator.schema', 'db.close']);
    });

    it('closes the opened database if vNext API startup fails', async () => {
      const calls: string[] = [];
      const database = { close: () => calls.push('db.close') };
      const plan = buildVNextBootstrapPlan({
        enabled: true,
        mode: 'bootstrap',
        source: 'env',
      });

      await expect(
        startVNextBootstrapRuntime(plan, {
          openDatabase: () => {
            calls.push('db.open');
            return database;
          },
          initializeOperatorSchema: () => {
            calls.push('operator.schema');
          },
          createPrimaryOperator: () => ({
            status: {
              kind: 'primary_operator',
              status: 'prepared',
              mode: 'manual_batch',
              ingress: 'not_wired',
              cursorName: 'operator:primary',
              connector: 'manual',
              advancedThroughSeq: 0,
            },
            processBatch: async () => ({
              status: 'idle',
              processed: 0,
              advancedThroughSeq: 0,
              commits: [],
            }),
            processBatchWithChangedCommit: async () => ({
              status: 'idle',
              processed: 0,
              advancedThroughSeq: 0,
              commits: [],
            }),
          }),
          createApiServer: () => ({
            start: async () => {
              calls.push('api.start');
              throw new Error('bind failed');
            },
            stop: async () => {
              calls.push('api.stop');
            },
          }),
          installShutdownHandlers: () => {
            calls.push('shutdown.install');
          },
        })
      ).rejects.toThrow('bind failed');

      expect(calls).toEqual(['db.open', 'operator.schema', 'api.start', 'db.close']);
    });
  });
});
