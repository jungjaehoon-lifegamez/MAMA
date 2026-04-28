import { beforeEach } from 'vitest';
import { resetConfigCache } from '../src/cli/config/config-manager.js';

process.env.MAMA_FORCE_TIER_3 ||= 'true';
// Legacy unit tests instantiate GatewayToolExecutor without the runtime envelope wrapper.
// Production remains deny-by-default unless this explicit opt-out is set.
process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS ||= 'true';

beforeEach(() => {
  process.env.MAMA_FORCE_TIER_3 ||= 'true';
  process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS ||= 'true';
  resetConfigCache(true);
});
