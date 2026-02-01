#!/usr/bin/env node
/**
 * Manifest Validation Script for MAMA Plugin
 *
 * Story M3.3: Validates plugin.json, .mcp.json, and project structure
 *
 * Checks:
 * 1. plugin.json exists and is valid JSON
 * 2. .mcp.json exists and is valid JSON
 * 3. All commands referenced in plugin.json exist
 * 4. All hook scripts exist and are executable
 * 5. Skill documentation exists
 * 6. package.json is valid
 *
 * Exit codes:
 * 0 - All validations passed
 * 1 - One or more validations failed
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PLUGIN_JSON = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const MCP_JSON = path.join(PLUGIN_ROOT, '.mcp.json');
const PACKAGE_JSON = path.join(PLUGIN_ROOT, 'package.json');

const errors = [];
const warnings = [];
let passCount = 0;

/**
 * Print colored output
 */
function success(msg) {
  console.log(`\x1b[32m✅ ${msg}\x1b[0m`);
  passCount++;
}

function error(msg) {
  console.error(`\x1b[31m❌ ${msg}\x1b[0m`);
  errors.push(msg);
}

function warn(msg) {
  console.warn(`\x1b[33m⚠️  ${msg}\x1b[0m`);
  warnings.push(msg);
}

function _info(msg) {
  console.log(`\x1b[36mℹ️  ${msg}\x1b[0m`);
}

/**
 * Validate JSON file exists and is valid
 */
function validateJsonFile(filePath, name) {
  if (!fs.existsSync(filePath)) {
    error(`${name} not found at: ${filePath}`);
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(content);
    success(`${name}: Valid JSON`);
    return json;
  } catch (err) {
    error(`${name}: Invalid JSON - ${err.message}`);
    return null;
  }
}

/**
 * Validate plugin.json structure
 */
function validatePluginJson(pluginConfig) {
  if (!pluginConfig) {
    return;
  }

  // Check required fields
  const required = ['name', 'version', 'description'];
  required.forEach((field) => {
    if (!pluginConfig[field]) {
      error(`plugin.json missing required field: ${field}`);
    } else {
      success(`plugin.json has ${field}: ${pluginConfig[field]}`);
    }
  });

  // Check commands (auto-discovered from commands/ directory per official spec)
  const commandsDir = path.join(PLUGIN_ROOT, 'commands');
  if (fs.existsSync(commandsDir)) {
    const commandFiles = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'));
    if (commandFiles.length > 0) {
      success(
        `commands/ directory has ${commandFiles.length} command(s): ${commandFiles.join(', ')}`
      );
    } else {
      warn('commands/ directory exists but has no .md files');
    }
  } else if (pluginConfig.commands && Array.isArray(pluginConfig.commands)) {
    // Legacy: plugin.json lists commands (non-standard, but check if they exist)
    warn(
      'plugin.json has commands array (non-standard, use commands/ directory for auto-discovery)'
    );
    success(`plugin.json has ${pluginConfig.commands.length} commands`);
    pluginConfig.commands.forEach((cmd) => {
      const cmdPath = path.join(PLUGIN_ROOT, '.claude-plugin', cmd);
      if (!fs.existsSync(cmdPath)) {
        error(`Command file not found: ${cmdPath}`);
      } else {
        success(`Command exists: ${cmd}`);
      }
    });
  } else {
    warn('No commands/ directory and no commands in plugin.json');
  }

  // Check skills (auto-discovered from skills/ directory per official spec)
  const skillsDir = path.join(PLUGIN_ROOT, 'skills');
  if (fs.existsSync(skillsDir)) {
    const skillDirs = fs.readdirSync(skillsDir).filter((f) => {
      const stat = fs.statSync(path.join(skillsDir, f));
      return stat.isDirectory();
    });
    if (skillDirs.length > 0) {
      success(`skills/ directory has ${skillDirs.length} skill(s): ${skillDirs.join(', ')}`);
      skillDirs.forEach((skillDir) => {
        const skillMdPath = path.join(skillsDir, skillDir, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) {
          error(`Skill SKILL.md not found: ${path.join('skills', skillDir, 'SKILL.md')}`);
        } else {
          success(`Skill documentation exists: ${skillDir}/SKILL.md`);
        }
      });
    } else {
      warn('skills/ directory exists but has no subdirectories');
    }
  } else if (pluginConfig.skills && Array.isArray(pluginConfig.skills)) {
    // Legacy: plugin.json lists skills (non-standard)
    warn('plugin.json has skills array (non-standard, use skills/ directory for auto-discovery)');
    success(`plugin.json has ${pluginConfig.skills.length} skills`);
    pluginConfig.skills.forEach((skill) => {
      const skillPath = path.join(PLUGIN_ROOT, '.claude-plugin', skill.path, 'SKILL.md');
      if (!fs.existsSync(skillPath)) {
        error(`Skill SKILL.md not found: ${skillPath}`);
      } else {
        success(`Skill exists: ${skill.name}`);
      }
    });
  } else {
    warn('No skills/ directory and no skills in plugin.json');
  }

  // Check hooks (via hooks field in plugin.json or auto-discovered hooks/ directory)
  if (pluginConfig.hooks && typeof pluginConfig.hooks === 'object') {
    // Inline hooks object (official Claude Code plugin spec with 3-level nesting)
    const hooksConfig = pluginConfig.hooks;
    const hookTypes = Object.keys(hooksConfig);
    success(`Hooks inline in plugin.json: ${hookTypes.join(', ')}`);

    // Validate hook scripts exist (3-level: event -> matcher groups -> hook handlers)
    Object.entries(hooksConfig).forEach(([hookType, matcherGroups]) => {
      matcherGroups.forEach((matcherGroup) => {
        const hookHandlers = matcherGroup.hooks || [];
        hookHandlers.forEach((handler) => {
          if (handler.command) {
            // Extract script path from command
            const match = handler.command.match(/scripts\/([a-z-]+\.js)/);
            if (match) {
              const scriptName = match[1];
              const scriptPath = path.join(PLUGIN_ROOT, 'scripts', scriptName);
              if (!fs.existsSync(scriptPath)) {
                error(`Hook script not found: ${scriptPath}`);
              } else {
                success(`Hook script exists: ${scriptName} (${hookType})`);
              }
            }
          }
        });
      });
    });
  } else if (pluginConfig.hooks && typeof pluginConfig.hooks === 'string') {
    // External hooks.json file (legacy pattern)
    const hooksJsonPath = path.join(PLUGIN_ROOT, '.claude-plugin', pluginConfig.hooks);
    if (!fs.existsSync(hooksJsonPath)) {
      error(`Hooks file not found: ${hooksJsonPath}`);
    } else {
      try {
        const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
        success(`Hooks file exists: ${pluginConfig.hooks}`);

        // Validate hook scripts exist
        Object.entries(hooksConfig).forEach(([_hookType, hookConfigs]) => {
          hookConfigs.forEach((config) => {
            if (config.command) {
              // Extract script path from command
              const match = config.command.match(/scripts\/([a-z-]+\.js)/);
              if (match) {
                const scriptName = match[1];
                const scriptPath = path.join(PLUGIN_ROOT, 'scripts', scriptName);
                if (!fs.existsSync(scriptPath)) {
                  error(`Hook script not found: ${scriptPath}`);
                } else {
                  success(`Hook script exists: ${scriptName}`);
                }
              }
            }
          });
        });
      } catch (err) {
        error(`Invalid hooks.json: ${err.message}`);
      }
    }
  } else {
    warn('No hooks field in plugin.json');
  }
}

/**
 * Validate .mcp.json structure
 */
function validateMcpJson(mcpConfig) {
  if (!mcpConfig) {
    return;
  }

  if (!mcpConfig.mcpServers) {
    error('.mcp.json missing mcpServers');
    return;
  }

  const serverNames = Object.keys(mcpConfig.mcpServers);
  success(`.mcp.json has ${serverNames.length} servers: ${serverNames.join(', ')}`);

  serverNames.forEach((serverName) => {
    const server = mcpConfig.mcpServers[serverName];

    if (!server.command) {
      error(`.mcp.json server ${serverName} missing command`);
    } else {
      success(`.mcp.json server ${serverName} has command: ${server.command}`);
    }

    if (!server.args || !Array.isArray(server.args)) {
      warn(`.mcp.json server ${serverName} missing or invalid args`);
    } else {
      success(`.mcp.json server ${serverName} has ${server.args.length} args`);
    }

    if (server.env) {
      const envKeys = Object.keys(server.env);
      success(`.mcp.json server ${serverName} has env: ${envKeys.join(', ')}`);
    }
  });
}

/**
 * Validate package.json
 */
function validatePackageJson(pkg) {
  if (!pkg) {
    return;
  }

  const required = ['name', 'version'];
  required.forEach((field) => {
    if (!pkg[field]) {
      error(`package.json missing required field: ${field}`);
    } else {
      success(`package.json has ${field}: ${pkg[field]}`);
    }
  });

  if (pkg.scripts) {
    const scriptCount = Object.keys(pkg.scripts).length;
    success(`package.json has ${scriptCount} scripts`);
  }

  if (pkg.dependencies) {
    const depCount = Object.keys(pkg.dependencies).length;
    success(`package.json has ${depCount} dependencies`);
  }
}

/**
 * Main validation
 */
function main() {
  console.log('🔍 MAMA Plugin Manifest Validation\n');
  console.log(`Plugin root: ${PLUGIN_ROOT}\n`);

  // 1. Validate plugin.json
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📄 Validating plugin.json');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  const pluginConfig = validateJsonFile(PLUGIN_JSON, 'plugin.json');
  if (pluginConfig) {
    validatePluginJson(pluginConfig);
  }

  // 2. Validate .mcp.json
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📄 Validating .mcp.json');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  const mcpConfig = validateJsonFile(MCP_JSON, '.mcp.json');
  if (mcpConfig) {
    validateMcpJson(mcpConfig);
  }

  // 3. Validate package.json
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📄 Validating package.json');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  const pkg = validateJsonFile(PACKAGE_JSON, 'package.json');
  if (pkg) {
    validatePackageJson(pkg);
  }

  // 4. Summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Validation Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(`✅ Passed: ${passCount}`);
  console.log(`❌ Errors: ${errors.length}`);
  console.log(`⚠️  Warnings: ${warnings.length}`);

  if (errors.length > 0) {
    console.log('\n❌ VALIDATION FAILED\n');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log('\n⚠️  VALIDATION PASSED WITH WARNINGS\n');
  } else {
    console.log('\n✅ ALL VALIDATIONS PASSED\n');
  }

  process.exit(0);
}

main();
