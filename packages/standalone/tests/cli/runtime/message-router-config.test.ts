import { describe, expect, it } from 'vitest';

import type { MAMAConfig } from '../../../src/cli/config/types.js';
import { resolveMessageRouterConfig } from '../../../src/cli/runtime/message-router-config.js';

describe('Story PR17: message-router memory policy config', () => {
  describe('AC: default rollout remains explicit opt-in', () => {
    it('keeps implicit memory recall and legacy context search disabled by default', () => {
      const routerConfig = resolveMessageRouterConfig(
        {} as Pick<MAMAConfig, 'memory_policy'>,
        'claude'
      );

      expect(routerConfig).toMatchObject({
        backend: 'claude',
        implicitMemoryRecall: false,
        implicitLegacyContextSearch: false,
      });
    });

    it('passes explicit opt-ins through to MessageRouter config', () => {
      const routerConfig = resolveMessageRouterConfig(
        {
          memory_policy: {
            implicit_recall: true,
            implicit_legacy_context_search: true,
          },
        },
        'codex-mcp'
      );

      expect(routerConfig).toMatchObject({
        backend: 'codex-mcp',
        implicitMemoryRecall: true,
        implicitLegacyContextSearch: true,
      });
    });
  });
});
