/**
 * Skill Loader — extracted from agent-loop.ts (STORY-009)
 *
 * Handles skill discovery, catalog building, and content loading
 * for the MAMA OS system prompt injection pipeline.
 *
 * STORY-010: Semantic section-based truncation — skills over token budget
 * are split at section boundaries and lowest-priority sections omitted.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve, normalize } from 'path';
import { homedir } from 'os';
import { getConfig } from '../cli/config/config-manager.js';
import { countTokens } from './token-estimator.js';
import * as debugLoggerModule from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLoggerModule as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const skillLogger = new DebugLogger('SkillLoader');

/**
 * Files to exclude from skill prompt injection (reduce token bloat)
 */
const EXCLUDED_SKILL_FILES = new Set([
  'CONNECTORS.md',
  'connectors.md',
  'LICENSE.md',
  'license.md',
  'CHANGELOG.md',
  'changelog.md',
  'CONTRIBUTING.md',
  'contributing.md',
  'README.md',
  'readme.md',
]);

/** Max tokens per skill file to prevent prompt bloat */
const MAX_SKILL_TOKENS = () => getConfig().prompt?.skill_max_tokens ?? 2_000;

/**
 * Result of loading a skill's content.
 */
export interface SkillLoadResult {
  content: string;
  truncated: boolean;
  omittedSections: string[];
  originalChars: number;
}

/**
 * Parsed YAML frontmatter from a skill .md file.
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  keywords: string[];
}

// ─── Section-Based Truncation (STORY-010) ────────────────────────────────────

/** A parsed section of a skill markdown file. */
export interface SkillSection {
  name: string;
  content: string;
  tokens: number;
  priority: number;
}

/** Keywords that indicate low-priority (droppable) sections */
const LOW_PRIORITY_KEYWORDS =
  /\b(appendix|reference|changelog|troubleshoot|faq|notes|debug|history)/i;
/** Keywords that indicate medium-priority (example) sections */
const MED_PRIORITY_KEYWORDS = /\b(example|sample|demo|tutorial|walkthrough)/i;
/** Keywords that indicate high-priority (core) sections */
const HIGH_PRIORITY_KEYWORDS =
  /\b(overview|usage|syntax|important|core|api|config|setup|install|getting.started|quick.start)/i;

/**
 * Classify a section heading into a priority level.
 * 1 = frontmatter (always keep), 2 = core, 3 = examples, 4 = appendix
 */
function classifySection(heading: string): number {
  if (HIGH_PRIORITY_KEYWORDS.test(heading)) return 2;
  if (MED_PRIORITY_KEYWORDS.test(heading)) return 3;
  if (LOW_PRIORITY_KEYWORDS.test(heading)) return 4;
  return 2; // default: treat as core
}

/**
 * Parse skill markdown into semantic sections.
 * Splits on `## ` headings and `---` dividers.
 * Frontmatter (---...---) is always priority 1.
 */
export function parseSkillSections(content: string): SkillSection[] {
  const sections: SkillSection[] = [];

  // Extract frontmatter first
  const fmMatch = content.match(/^(---\n[\s\S]*?\n---)\n*/);
  let body = content;
  if (fmMatch) {
    const fmContent = fmMatch[1];
    sections.push({
      name: 'frontmatter',
      content: fmContent,
      tokens: countTokens(fmContent),
      priority: 1,
    });
    body = content.slice(fmMatch[0].length);
  }

  // Split remaining body on ## headings or --- dividers
  const parts = body.split(/(?=^## |\n---\n)/m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Extract heading name
    const headingMatch = trimmed.match(/^##\s+(.+)/);
    const name = headingMatch ? headingMatch[1].trim() : 'content';
    const priority = headingMatch ? classifySection(name) : 2;

    sections.push({
      name,
      content: trimmed,
      tokens: countTokens(trimmed),
      priority,
    });
  }

  return sections;
}

/**
 * Truncate skill content by omitting lowest-priority sections first.
 * Never cuts mid-section. Appends [Omitted: ...] marker.
 *
 * @param content - Raw skill markdown content
 * @param maxTokens - Token budget (default: skill_max_tokens config)
 * @returns SkillLoadResult with truncation metadata
 */
export function truncateSkillBySections(
  content: string,
  maxTokens: number = MAX_SKILL_TOKENS()
): SkillLoadResult {
  const originalChars = content.length;
  const totalTokens = countTokens(content);

  if (totalTokens <= maxTokens) {
    return { content, truncated: false, omittedSections: [], originalChars };
  }

  const sections = parseSkillSections(content);

  // Sort sections by priority descending (4=lowest first) for removal candidates
  const indexed = sections.map((s, i) => ({ ...s, index: i }));
  const removable = indexed
    .filter((s) => s.priority > 1)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.tokens - a.tokens; // larger sections first within same priority
    });

  const omitted = new Set<number>();
  let currentTokens = totalTokens;

  for (const section of removable) {
    if (currentTokens <= maxTokens) break;
    omitted.add(section.index);
    currentTokens -= section.tokens;
  }

  const kept = sections.filter((_, i) => !omitted.has(i));
  const omittedNames = sections.filter((_, i) => omitted.has(i)).map((s) => s.name);

  let result = kept.map((s) => s.content).join('\n\n');
  if (omittedNames.length > 0) {
    result += `\n\n[Omitted: ${omittedNames.join(', ')}]`;
  }

  return {
    content: result,
    truncated: omittedNames.length > 0,
    omittedSections: omittedNames,
    originalChars,
  };
}

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from skill .md file content.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: '', description: '', keywords: [] };
  const block = match[1];
  const name = (block.match(/^name:\s*(.+)$/m)?.[1] ?? '').trim();
  const description = (block.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim();
  const kwBlock = block.match(/^keywords:\n((?:[ \t]+-[ \t]*.+\n?)+)/m);
  const keywords = kwBlock
    ? kwBlock[1]
        .trim()
        .split('\n')
        .map((l) => l.replace(/^[ \t]*-[ \t]*/, '').trim())
        .filter((k) => k.length > 0)
    : [];
  return { name, description, keywords };
}

/**
 * Find the main .md file for a directory skill (for frontmatter parsing).
 */
export function findMainSkillFile(skillDir: string, skillName: string): string | null {
  for (const name of [`${skillName}.md`, 'skill.md', 'SKILL.md', 'index.md']) {
    const p = join(skillDir, name);
    if (existsSync(p)) return p;
  }
  try {
    const entries = readdirSync(skillDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md') && !EXCLUDED_SKILL_FILES.has(e.name)) {
        return join(skillDir, e.name);
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Recursively collect all .md files from a directory (sync).
 * Filters out non-essential files (LICENSE, CONNECTORS, etc.)
 * Uses semantic section-based truncation for files exceeding token limit.
 */
export function collectMarkdownFiles(
  dir: string,
  prefix = ''
): Array<{ path: string; content: string; truncated: boolean; omittedSections: string[] }> {
  const results: Array<{
    path: string;
    content: string;
    truncated: boolean;
    omittedSections: string[];
  }> = [];
  if (!existsSync(dir)) return results;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        results.push(...collectMarkdownFiles(fullPath, relativePath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (EXCLUDED_SKILL_FILES.has(entry.name)) continue;
        const raw = readFileSync(fullPath, 'utf-8');

        // Only truncate supplementary files, never command files
        const isCommand = relativePath.startsWith('commands/');
        if (!isCommand) {
          const result = truncateSkillBySections(raw);
          results.push({
            path: relativePath,
            content: result.content,
            truncated: result.truncated,
            omittedSections: result.omittedSections,
          });
        } else {
          results.push({ path: relativePath, content: raw, truncated: false, omittedSections: [] });
        }
      }
    }
  } catch {
    // Read failed
  }
  return results;
}

/**
 * Build skill catalog (one line per enabled skill) for system prompt.
 * Format: "- [source/skillId] keywords: kw1, kw2 | description"
 */
export function buildSkillCatalog(verbose = false): string[] {
  const skillsBase = join(homedir(), '.mama', 'skills');
  const stateFile = join(skillsBase, 'state.json');
  const catalog: string[] = [];

  let state: Record<string, { enabled: boolean }> = {};
  try {
    if (existsSync(stateFile)) {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    }
  } catch {
    /* no state file */
  }

  const sources = ['mama', 'cowork', 'external'];
  for (const source of sources) {
    const sourceDir = join(skillsBase, source);
    if (!existsSync(sourceDir)) continue;

    try {
      const entries = readdirSync(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const stateKey = `${source}/${entry.name}`;
        if (state[stateKey]?.enabled === false) continue;

        const skillDir = join(sourceDir, entry.name);

        // Plugin-structured skill: has skills/ subdirectory with sub-skills
        const subSkillsDir = join(skillDir, 'skills');
        if (existsSync(subSkillsDir)) {
          try {
            const subEntries = readdirSync(subSkillsDir, { withFileTypes: true });
            for (const sub of subEntries) {
              if (!sub.isDirectory()) continue;
              const subDir = join(subSkillsDir, sub.name);
              const subMain = findMainSkillFile(subDir, sub.name);
              if (!subMain) continue;
              try {
                const content = readFileSync(subMain, 'utf-8');
                const fm = parseSkillFrontmatter(content);
                const description = fm.description || '';
                const keywords = fm.keywords.length > 0 ? fm.keywords.join(', ') : sub.name;
                catalog.push(`- [${stateKey}/${sub.name}] keywords: ${keywords} | ${description}`);
                if (verbose)
                  skillLogger.debug(`Skill catalog (plugin sub): ${stateKey}/${sub.name}`);
              } catch (e) {
                if (verbose) skillLogger.warn(`Failed to parse sub-skill ${sub.name}:`, e);
              }
            }
          } catch (e) {
            if (verbose) skillLogger.warn(`Failed to read sub-skills dir ${subSkillsDir}:`, e);
          }
          // Also check for plugin-level main file (plugin.json description)
          const pluginJson = join(skillDir, '.claude-plugin', 'plugin.json');
          if (existsSync(pluginJson)) {
            try {
              const parsed: unknown = JSON.parse(readFileSync(pluginJson, 'utf-8'));
              const meta = parsed as { description?: string } | null;
              if (meta?.description) {
                catalog.push(`- [${stateKey}] keywords: ${entry.name} | ${meta.description}`);
              }
            } catch (e) {
              if (verbose) skillLogger.warn(`Failed to parse plugin.json for ${stateKey}:`, e);
            }
          }
          continue;
        }

        const mainFile = findMainSkillFile(skillDir, entry.name);
        if (!mainFile) continue;

        try {
          const content = readFileSync(mainFile, 'utf-8');
          const fm = parseSkillFrontmatter(content);
          const description = fm.description || '';
          const keywords = fm.keywords.length > 0 ? fm.keywords.join(', ') : entry.name;
          catalog.push(`- [${stateKey}] keywords: ${keywords} | ${description}`);
          if (verbose) console.log(`[SkillLoader] Skill catalog: ${stateKey}`);
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* directory read failed */
    }
  }

  // Flat .md files at root
  try {
    const rootEntries = readdirSync(skillsBase, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (EXCLUDED_SKILL_FILES.has(entry.name)) continue;

      const id = entry.name.replace(/\.md$/, '');
      const stateKey = `mama/${id}`;
      if (state[stateKey]?.enabled === false) continue;
      if (catalog.some((l) => l.includes(`[${stateKey}]`))) continue;

      try {
        const content = readFileSync(join(skillsBase, entry.name), 'utf-8');
        const fm = parseSkillFrontmatter(content);
        const description = fm.description || '';
        const keywords = fm.keywords.length > 0 ? fm.keywords.join(', ') : id;
        catalog.push(`- [${stateKey}] keywords: ${keywords} | ${description}`);
        if (verbose) console.log(`[SkillLoader] Skill catalog (flat): ${stateKey}`);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* root directory read failed */
  }

  return catalog;
}

/**
 * Load full skill content on-demand for per-message injection.
 *
 * @param skillId - Skill identifier like "mama/playground"
 * @returns SkillLoadResult with content and truncation metadata, or null if not found
 */
export function loadSkillContent(skillId: string): SkillLoadResult | null {
  const skillsBase = resolve(homedir(), '.mama', 'skills');

  // Validate skillId segments: reject path traversal (.. / empty / absolute / special chars)
  const skillIdParts = skillId.split('/');
  for (const segment of skillIdParts) {
    if (!segment || segment === '.' || segment === '..' || /[/\\:]/.test(segment)) {
      skillLogger.warn(`Rejected invalid skillId segment: "${segment}" in "${skillId}"`);
      return null;
    }
  }

  // Try plugin sub-skill: "cowork/marketing/brand-voice" → skills/cowork/marketing/skills/brand-voice/
  if (skillIdParts.length >= 3) {
    const subSkillDir = resolve(
      skillsBase,
      skillIdParts[0],
      skillIdParts[1],
      'skills',
      skillIdParts.slice(2).join('/')
    );
    // Ensure resolved path stays within skillsBase
    if (!normalize(subSkillDir).startsWith(normalize(skillsBase))) {
      skillLogger.warn(`Path traversal blocked: "${subSkillDir}" escapes "${skillsBase}"`);
      return null;
    }
    if (existsSync(subSkillDir)) {
      const mdFiles = collectMarkdownFiles(subSkillDir);
      if (mdFiles.length > 0) {
        const originalChars = mdFiles.reduce((sum, f) => sum + f.content.length, 0);
        const truncated = mdFiles.some((f) => f.truncated);
        const omittedSections = mdFiles.flatMap((f) => f.omittedSections);
        const parts = mdFiles.map((f) => `## ${f.path}\n\n${f.content}`);
        const content = `# [Skill: ${skillId}]\n\n${parts.join('\n\n---\n\n')}`;
        return { content, truncated, omittedSections, originalChars };
      }
    }
  }

  // Try directory skill first
  const skillDir = resolve(skillsBase, skillId);
  if (!normalize(skillDir).startsWith(normalize(skillsBase))) {
    skillLogger.warn(`Path traversal blocked: "${skillDir}" escapes "${skillsBase}"`);
    return null;
  }
  if (existsSync(skillDir)) {
    const mdFiles = collectMarkdownFiles(skillDir);
    if (mdFiles.length > 0) {
      const originalChars = mdFiles.reduce((sum, f) => sum + f.content.length, 0);
      const truncated = mdFiles.some((f) => f.truncated);
      const omittedSections = mdFiles.flatMap((f) => f.omittedSections);
      const parts = mdFiles.map((f) => `## ${f.path}\n\n${f.content}`);
      const content = `# [Skill: ${skillId}]\n\n${parts.join('\n\n---\n\n')}`;
      return { content, truncated, omittedSections, originalChars };
    }
  }

  // Try flat .md file: "mama/playground" → skills/playground.md
  const idParts = skillId.split('/');
  if (idParts.length >= 2) {
    const flatPath = join(skillsBase, `${idParts[idParts.length - 1]}.md`);
    if (existsSync(flatPath)) {
      try {
        const raw = readFileSync(flatPath, 'utf-8');
        return truncateSkillBySections(raw);
      } catch {
        /* skip */
      }
    }
  }

  return null;
}

/**
 * Load installed & enabled skills from ~/.mama/skills/
 * Returns skill catalog lines for system prompt injection (on-demand mode).
 */
export function loadInstalledSkills(
  verbose = false,
  _options: { onlyCommands?: boolean } = {}
): string[] {
  return buildSkillCatalog(verbose);
}
