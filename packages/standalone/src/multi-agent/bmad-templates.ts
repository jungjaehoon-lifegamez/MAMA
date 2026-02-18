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

import { readFile, access, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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

const MODULE_DIR = resolveCurrentDir();
const GLOBAL_BMAD_DIR = join(homedir(), '.claude', 'config', 'bmad');
const GLOBAL_CONFIG_PATH = join(GLOBAL_BMAD_DIR, 'config.yaml');
const GLOBAL_TEMPLATES_DIR = join(GLOBAL_BMAD_DIR, 'templates');

/**
 * Bundled templates directory (shipped with MAMA OS).
 * Resolves to packages/standalone/templates/bmad/ relative to this file.
 * Works from both src/ (dev) and dist/ (compiled).
 */
function getBundledTemplatesDir(): string {
  return join(MODULE_DIR, '..', '..', 'templates', 'bmad');
}

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
 * Load a BMAD template by name.
 * Priority: external (~/.claude/config/bmad/templates/) > bundled (templates/bmad/).
 */
export async function loadBmadTemplate(templateName: string): Promise<string | null> {
  const safeName = templateName.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeName) {
    return null;
  }

  // 1. External user override
  const externalPath = join(GLOBAL_TEMPLATES_DIR, `${safeName}.md`);
  const content = await tryReadFile(externalPath);
  if (content !== null) {
    return content;
  }

  // 2. Bundled fallback
  const bundledPath = join(getBundledTemplatesDir(), `${safeName}.md`);
  return tryReadFile(bundledPath);
}

/**
 * List available template names (union of bundled + external).
 */
export async function listAvailableTemplates(): Promise<string[]> {
  const names = new Set<string>();

  // Bundled templates
  try {
    const files = await readdir(getBundledTemplatesDir());
    for (const f of files) {
      if (f.endsWith('.md')) {
        names.add(f.replace(/\.md$/, ''));
      }
    }
  } catch {
    /* no bundled dir */
  }

  // External templates (may add more)
  try {
    const files = await readdir(GLOBAL_TEMPLATES_DIR);
    for (const f of files) {
      if (f.endsWith('.md')) {
        names.add(f.replace(/\.md$/, ''));
      }
    }
  } catch {
    /* no external dir */
  }

  return [...names].sort();
}

/**
 * Build output file path for BMAD documents.
 * Format: {outputFolder}/{type}-{projectName}-{YYYY-MM-DD}.md
 */
export function buildOutputPath(outputFolder: string, type: string, projectName: string): string {
  const date = getLocalDateString();
  const safeName = sanitizeFileSegment(projectName, 'project');
  const safeType = sanitizeFileSegment(type, 'document');
  return join(outputFolder, `${safeType}-${safeName}-${date}.md`);
}

/**
 * Check if BMAD is initialized in a project (bmad/config.yaml exists)
 */
export async function isBmadInitialized(projectRoot: string): Promise<boolean> {
  try {
    await access(join(projectRoot, 'bmad', 'config.yaml'));
    return true;
  } catch {
    return false;
  }
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
    await access(filePath);
    const content = await readFile(filePath, 'utf-8');
    const parsed = yaml.load(content) as T;
    return parsed ?? null;
  } catch {
    return null;
  }
}

function getLocalDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sanitizeFileSegment(value: string, fallback: string): string {
  const sanitized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-+)|(-+$)/g, '');
  return sanitized || fallback;
}

function resolveCurrentDir(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }

  try {
    // Avoid direct import.meta usage so this file can compile in both CJS and ESM builds.
    const getImportMetaUrl = new Function('return import.meta.url;') as () => string;
    return dirname(fileURLToPath(getImportMetaUrl()));
  } catch {
    return process.cwd();
  }
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    await access(filePath);
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
