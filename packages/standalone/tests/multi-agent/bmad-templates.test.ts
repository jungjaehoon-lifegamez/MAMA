/**
 * Tests for bmad-templates.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadBmadProjectConfig, buildBmadContext } from '../../src/multi-agent/bmad-templates.js';

process.env.MAMA_FORCE_TIER_3 = 'true';

describe('Story BMAD-001: BMAD template loading and context', () => {
  // Acceptance Criteria:
  // - AC1: Project config loading handles existing/missing files.
  // - AC2: Template loading covers bundled, external, and invalid names.
  // - AC3: Template listing includes bundled defaults.
  // - AC4: Output path generation sanitizes unsafe segments.
  // - AC5: Initialization and context builders return expected defaults.
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bmad-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('AC1: loadBmadProjectConfig', () => {
    it('should return parsed project config', async () => {
      mkdirSync(join(tempDir, 'bmad'), { recursive: true });
      writeFileSync(
        join(tempDir, 'bmad', 'config.yaml'),
        'project_name: MyApp\nphases_completed:\n  - brainstorm\n  - prd\n'
      );

      const config = await loadBmadProjectConfig(tempDir);
      expect(config).not.toBeNull();
      expect(config!.project_name).toBe('MyApp');
      expect(config!.phases_completed).toEqual(['brainstorm', 'prd']);
    });

    it('should return null when project config missing', async () => {
      const config = await loadBmadProjectConfig(join(tempDir, 'nonexistent'));
      expect(config).toBeNull();
    });
  });

  // Story: BMAD-001 - BMAD template loading
  // AC: When no config exists, defaults are returned
  describe('AC6: buildBmadContext', () => {
    it('should return project config when exists', async () => {
      mkdirSync(join(tempDir, 'bmad'), { recursive: true });
      writeFileSync(
        join(tempDir, 'bmad', 'config.yaml'),
        'project_name: MyApp\nproject_level: enterprise\nphases_completed:\n  - brainstorm\n'
      );

      const ctx = await buildBmadContext(tempDir);
      expect(ctx.initialized).toBe(true);
      expect(ctx.projectName).toBe('MyApp');
      expect(ctx.projectLevel).toBe('enterprise');
      expect(ctx.phasesCompleted).toEqual(['brainstorm']);
    });

    it('should return defaults when no config exists', async () => {
      const ctx = await buildBmadContext(join(tempDir, 'nonexistent'));
      expect(ctx.initialized).toBe(false);
      expect(ctx.projectName).toBe('unknown');
      expect(ctx.projectLevel).toBe('standard');
      expect(ctx.outputFolder).toBe('docs');
      expect(ctx.phasesCompleted).toEqual([]);
    });
  });
});
