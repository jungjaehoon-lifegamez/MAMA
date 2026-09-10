import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach } from 'vitest';
import { resetConfigCache } from '../src/cli/config/config-manager.js';

// $HOME isolation. os.homedir() follows $HOME on macOS/Linux, so every
// homedir() caller in production code lands in a throwaway directory during
// tests. On 2026-09-10 a test run that initialised API routes without an
// isolated HOME rewrote the LIVE daemon's ~/.mama/mama-mcp-config.json and
// stripped every gateway tool from the running Claude backend. Set BEFORE any
// test file is imported; a test that overrides HOME itself is left alone
// (this runs once, at setup time, not per test).
process.env.MAMA_TEST_REAL_HOME ??= homedir();
const testHome = mkdtempSync(join(tmpdir(), 'mama-test-home-'));
mkdirSync(join(testHome, '.mama'), { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.MAMA_TEST_HOME = testHome;

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
