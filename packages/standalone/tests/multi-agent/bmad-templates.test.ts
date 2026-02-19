/**
 * Tests for bmad-templates.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadBmadProjectConfig,
  loadBmadTemplate,
  buildOutputPath,
  isBmadInitialized,
  buildBmadContext,
  listAvailableTemplates,
} from '../../src/multi-agent/bmad-templates.js';

process.env.MAMA_FORCE_TIER_3 = 'true';

describe('Story BMAD-001: BMAD template loading and context', () => {
  // Acceptance Criteria:
  // - AC1: Project config loading handles existing/missing files.
  // - AC2: Template loading covers bundled, external, and invalid names.
  // - AC3: Template listing includes bundled defaults.
  // - AC4: Output path generation sanitizes unsafe segments.
  // - AC5: Initialization and context builders return expected defaults.
  let tempDir: string;
  const getLocalDateString = (): string => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

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

  describe('AC2: loadBmadTemplate', () => {
    it('should return template for prd (builtin or external)', async () => {
      const template = await loadBmadTemplate('prd');
      expect(template).not.toBeNull();
      expect(typeof template).toBe('string');
      expect(template!.length).toBeGreaterThan(100);
    });

    it('should return template for architecture (builtin or external)', async () => {
      const template = await loadBmadTemplate('architecture');
      expect(template).not.toBeNull();
      expect(typeof template).toBe('string');
      expect(template!.length).toBeGreaterThan(100);
    });

    it('should return template for product-brief (bundled)', async () => {
      const template = await loadBmadTemplate('product-brief');
      expect(template).not.toBeNull();
      expect(typeof template).toBe('string');
    });

    it('should return template for tech-spec (bundled)', async () => {
      const template = await loadBmadTemplate('tech-spec');
      expect(template).not.toBeNull();
      expect(typeof template).toBe('string');
    });

    it('should return null for nonexistent non-builtin template', async () => {
      const template = await loadBmadTemplate('nonexistent-template-xyz');
      expect(template).toBeNull();
    });

    it('should sanitize template name (path traversal)', async () => {
      const template = await loadBmadTemplate('../../../etc/passwd');
      expect(template).toBeNull();
    });
  });

  describe('AC3: listAvailableTemplates', () => {
    it('should include bundled template names', async () => {
      const names = await listAvailableTemplates();
      expect(names).toContain('prd');
      expect(names).toContain('architecture');
      expect(names).toContain('product-brief');
      expect(names).toContain('tech-spec');
      expect(names.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('AC4: buildOutputPath', () => {
    it('should build correct path with date', () => {
      const path = buildOutputPath('docs', 'prd', 'My Project');
      const date = getLocalDateString();
      expect(path).toBe(join('docs', `prd-my-project-${date}.md`));
    });

    it('should handle spaces in project name', () => {
      const path = buildOutputPath('output', 'architecture', 'MAMA OS');
      const date = getLocalDateString();
      expect(path).toBe(join('output', `architecture-mama-os-${date}.md`));
    });

    it('should handle spaces in type', () => {
      const path = buildOutputPath('docs', 'sprint plan', 'app');
      const date = getLocalDateString();
      expect(path).toBe(join('docs', `sprint-plan-app-${date}.md`));
    });

    it('should sanitize traversal and special characters', () => {
      const path = buildOutputPath('docs', '../sprint plan', '../../My Project');
      const date = getLocalDateString();
      expect(path).toBe(join('docs', 'sprint-plan-my-project-' + date + '.md'));
    });
  });

  describe('AC5: isBmadInitialized', () => {
    it('should return true when config exists', async () => {
      mkdirSync(join(tempDir, 'bmad'), { recursive: true });
      writeFileSync(join(tempDir, 'bmad', 'config.yaml'), 'project_name: test\n');

      expect(await isBmadInitialized(tempDir)).toBe(true);
    });

    it('should return false when config missing', async () => {
      expect(await isBmadInitialized(tempDir)).toBe(false);
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
