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

let errors = [];
let warnings = [];
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

function info(msg) {
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
  if (!pluginConfig) return;

  // Check required fields
  const required = ['name', 'version', 'description'];
  required.forEach(field => {
    if (!pluginConfig[field]) {
      error(`plugin.json missing required field: ${field}`);
    } else {
      success(`plugin.json has ${field}: ${pluginConfig[field]}`);
    }
  });

  // Check commands (auto-discovered from commands/ directory per official spec)
  const commandsDir = path.join(PLUGIN_ROOT, 'commands');
  if (fs.existsSync(commandsDir)) {
    const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'));
    if (commandFiles.length > 0) {
      success(`commands/ directory has ${commandFiles.length} command(s): ${commandFiles.join(', ')}`);
    } else {
      warn('commands/ directory exists but has no .md files');
    }
  } else if (pluginConfig.commands && Array.isArray(pluginConfig.commands)) {
    // Legacy: plugin.json lists commands (non-standard, but check if they exist)
    warn('plugin.json has commands array (non-standard, use commands/ directory for auto-discovery)');
    success(`plugin.json has ${pluginConfig.commands.length} commands`);
    pluginConfig.commands.forEach(cmd => {
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

  // Check skills
  if (!pluginConfig.skills || !Array.isArray(pluginConfig.skills)) {
    warn('plugin.json has no skills array');
  } else {
    success(`plugin.json has ${pluginConfig.skills.length} skills`);
    pluginConfig.skills.forEach(skill => {
      const skillPath = path.join(PLUGIN_ROOT, '.claude-plugin', skill.path, 'SKILL.md');
      if (!fs.existsSync(skillPath)) {
        error(`Skill SKILL.md not found: ${skillPath}`);
      } else {
        success(`Skill exists: ${skill.name}`);
      }
    });
  }

  // Check hooks
  if (!pluginConfig.hooks) {
    warn('plugin.json has no hooks');
  } else {
    const hookTypes = Object.keys(pluginConfig.hooks);
    success(`plugin.json has hooks: ${hookTypes.join(', ')}`);

    hookTypes.forEach(hookType => {
      const hookConfigs = pluginConfig.hooks[hookType];
      if (!Array.isArray(hookConfigs)) {
        error(`Hook ${hookType} is not an array`);
        return;
      }

      hookConfigs.forEach((hookConfig, idx) => {
        if (!hookConfig.hooks || !Array.isArray(hookConfig.hooks)) {
          error(`Hook ${hookType}[${idx}] missing hooks array`);
          return;
        }

        hookConfig.hooks.forEach((hook, hookIdx) => {
          if (!hook.command) {
            error(`Hook ${hookType}[${idx}].hooks[${hookIdx}] missing command`);
            return;
          }

          // Check if script exists (resolve ${CLAUDE_PLUGIN_ROOT})
          const scriptPath = hook.command.replace('${CLAUDE_PLUGIN_ROOT}/', '');
          const fullPath = path.join(PLUGIN_ROOT, scriptPath);

          if (!fs.existsSync(fullPath)) {
            error(`Hook script not found: ${fullPath}`);
          } else {
            // Check if executable
            try {
              fs.accessSync(fullPath, fs.constants.X_OK);
              success(`Hook script executable: ${scriptPath}`);
            } catch (err) {
              warn(`Hook script not executable: ${scriptPath}`);
            }
          }
        });
      });
    });
  }
}

/**
 * Validate .mcp.json structure
 */
function validateMcpJson(mcpConfig) {
  if (!mcpConfig) return;

  if (!mcpConfig.mcpServers) {
    error('.mcp.json missing mcpServers');
    return;
  }

  const serverNames = Object.keys(mcpConfig.mcpServers);
  success(`.mcp.json has ${serverNames.length} servers: ${serverNames.join(', ')}`);

  serverNames.forEach(serverName => {
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
  if (!pkg) return;

  const required = ['name', 'version'];
  required.forEach(field => {
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
