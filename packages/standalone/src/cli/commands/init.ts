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
  const requestedBackend = resolveRequestedBackend(preferredBackend);

  const codexAuthPaths = [expandPath('~/.mama/.codex/auth.json'), expandPath('~/.codex/auth.json')];
  const codexAuthPath = codexAuthPaths.find((p) => existsSync(p));
  const hasCodexAuth = Boolean(codexAuthPath);
  const hasClaudeAuth = existsSync(expandPath('~/.claude/.credentials.json'));

  if (requestedBackend) {
    if (requestedBackend === 'codex') {
      return hasCodexAuth ? { backend: 'codex', codexAuthPath } : null;
    }
    return hasClaudeAuth ? { backend: 'claude' } : null;
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

function resolveRequestedBackend(
  preferredBackend: InitOptions['backend']
): 'claude' | 'codex' | undefined {
  if (preferredBackend === 'claude' || preferredBackend === 'codex') {
    return preferredBackend;
  }
  return process.env.MAMA_DEFAULT_BACKEND === 'codex' ||
    process.env.MAMA_DEFAULT_BACKEND === 'claude'
    ? process.env.MAMA_DEFAULT_BACKEND
    : undefined;
}

/**
 * Execute init command
 */
export async function initCommand(options: InitOptions = {}): Promise<void> {
  console.log('\n🔧 MAMA Standalone Initialization\n');

  const requestedBackend = resolveRequestedBackend(options.backend);
  let selectedBackend: BackendResolution = {
    backend: requestedBackend === 'codex' ? 'codex' : 'claude',
  };
  if (!options.skipAuthCheck) {
    process.stdout.write('Checking backend authentication (Codex/Claude)... ');
    const resolved = resolvePreferredBackend(options.backend);
    if (!resolved) {
      console.log('❌');
      if (requestedBackend === 'codex') {
        console.error('\n⚠️  Requested backend "codex" is not authenticated.');
        console.error(
          `   Expected auth: ${expandPath('~/.mama/.codex/auth.json')} or ${expandPath('~/.codex/auth.json')}`
        );
        console.error('\n   Please run: codex --login\n');
        process.exit(1);
      }
      if (requestedBackend === 'claude') {
        console.error('\n⚠️  Requested backend "claude" is not authenticated.');
        console.error(`   Expected auth: ${expandPath('~/.claude/.credentials.json')}`);
        console.error('\n   Please authenticate Claude Code first:');
        console.error('   https://claude.ai/code\n');
        process.exit(1);
      }
      console.error('\n⚠️  No authenticated backend found.');
      console.error(
        `   Codex auth: ${expandPath('~/.mama/.codex/auth.json')} or ${expandPath('~/.codex/auth.json')}`
      );
      console.error(`   Claude auth: ${expandPath('~/.claude/.credentials.json')}`);
      console.error('\n   Please authenticate one backend first:');
      console.error('   - Codex: codex --login');
      console.error('   - Claude: https://claude.ai/code\n');
      process.exit(1);
    }
    selectedBackend = resolved;
    console.log('✓');
  }

  if (selectedBackend.backend === 'codex') {
    const authPathMsg = selectedBackend.codexAuthPath
      ? ` (auth detected at ${selectedBackend.codexAuthPath})`
      : '';
    console.log(`Selected backend: codex${authPathMsg}`);
  } else {
    console.log('Selected backend: claude');
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
    } else {
      config.agent.backend = 'claude';
    }
    await saveConfig(config);
    if (options.skipAuthCheck && requestedBackend) {
      console.log(
        `Auth check skipped; applied requested backend "${selectedBackend.backend}" to config.`
      );
    } else if (options.skipAuthCheck) {
      console.log(
        `Auth check skipped; applied default backend "${selectedBackend.backend}" to config.`
      );
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
