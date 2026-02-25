import { beforeEach } from 'vitest';
import { resetConfigCache } from '../src/cli/config/config-manager.js';

beforeEach(() => {
  resetConfigCache(true);
});
