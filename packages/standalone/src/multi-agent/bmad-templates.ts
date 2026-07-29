/**
 * BMAD Templates Utility
 *
 * Loads BMAD config and templates at runtime for Conductor's
 * PLAN mode workflow generation. Runs in the daemon process (fs access).
 *
 * Template resolution order:
 *   1. External: ~/.claude/config/bmad/templates/{name}.md  (user override)
 *   2. Bundled:  templates/bmad/{name}.md                   (shipped with MAMA OS)
 *
 * Bundled templates are from BMAD-METHOD (MIT License, (c) 2025 BMad Code, LLC).
 * See templates/bmad/LICENSE for details.
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import * as yaml from 'js-yaml';

// ── Types ──────────────────────────────────────────────────────────

export interface BmadConfig {
  project_name?: string;
  project_level?: string;
  output_folder?: string;
  templates?: Record<string, string>;
  [key: string]: unknown;
}

export interface BmadProjectConfig extends BmadConfig {
  /** Project-local overrides */
  phases_completed?: string[];
}

export interface BmadContext {
  initialized: boolean;
  projectName: string;
  projectLevel: string;
  outputFolder: string;
  phasesCompleted: string[];
}

// ── Constants ──────────────────────────────────────────────────────

const GLOBAL_BMAD_DIR = join(homedir(), '.claude', 'config', 'bmad');
const GLOBAL_CONFIG_PATH = join(GLOBAL_BMAD_DIR, 'config.yaml');

// ── Public API ─────────────────────────────────────────────────────

/**
 * Load global BMAD config from ~/.claude/config/bmad/config.yaml
 */
export async function loadBmadGlobalConfig(): Promise<BmadConfig | null> {
  return loadYamlFile<BmadConfig>(GLOBAL_CONFIG_PATH);
}

/**
 * Load project-local BMAD config from {projectRoot}/bmad/config.yaml
 */
export async function loadBmadProjectConfig(
  projectRoot: string
): Promise<BmadProjectConfig | null> {
  const configPath = join(projectRoot, 'bmad', 'config.yaml');
  return loadYamlFile<BmadProjectConfig>(configPath);
}

/**
 * Build BMAD context for Conductor system prompt injection.
 * Merges global + project configs.
 */
export async function buildBmadContext(projectRoot?: string): Promise<BmadContext> {
  const globalConfig = await loadBmadGlobalConfig();
  const projectConfig = projectRoot ? await loadBmadProjectConfig(projectRoot) : null;

  const initialized = projectConfig !== null;
  const merged = { ...globalConfig, ...projectConfig };

  return {
    initialized,
    projectName: merged.project_name || 'unknown',
    projectLevel: merged.project_level || 'standard',
    outputFolder: merged.output_folder || 'docs',
    phasesCompleted: merged.phases_completed || [],
  };
}

/**
 * Build the BMAD context block to inject into Conductor's system prompt.
 */
export async function buildBmadPromptBlock(projectRoot?: string): Promise<string> {
  const ctx = await buildBmadContext(projectRoot);

  const lines = [
    '## BMAD Planning Context',
    '',
    `- **Initialized**: ${ctx.initialized ? 'Yes' : 'No (auto-init available via DELEGATE)'}`,
    `- **Project Name**: ${ctx.projectName}`,
    `- **Project Level**: ${ctx.projectLevel}`,
    `- **Output Folder**: ${ctx.outputFolder}`,
  ];

  if (ctx.phasesCompleted.length > 0) {
    lines.push(`- **Phases Completed**: ${ctx.phasesCompleted.join(', ')}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ── Internal ───────────────────────────────────────────────────────

async function loadYamlFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = yaml.load(content) as T;
    return parsed ?? null;
  } catch {
    return null;
  }
}
