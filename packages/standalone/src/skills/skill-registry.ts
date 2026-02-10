/**
 * Unified Skill Registry
 *
 * Manages skills from 3 sources:
 * - MAMA: Built-in templates + user-installed (~/.mama/skills/mama/)
 * - Cowork: GitHub anthropics/knowledge-work-plugins
 * - External: GitHub URL-based plugins (~/.mama/skills/external/)
 *
 * Provides install/uninstall/toggle/search across all sources.
 */

import { readdir, readFile, stat, mkdir, writeFile, rm } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';

export type SkillSource = 'mama' | 'cowork' | 'external';

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  installed: boolean;
  enabled: boolean;
  /** Remote path for download */
  remotePath?: string;
  metadata?: Record<string, unknown>;
}

interface CatalogCache {
  skills: CatalogSkill[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SKILLS_BASE = join(homedir(), '.mama', 'skills');
const STATE_FILE = join(SKILLS_BASE, 'state.json');

/**
 * Skill state (enabled/disabled tracking)
 */
interface SkillState {
  [skillId: string]: { enabled: boolean; repoUrl?: string };
}

async function loadState(): Promise<SkillState> {
  try {
    const data = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveState(state: SkillState): Promise<void> {
  await mkdir(SKILLS_BASE, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Fetch JSON from GitHub API (unauthenticated)
 */
async function fetchGitHub(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'MAMA-SkillRegistry/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch raw file content from GitHub
 */
async function fetchRawGitHub(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'MAMA-SkillRegistry/1.0' },
  });

  if (!response.ok) {
    throw new Error(`GitHub raw fetch ${response.status}: ${response.statusText}`);
  }

  return response.text();
}

export class SkillRegistry {
  private catalogCache: Map<SkillSource, CatalogCache> = new Map();
  private treeCache: Map<
    string,
    { tree: Array<{ path: string; type: string }>; fetchedAt: number }
  > = new Map();
  private builtinSkillsDir: string;

  constructor(builtinSkillsDir?: string) {
    this.builtinSkillsDir = builtinSkillsDir || join(process.cwd(), 'templates', 'skills');
  }

  /**
   * Get all installed skills (local files)
   */
  async getInstalled(): Promise<CatalogSkill[]> {
    const skills: CatalogSkill[] = [];
    const state = await loadState();

    for (const source of ['mama', 'cowork', 'external'] as SkillSource[]) {
      const sourceDir = join(SKILLS_BASE, source);
      try {
        const entries = await readdir(sourceDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillDir = join(sourceDir, entry.name);
          const skillMd = await this.findSkillFile(skillDir);
          if (!skillMd) continue;

          const content = await readFile(skillMd, 'utf-8');
          const { name, description } = this.parseSkillHeader(content, entry.name);
          const stateKey = `${source}/${entry.name}`;

          skills.push({
            id: entry.name,
            name,
            description,
            source,
            installed: true,
            enabled: state[stateKey]?.enabled !== false,
          });
        }
      } catch {
        // Directory doesn't exist yet
      }
    }

    // Also include built-in MAMA skills
    try {
      const entries = await readdir(this.builtinSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const id = basename(entry.name, '.md');
        // Skip if already installed as user skill
        if (skills.some((s) => s.id === id && s.source === 'mama')) continue;

        const content = await readFile(join(this.builtinSkillsDir, entry.name), 'utf-8');
        const { name, description } = this.parseSkillHeader(content, id);

        skills.push({
          id,
          name,
          description,
          source: 'mama',
          installed: true,
          enabled: true,
        });
      }
    } catch {
      // No built-in skills directory
    }

    return skills;
  }

  /**
   * Get catalog from a remote source (cached 1 hour)
   */
  async getCatalog(source: SkillSource | 'all' = 'all'): Promise<CatalogSkill[]> {
    // Only cowork has a remote catalog; external skills are installed via URL
    const sources: SkillSource[] =
      source === 'all' ? ['cowork'] : source === 'external' ? [] : [source];
    const results: CatalogSkill[] = [];
    const installed = await this.getInstalled();
    const installedIds = new Set(installed.map((s) => `${s.source}/${s.id}`));

    for (const src of sources) {
      const cached = this.catalogCache.get(src);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        results.push(
          ...cached.skills.map((s) => ({
            ...s,
            installed: installedIds.has(`${s.source}/${s.id}`),
          }))
        );
        continue;
      }

      try {
        const skills = await this.fetchCoworkCatalog();

        this.catalogCache.set(src, { skills, fetchedAt: Date.now() });
        results.push(
          ...skills.map((s) => ({
            ...s,
            installed: installedIds.has(`${s.source}/${s.id}`),
          }))
        );
      } catch (error) {
        console.error(`[SkillRegistry] Failed to fetch ${src} catalog:`, error);
        if (cached) {
          results.push(...cached.skills);
        }
      }
    }

    return results;
  }

  /**
   * Search across installed + catalog skills
   */
  async search(query: string, source: SkillSource | 'all' = 'all'): Promise<CatalogSkill[]> {
    const q = query.toLowerCase();
    const [installed, catalog] = await Promise.all([this.getInstalled(), this.getCatalog(source)]);

    // Merge, deduplicate, filter
    const seen = new Set<string>();
    const all: CatalogSkill[] = [];

    for (const skill of [...installed, ...catalog]) {
      const key = `${skill.source}/${skill.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.id.toLowerCase().includes(q)
      ) {
        all.push(skill);
      }
    }

    return all;
  }

  /**
   * Install a skill/plugin from remote source (full directory)
   *
   * Uses Git Tree API (1 request) to list files, then downloads each
   * from raw.githubusercontent.com (no API rate limit).
   */
  async install(
    source: SkillSource,
    name: string
  ): Promise<{ success: boolean; path: string; files: number }> {
    const installDir = join(SKILLS_BASE, source, name);
    await mkdir(installDir, { recursive: true });

    try {
      const repoConfig =
        source === 'cowork' ? { repo: 'anthropics/knowledge-work-plugins', prefix: name } : null;

      if (!repoConfig) {
        throw new Error(`Cannot install from source: ${source}`);
      }

      // Fetch full repo tree (single API call, cached per source)
      const tree = await this.getRepoTree(repoConfig.repo);
      const files = tree.filter(
        (f: { path: string; type: string }) =>
          f.type === 'blob' && f.path.startsWith(`${repoConfig.prefix}/`)
      );

      if (files.length === 0) {
        throw new Error(`No files found for ${source}/${name}`);
      }

      // Download each file
      const rawBase = `https://raw.githubusercontent.com/${repoConfig.repo}/main`;
      let downloadedCount = 0;

      for (const file of files) {
        const relativePath = file.path.slice(repoConfig.prefix.length + 1);
        const targetPath = join(installDir, relativePath);
        const targetDir = join(targetPath, '..');
        await mkdir(targetDir, { recursive: true });

        try {
          const content = await fetchRawGitHub(`${rawBase}/${file.path}`);
          await writeFile(targetPath, content);
          downloadedCount++;
        } catch {
          console.warn(`[SkillRegistry] Failed to download: ${file.path}`);
        }
      }

      if (downloadedCount === 0) {
        throw new Error(`Failed to download any files for ${source}/${name}`);
      }

      // Set enabled by default
      const state = await loadState();
      state[`${source}/${name}`] = { enabled: true };
      await saveState(state);

      // Auto-merge MCP config if .mcp.json exists
      await this.mergeMcpConfig(installDir, `${source}/${name}`);

      return { success: true, path: installDir, files: downloadedCount };
    } catch (error) {
      // Clean up on failure
      try {
        await rm(installDir, { recursive: true });
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  /**
   * Install a plugin from a GitHub URL
   *
   * Supports:
   * - https://github.com/{owner}/{repo}
   * - https://github.com/{owner}/{repo}/tree/{branch}/{subpath}
   *
   * Reuses getRepoTree() + fetchRawGitHub() for efficient download.
   */
  async installFromUrl(
    url: string
  ): Promise<{ success: boolean; path: string; files: number; name: string }> {
    const parsed = this.parseGitHubUrl(url);
    if (!parsed) {
      throw new Error(`Invalid GitHub URL: ${url}`);
    }

    const { owner, repo, branch, subpath } = parsed;
    const name = subpath ? basename(subpath) : repo;
    const installDir = join(SKILLS_BASE, 'external', name);
    await mkdir(installDir, { recursive: true });

    try {
      const fullRepo = `${owner}/${repo}`;
      const tree = await this.getRepoTree(fullRepo, branch);
      const prefix = subpath || '';
      const files = tree.filter(
        (f: { path: string; type: string }) =>
          f.type === 'blob' && (prefix ? f.path.startsWith(`${prefix}/`) : true)
      );

      if (files.length === 0) {
        throw new Error(`No files found at ${url}`);
      }

      const rawBase = `https://raw.githubusercontent.com/${fullRepo}/${branch}`;
      let downloadedCount = 0;

      for (const file of files) {
        const relativePath = prefix ? file.path.slice(prefix.length + 1) : file.path;
        if (!relativePath) continue;
        const targetPath = join(installDir, relativePath);
        const targetDir = join(targetPath, '..');
        await mkdir(targetDir, { recursive: true });

        try {
          const content = await fetchRawGitHub(`${rawBase}/${file.path}`);
          await writeFile(targetPath, content);
          downloadedCount++;
        } catch {
          console.warn(`[SkillRegistry] Failed to download: ${file.path}`);
        }
      }

      if (downloadedCount === 0) {
        throw new Error(`Failed to download any files from ${url}`);
      }

      // Save state with repoUrl metadata
      const state = await loadState();
      state[`external/${name}`] = { enabled: true, repoUrl: url } as SkillState[string];
      await saveState(state);

      // Auto-merge MCP config if .mcp.json exists
      await this.mergeMcpConfig(installDir, `external/${name}`);

      return { success: true, path: installDir, files: downloadedCount, name };
    } catch (error) {
      try {
        await rm(installDir, { recursive: true });
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  /**
   * Parse GitHub URL into components
   */
  private parseGitHubUrl(
    url: string
  ): { owner: string; repo: string; branch: string; subpath: string } | null {
    try {
      const u = new URL(url);
      if (u.hostname !== 'github.com') return null;

      const parts = u.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');
      if (parts.length < 2) return null;

      const owner = parts[0];
      const repo = parts[1];

      // https://github.com/owner/repo/tree/branch/subpath
      if (parts[2] === 'tree' && parts.length >= 4) {
        const branch = parts[3];
        const subpath = parts.slice(4).join('/');
        return { owner, repo, branch, subpath };
      }

      // https://github.com/owner/repo
      return { owner, repo, branch: 'main', subpath: '' };
    } catch {
      return null;
    }
  }

  /**
   * Uninstall a skill
   */
  async uninstall(source: SkillSource, name: string): Promise<void> {
    // Remove MCP config entries before deleting files
    await this.removeMcpConfig(`${source}/${name}`);

    const installDir = join(SKILLS_BASE, source, name);
    await rm(installDir, { recursive: true, force: true });

    const state = await loadState();
    delete state[`${source}/${name}`];
    await saveState(state);
  }

  /**
   * Toggle skill enabled/disabled
   */
  async toggle(source: SkillSource, name: string, enabled: boolean): Promise<void> {
    const state = await loadState();
    state[`${source}/${name}`] = { enabled };
    await saveState(state);
  }

  /**
   * Get SKILL.md content for a skill (local or remote)
   */
  async getContent(source: SkillSource, name: string): Promise<string | null> {
    // Check installed first
    const installDir = join(SKILLS_BASE, source, name);
    const skillFile = await this.findSkillFile(installDir);
    if (skillFile) {
      return readFile(skillFile, 'utf-8');
    }

    // Check built-in
    if (source === 'mama') {
      try {
        return await readFile(join(this.builtinSkillsDir, `${name}.md`), 'utf-8');
      } catch {
        return null;
      }
    }

    // Fetch from remote for uninstalled catalog skills
    try {
      if (source === 'cowork') {
        for (const filename of ['SKILL.md', 'README.md']) {
          try {
            return await fetchRawGitHub(
              `https://raw.githubusercontent.com/anthropics/knowledge-work-plugins/main/${name}/${filename}`
            );
          } catch {
            continue;
          }
        }
      }
    } catch {
      // Remote fetch failed
    }

    return null;
  }

  /**
   * Clear catalog cache
   */
  clearCache(source?: SkillSource): void {
    if (source) {
      this.catalogCache.delete(source);
    } else {
      this.catalogCache.clear();
    }
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * Get repo file tree (cached 1 hour, single API call)
   */
  private async getRepoTree(
    repo: string,
    branch = 'main'
  ): Promise<Array<{ path: string; type: string }>> {
    const cacheKey = `${repo}@${branch}`;
    const cached = this.treeCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.tree;
    }

    const data = (await fetchGitHub(
      `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`
    )) as { tree: Array<{ path: string; type: string }> };

    this.treeCache.set(cacheKey, { tree: data.tree, fetchedAt: Date.now() });
    return data.tree;
  }

  private async findSkillFile(dir: string): Promise<string | null> {
    for (const name of ['SKILL.md', 'skill.md', 'README.md']) {
      const p = join(dir, name);
      try {
        await stat(p);
        return p;
      } catch {
        continue;
      }
    }
    return null;
  }

  private parseSkillHeader(
    content: string,
    fallbackId: string
  ): { name: string; description: string } {
    // Try frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
      const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
      return {
        name: nameMatch?.[1]?.replace(/^["']|["']$/g, '') || fallbackId,
        description: descMatch?.[1]?.replace(/^["']|["']$/g, '') || '',
      };
    }

    // Try first heading + paragraph
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const paraMatch = content.match(/^#\s+.+\n+([^#\n].+)/m);
    return {
      name: headingMatch?.[1] || fallbackId,
      description: paraMatch?.[1]?.slice(0, 200) || '',
    };
  }

  private async fetchCoworkCatalog(): Promise<CatalogSkill[]> {
    // Cowork plugins are at the repo root (each top-level dir is a plugin)
    const data = (await fetchGitHub(
      'https://api.github.com/repos/anthropics/knowledge-work-plugins/contents'
    )) as Array<{ name: string; type: string }>;

    const skills: CatalogSkill[] = [];
    for (const item of data) {
      // Skip non-dirs and hidden/meta directories
      if (item.type !== 'dir' || item.name.startsWith('.')) continue;
      skills.push({
        id: item.name,
        name: item.name.replace(/-/g, ' '),
        description: `Cowork plugin: ${item.name}`,
        source: 'cowork',
        installed: false,
        enabled: false,
        remotePath: item.name,
      });
    }

    return skills;
  }

  // ===========================================================================
  // MCP Config Management
  // ===========================================================================

  private static readonly MCP_CONFIG_PATH = join(homedir(), '.mama', 'mama-mcp-config.json');

  /**
   * Merge .mcp.json from a skill directory into the global MCP config.
   * Tags each server entry with `_installedBy` for tracking.
   */
  async mergeMcpConfig(skillDir: string, skillKey: string): Promise<void> {
    const mcpJsonPath = join(skillDir, '.mcp.json');
    try {
      await stat(mcpJsonPath);
    } catch {
      return; // No .mcp.json — nothing to merge
    }

    try {
      const mcpData = JSON.parse(await readFile(mcpJsonPath, 'utf-8')) as {
        mcpServers?: Record<string, unknown>;
      };
      if (!mcpData.mcpServers || Object.keys(mcpData.mcpServers).length === 0) return;

      const globalConfig = await this.loadMcpConfig();

      for (const [serverName, serverConfig] of Object.entries(mcpData.mcpServers)) {
        globalConfig.mcpServers[serverName] = {
          ...(serverConfig as Record<string, unknown>),
          _installedBy: skillKey,
        };
      }

      await this.saveMcpConfig(globalConfig);
      console.log(
        `[SkillRegistry] Merged MCP config from ${skillKey} (${Object.keys(mcpData.mcpServers).length} servers)`
      );
    } catch (error) {
      console.warn(`[SkillRegistry] Failed to merge MCP config for ${skillKey}:`, error);
    }
  }

  /**
   * Remove MCP server entries installed by a specific skill.
   */
  async removeMcpConfig(skillKey: string): Promise<void> {
    try {
      const globalConfig = await this.loadMcpConfig();
      let removed = 0;

      for (const [serverName, serverConfig] of Object.entries(globalConfig.mcpServers)) {
        if ((serverConfig as Record<string, unknown>)._installedBy === skillKey) {
          delete globalConfig.mcpServers[serverName];
          removed++;
        }
      }

      if (removed > 0) {
        await this.saveMcpConfig(globalConfig);
        console.log(`[SkillRegistry] Removed ${removed} MCP server(s) from ${skillKey}`);
      }
    } catch {
      // Config file doesn't exist or parse error — nothing to remove
    }
  }

  /**
   * Migrate existing installed plugins: merge any .mcp.json that hasn't been merged yet.
   * Called once at server startup.
   */
  async migrateExistingMcpConfigs(): Promise<void> {
    const globalConfig = await this.loadMcpConfig();
    const existingKeys = new Set(
      Object.values(globalConfig.mcpServers)
        .map((s) => (s as Record<string, unknown>)._installedBy as string | undefined)
        .filter(Boolean)
    );

    for (const source of ['mama', 'cowork', 'external'] as SkillSource[]) {
      const sourceDir = join(SKILLS_BASE, source);
      try {
        const entries = await readdir(sourceDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillKey = `${source}/${entry.name}`;
          if (existingKeys.has(skillKey)) continue;

          const skillDir = join(sourceDir, entry.name);
          await this.mergeMcpConfig(skillDir, skillKey);
        }
      } catch {
        // Source directory doesn't exist
      }
    }
  }

  private async loadMcpConfig(): Promise<{ mcpServers: Record<string, unknown> }> {
    try {
      const data = await readFile(SkillRegistry.MCP_CONFIG_PATH, 'utf-8');
      return JSON.parse(data);
    } catch {
      return { mcpServers: {} };
    }
  }

  private async saveMcpConfig(config: { mcpServers: Record<string, unknown> }): Promise<void> {
    await mkdir(join(homedir(), '.mama'), { recursive: true });
    await writeFile(SkillRegistry.MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
  }
}
