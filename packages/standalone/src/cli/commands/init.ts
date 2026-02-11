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
}

/**
 * Execute init command
 */
export async function initCommand(options: InitOptions = {}): Promise<void> {
  console.log('\n🔧 MAMA Standalone Initialization\n');

  if (!options.skipAuthCheck) {
    const credentialsPath = expandPath('~/.claude/.credentials.json');
    process.stdout.write('Checking Claude Code authentication... ');

    if (!existsSync(credentialsPath)) {
      console.log('❌');
      console.error('\n⚠️  Claude Code credentials file not found.');
      console.error(`   Expected path: ${credentialsPath}`);
      console.error('\n   Please install and log in to Claude Code first:');
      console.error('   https://claude.ai/code\n');
      process.exit(1);
    }
    console.log('✓');
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
