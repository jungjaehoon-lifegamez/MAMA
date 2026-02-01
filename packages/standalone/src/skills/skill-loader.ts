/**
 * Skill Loader
 *
 * Loads skill definitions from markdown files in the skills directory.
 * Supports YAML frontmatter for metadata.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename, extname } from 'path';
import type { SkillDefinition, SkillTrigger, SkillOutput } from './types.js';

/**
 * Parse YAML-like frontmatter from markdown
 * Simple parser for basic key-value pairs and arrays
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    return { frontmatter: {}, body: content };
  }

  const [, yaml, body] = frontmatterMatch;
  const frontmatter: Record<string, unknown> = {};

  // Simple YAML parser
  const lines = yaml.split('\n');
  let currentKey = '';
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Array item
    if (trimmed.startsWith('- ')) {
      if (currentArray) {
        currentArray.push(trimmed.slice(2).trim());
      }
      continue;
    }

    // Key-value pair
    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      // Save previous array if any
      if (currentArray && currentKey) {
        frontmatter[currentKey] = currentArray;
      }

      const [, key, value] = kvMatch;
      currentKey = key;

      if (value === '') {
        // Start of array or object
        currentArray = [];
      } else {
        // Simple value
        currentArray = null;
        // Parse booleans and numbers
        if (value === 'true') {
          frontmatter[key] = true;
        } else if (value === 'false') {
          frontmatter[key] = false;
        } else if (/^\d+(\.\d+)?$/.test(value)) {
          frontmatter[key] = parseFloat(value);
        } else {
          // Remove quotes if present
          frontmatter[key] = value.replace(/^["']|["']$/g, '');
        }
      }
    }
  }

  // Save last array if any
  if (currentArray && currentKey) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, body: body.trim() };
}

/**
 * Parse trigger from frontmatter
 */
function parseTrigger(fm: Record<string, unknown>): SkillTrigger {
  const trigger: SkillTrigger = {};

  if (fm.keywords) {
    trigger.keywords = Array.isArray(fm.keywords) ? fm.keywords : [String(fm.keywords)];
  }

  if (fm.patterns) {
    trigger.patterns = Array.isArray(fm.patterns) ? fm.patterns : [String(fm.patterns)];
  }

  if (fm.requiredInputs) {
    trigger.requiredInputs = Array.isArray(fm.requiredInputs)
      ? fm.requiredInputs
      : [fm.requiredInputs];
  }

  return trigger;
}

/**
 * Parse output from frontmatter
 */
function parseOutput(fm: Record<string, unknown>): SkillOutput | undefined {
  if (!fm.output) return undefined;

  const outputStr = String(fm.output);

  // Simple output type string
  if (['text', 'html', 'html-screenshot', 'file'].includes(outputStr)) {
    return {
      type: outputStr as SkillOutput['type'],
      discordScreenshot: fm.discordScreenshot === true,
    };
  }

  return { type: 'text' };
}

/**
 * Load a single skill from a markdown file
 */
async function loadSkillFile(filePath: string): Promise<SkillDefinition | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const { frontmatter: fm, body } = parseFrontmatter(content);

    // Extract skill ID from filename
    const id = basename(filePath, extname(filePath));

    // Validate required fields
    if (!fm.name) {
      console.warn(`[SkillLoader] Skipping ${filePath}: missing 'name' in frontmatter`);
      return null;
    }

    const skill: SkillDefinition = {
      id,
      name: String(fm.name),
      description: String(fm.description || ''),
      trigger: parseTrigger(fm),
      output: parseOutput(fm),
      systemPrompt: body,
      allowedExtensions: fm.allowedExtensions
        ? Array.isArray(fm.allowedExtensions)
          ? fm.allowedExtensions
          : [String(fm.allowedExtensions)]
        : undefined,
      enabled: fm.enabled !== false, // Default to enabled
      filePath,
    };

    return skill;
  } catch (error) {
    console.error(`[SkillLoader] Error loading ${filePath}:`, error);
    return null;
  }
}

/**
 * Load all skills from a directory
 */
export async function loadSkills(skillsDir: string): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];

  try {
    // Check if directory exists
    try {
      await stat(skillsDir);
    } catch {
      console.log(`[SkillLoader] Skills directory not found: ${skillsDir}`);
      return skills;
    }

    // Read all markdown files
    const entries = await readdir(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.markdown'))) {
        const filePath = join(skillsDir, entry.name);
        const skill = await loadSkillFile(filePath);

        if (skill && skill.enabled) {
          skills.push(skill);
          console.log(`[SkillLoader] Loaded skill: ${skill.name} (${skill.id})`);
        }
      }
    }

    console.log(`[SkillLoader] Loaded ${skills.length} skills from ${skillsDir}`);
  } catch (error) {
    console.error(`[SkillLoader] Error loading skills:`, error);
  }

  return skills;
}

/**
 * Skill Loader class for managing skills
 */
export class SkillLoader {
  private skills: SkillDefinition[] = [];
  private skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  /**
   * Load all skills from the skills directory
   */
  async load(): Promise<void> {
    this.skills = await loadSkills(this.skillsDir);
  }

  /**
   * Reload skills from disk
   */
  async reload(): Promise<void> {
    this.skills = [];
    await this.load();
  }

  /**
   * Get all loaded skills
   */
  getSkills(): SkillDefinition[] {
    return [...this.skills];
  }

  /**
   * Get a skill by ID
   */
  getSkill(id: string): SkillDefinition | undefined {
    return this.skills.find((s) => s.id === id);
  }

  /**
   * Add a skill programmatically
   */
  addSkill(skill: SkillDefinition): void {
    // Remove existing skill with same ID
    this.skills = this.skills.filter((s) => s.id !== skill.id);
    this.skills.push(skill);
  }
}
