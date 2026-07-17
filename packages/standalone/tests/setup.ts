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
// drowned real signal 30:1 there. Assigned UNCONDITIONALLY - an inherited
// production value must not survive into the test run.
process.env.MAMA_SECURITY_LOG_DIR = mkdtempSync(join(tmpdir(), 'mama-test-security-'));
// Tests must never perform live RDAP lookups for fixture IPs.
process.env.MAMA_SECURITY_ENRICHMENT = 'false';

beforeEach(() => {
  process.env.MAMA_FORCE_TIER_3 ||= 'true';
  process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS ||= 'true';
  // ||= here: restore only if a test deleted the var (tests that override it
  // restore in their own afterEach); an unconditional mkdtemp per test would
  // create thousands of dirs per run.
  process.env.MAMA_SECURITY_LOG_DIR ||= mkdtempSync(join(tmpdir(), 'mama-test-security-'));
  process.env.MAMA_SECURITY_ENRICHMENT = 'false';
  resetConfigCache(true);
});
