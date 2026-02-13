/**
 * mama init command
 *
 * Initialize MAMA configuration
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createDefaultConfig,
  configExists,
  getConfigPath,
  expandPath,
  loadConfig,
  saveConfig,
} from '../config/config-manager.js';
import { BOOTSTRAP_TEMPLATE } from '../../onboarding/bootstrap-template.js';

/**
 * CLAUDE.md template for workspace documentation
 */
const CLAUDE_MD_TEMPLATE = `# MAMA

I am MAMA, an AI assistant with persistent memory.

## Workspace (Important!)

**All file operations must be performed only in the paths below:**

| Purpose | Path |
|---------|------|
| Working directory | \`~/.mama/workspace/\` |
| Skills storage | \`~/.mama/skills/\` |
| Scripts | \`~/.mama/workspace/scripts/\` |
| Data | \`~/.mama/workspace/data/\` |
| Logs | \`~/.mama/logs/\` |

**Never use:**
- \`~/.openclaw/\` - Different project
- \`~/project/\` - User project (do not modify without explicit request)

## Memory System

MAMA tracks the evolution of decisions:

\`\`\`
Decision v1 (failed) → v2 (partial success) → v3 (success)
\`\`\`

Searching past decisions provides full context.

## Available Commands

- \`mama start\` - Start agent
- \`mama stop\` - Stop agent
- \`mama status\` - Check status
- \`mama run <command>\` - Run one-off command
`;

/**
 * Copy built-in skill templates to user's skills directory (skip existing)
 */
async function copyDefaultSkills(skillsDir: string): Promise<void> {
  const templatesDir = join(__dirname, '..', '..', '..', 'templates', 'skills');

  try {
    const entries = await readdir(templatesDir);
    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      const dest = join(skillsDir, file);
      if (existsSync(dest)) {
        console.log(`  ${file} (already exists)`);
        continue;
      }
      await copyFile(join(templatesDir, file), dest);
      console.log(`  ${file} ✓`);
    }
  } catch {
    console.log('  (no template skills found)');
  }
}

/**
 * Options for init command
 */
export interface InitOptions {
  /** Force overwrite existing config */
  force?: boolean;
  /** Skip Claude Code authentication check (for testing) */
  skipAuthCheck?: boolean;
  /** Preferred backend selection mode */
  backend?: 'auto' | 'claude' | 'codex';
}

interface BackendResolution {
  backend: 'claude' | 'codex';
  codexAuthPath?: string;
}

function resolvePreferredBackend(
  preferredBackend: InitOptions['backend']
): BackendResolution | null {
  const requestedBackend =
    preferredBackend === 'claude' || preferredBackend === 'codex'
      ? preferredBackend
      : process.env.MAMA_DEFAULT_BACKEND === 'codex' ||
          process.env.MAMA_DEFAULT_BACKEND === 'claude'
        ? process.env.MAMA_DEFAULT_BACKEND
        : undefined;

  const codexAuthPaths = [expandPath('~/.mama/.codex/auth.json'), expandPath('~/.codex/auth.json')];
  const codexAuthPath = codexAuthPaths.find((p) => existsSync(p));
  const hasCodexAuth = Boolean(codexAuthPath);
  const hasClaudeAuth = existsSync(expandPath('~/.claude/.credentials.json'));

  if (requestedBackend === 'codex' && hasCodexAuth) {
    return { backend: 'codex', codexAuthPath };
  }
  if (requestedBackend === 'claude' && hasClaudeAuth) {
    return { backend: 'claude' };
  }

  // Neutral auto resolution:
  // - if only one backend is authenticated, use it
  // - if both are authenticated, keep compatibility default (claude)
  if (hasCodexAuth && !hasClaudeAuth) {
    return { backend: 'codex', codexAuthPath };
  }
  if (hasClaudeAuth) {
    return { backend: 'claude' };
  }

  return null;
}

/**
 * Execute init command
 */
export async function initCommand(options: InitOptions = {}): Promise<void> {
  console.log('\n🔧 MAMA Standalone Initialization\n');

  let selectedBackend: BackendResolution = { backend: 'claude' };
  if (!options.skipAuthCheck) {
    process.stdout.write('Checking backend authentication (Codex/Claude)... ');
    const resolved = resolvePreferredBackend(options.backend);
    if (!resolved) {
      console.log('❌');
      console.error('\n⚠️  No authenticated backend found.');
      console.error(
        `   Codex auth: ${expandPath('~/.mama/.codex/auth.json')} or ${expandPath('~/.codex/auth.json')}`
      );
      console.error(`   Claude auth: ${expandPath('~/.claude/.credentials.json')}`);
      console.error('\n   Please authenticate one backend first:');
      console.error('   - Codex: codex login');
      console.error('   - Claude: https://claude.ai/code\n');
      process.exit(1);
    }
    selectedBackend = resolved;
    console.log('✓');
    if (options.backend && options.backend !== 'auto') {
      console.log(`Using requested backend from --backend: ${options.backend}`);
    } else if (process.env.MAMA_DEFAULT_BACKEND) {
      console.log(
        `Using requested backend from MAMA_DEFAULT_BACKEND=${process.env.MAMA_DEFAULT_BACKEND}`
      );
    } else if (selectedBackend.backend === 'codex') {
      console.log(
        `Using available backend: codex (auth detected at ${selectedBackend.codexAuthPath})`
      );
    } else {
      console.log('Using available backend: claude');
    }
  }

  // Check if config already exists
  if (configExists() && !options.force) {
    console.log(`\n⚠️  Configuration file already exists: ${getConfigPath()}`);
    console.log('   Use --force option to overwrite.\n');
    process.exit(1);
  }

  // Create config
  process.stdout.write('Creating configuration file... ');
  try {
    const configPath = await createDefaultConfig(options.force);
    if (!options.skipAuthCheck) {
      const config = await loadConfig();
      if (selectedBackend.backend === 'codex') {
        config.agent.backend = 'codex';
        config.agent.codex_home = '~/.mama/.codex';
        config.agent.codex_cwd = '~/.mama/workspace';
        config.agent.codex_sandbox = 'workspace-write';
        config.agent.codex_skip_git_repo_check = true;
        if (!config.agent.codex_add_dirs || config.agent.codex_add_dirs.length === 0) {
          config.agent.codex_add_dirs = ['~/.mama/workspace'];
        }
      }
      await saveConfig(config);
    }
    console.log('✓');
    console.log(`\n${configPath} created successfully\n`);
  } catch (error) {
    console.log('❌');
    console.error(
      `\nFailed to create configuration file: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  // Create directory structure
  const directories = [
    { path: '~/.mama/skills', label: 'Skills directory' },
    { path: '~/.mama/workspace', label: 'Workspace' },
    { path: '~/.mama/workspace/scripts', label: 'Scripts directory' },
    { path: '~/.mama/workspace/data', label: 'Data directory' },
    { path: '~/.mama/logs', label: 'Logs directory' },
  ];

  for (const dir of directories) {
    const expandedPath = expandPath(dir.path);
    process.stdout.write(`Creating ${dir.label}... `);
    try {
      if (!existsSync(expandedPath)) {
        await mkdir(expandedPath, { recursive: true });
        console.log('✓');
      } else {
        console.log('(already exists)');
      }
    } catch (error) {
      console.log('❌');
      console.error(
        `\nFailed to create ${dir.label}: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    }
  }

  // Copy default skills
  const skillsDir = expandPath('~/.mama/skills');
  process.stdout.write('Copying default skills...\n');
  await copyDefaultSkills(skillsDir);

  // Create CLAUDE.md
  const claudeMdPath = expandPath('~/.mama/CLAUDE.md');
  process.stdout.write('Creating CLAUDE.md... ');
  try {
    if (existsSync(claudeMdPath) && !options.force) {
      console.log('(already exists)');
    } else {
      await writeFile(claudeMdPath, CLAUDE_MD_TEMPLATE, 'utf-8');
      console.log('✓');
    }
  } catch (error) {
    console.log('❌');
    console.error(
      `\nFailed to create CLAUDE.md: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  const bootstrapPath = expandPath('~/.mama/BOOTSTRAP.md');
  process.stdout.write('Creating BOOTSTRAP.md... ');
  try {
    if (existsSync(bootstrapPath) && !options.force) {
      console.log('(already exists)');
    } else {
      await writeFile(bootstrapPath, BOOTSTRAP_TEMPLATE, 'utf-8');
      console.log('✓');
    }
  } catch (error) {
    console.log('❌');
    console.error(
      `\nFailed to create BOOTSTRAP.md: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  // Show next steps
  console.log('\nNext steps:');
  console.log('  mama setup    Interactive setup wizard (first run)');
  console.log('  mama start    Start agent');
  console.log('  mama status   Check status');
  console.log('');
}
