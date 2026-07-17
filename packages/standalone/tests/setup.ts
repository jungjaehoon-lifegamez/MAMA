import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach } from 'vitest';
import { resetConfigCache } from '../src/cli/config/config-manager.js';

process.env.MAMA_FORCE_TIER_3 ||= 'true';
// Legacy unit tests instantiate GatewayToolExecutor without the runtime envelope wrapper.
// Production remains deny-by-default unless this explicit opt-out is set.
process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS ||= 'true';
// Security telemetry (events/incidents/denylist) must never land in the live
// ~/.mama/logs during tests: fixture events (test-session, TEST-NET IPs) once
// drowned real signal 30:1 there.
process.env.MAMA_SECURITY_LOG_DIR ||= mkdtempSync(join(tmpdir(), 'mama-test-security-'));

beforeEach(() => {
  process.env.MAMA_FORCE_TIER_3 ||= 'true';
  process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS ||= 'true';
  process.env.MAMA_SECURITY_LOG_DIR ||= mkdtempSync(join(tmpdir(), 'mama-test-security-'));
  resetConfigCache(true);
});
