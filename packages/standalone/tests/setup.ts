import { beforeEach } from 'vitest';
import { resetConfigCache } from '../src/cli/config/config-manager.js';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

beforeEach(() => {
  process.env.MAMA_FORCE_TIER_3 ||= 'true';
  resetConfigCache(true);
});
