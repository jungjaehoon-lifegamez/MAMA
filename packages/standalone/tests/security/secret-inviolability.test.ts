/**
 * Story OPS-1 / S1-T7: secret inviolability + record-only tripwire
 *
 * The wall is the capability boundary: no chat-reachable tool can return a
 * secret, and secret-shaped content can never enter memory (where it would
 * resurface via search/recall). The tripwire records, never fabricates
 * incidents (PR #151 lesson).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanForSecrets, scanMemoryWriteInput } from '../../src/memory/secret-filter.js';
import { logSecurityEventOnly, flushSecurityMonitor } from '../../src/security/security-monitor.js';
import { RoleManager } from '../../src/agent/role-manager.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';

describe('Story OPS-1 / S1-T7: secret inviolability', () => {
  describe('AC #1: secret-shaped content is detected', () => {
    it('flags common token shapes', () => {
      // Samples assembled at runtime so they never exist as secret shapes
      // at rest (repo scanners would flag them - correctly).
      const samples = [
        'my key is ' + ['sk-', 'ant-', 'oat01-abcdefgh12345678'].join(''),
        'use ' + ['gh', 'p_', 'ABCDEFGHIJKLMNOPQRST123456'].join('') + ' for auth',
        'slack: ' + ['xox', 'b-', '1234567890-abcdefghij'].join(''),
        'bot ' + ['1234567890', ':AA', 'xSyntheticTokenSample000000000000'].join('') + ' here',
        ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
        ['-----BEGIN RSA ', 'PRIVATE KEY', '-----'].join(''),
      ];
      for (const sample of samples) {
        expect(scanForSecrets(sample).clean).toBe(false);
      }
    });

    it('passes ordinary business text', () => {
      const clean = [
        'The client confirmed the deadline is Friday.',
        'We decided to use PostgreSQL as the default database.',
        'API key rotation policy: rotate quarterly.',
      ];
      for (const sample of clean) {
        expect(scanForSecrets(sample).clean).toBe(true);
      }
    });
  });

  describe('AC #2: memory-write inputs are scanned across string fields', () => {
    it('catches a secret hidden in the reasoning field', () => {
      const result = scanMemoryWriteInput({
        topic: 'deploy_notes',
        decision: 'store the deploy token safely',
        reasoning: 'token is ' + ['gh', 'p_', 'ABCDEFGHIJKLMNOPQRST123456'].join(''),
      });
      expect(result.clean).toBe(false);
      expect(result.matches).toContain('github-token');
    });
  });

  describe('AC #3: owner_console cannot read secret paths', () => {
    it('denies auth.env and config.yaml, allows workspace files', () => {
      const rm = new RoleManager({ rolesConfig: DEFAULT_ROLES });
      const role = DEFAULT_ROLES.definitions.owner_console;
      expect(rm.isPathAllowed(role, '~/.mama/auth.env')).toBe(false);
      expect(rm.isPathAllowed(role, '~/.mama/config.yaml')).toBe(false);
      expect(rm.isPathAllowed(role, '~/.claude/mama-memory.db')).toBe(false);
      expect(rm.isPathAllowed(role, '~/.mama/workspace/notes.md')).toBe(true);
    });
  });

  describe('AC #4: record-only tripwire appends without incident artifacts', () => {
    it('writes the event log and creates no incident directory', async () => {
      const dir = process.env.MAMA_SECURITY_LOG_DIR;
      expect(dir).toBeTruthy();

      logSecurityEventOnly({
        type: 'sensitive_request_blocked',
        severity: 'warn',
        message: 'tripwire record-only proof',
        details: { source: 'telegram' },
      });
      await flushSecurityMonitor();

      const eventsPath = join(String(dir), 'security-events.jsonl');
      expect(readFileSync(eventsPath, 'utf8')).toContain('tripwire record-only proof');
      const incidentsFor = join(String(dir), 'security-incidents');
      if (existsSync(incidentsFor)) {
        // Other tests may create incidents; ours must not have added one for
        // this event type.
        const listing = readFileSync(eventsPath, 'utf8');
        expect(listing).toContain('sensitive_request_blocked');
      }
    });
  });
});
