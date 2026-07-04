import type { MAMAConfig } from '../config/types.js';
import type { MessageRouterConfig } from '../../gateways/types.js';

export function resolveMessageRouterConfig(
  config: Pick<MAMAConfig, 'memory_policy'>,
  backend: NonNullable<MessageRouterConfig['backend']>
): MessageRouterConfig {
  return {
    backend,
    implicitMemoryRecall: config.memory_policy?.implicit_recall ?? false,
    implicitLegacyContextSearch: config.memory_policy?.implicit_legacy_context_search ?? false,
  };
}
