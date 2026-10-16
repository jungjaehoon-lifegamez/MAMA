#!/usr/bin/env node
/**
 * MAMA Version Sync Script
 *
 * Reads actual versions from package.json files and updates documentation
 * files that reference those versions. No markers needed — the script
 * knows which files contain version references and updates them directly.
 *
 * Designed to run in pre-commit hook so docs always stay in sync with
 * package.json versions.
 *
 * Exit codes:
 * - 0: All versions in sync (or updated successfully)
 * - 1: --check mode found outdated versions
 *
 * Usage:
 *   node scripts/sync-versions.js            # Update docs in-place
 *   node scripts/sync-versions.js --check    # CI: exit 1 if out of sync
 *   node scripts/sync-versions.js --dry-run  # Show changes without writing
 *
 * @version 2.0.0
 * @date 2026-02-08
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Source of truth: package.json -> version
const PACKAGES = {
  'mama-os': { path: 'packages/standalone/package.json', label: 'MAMA OS' },
  'mama-server': { path: 'packages/mcp-server/package.json', label: 'MCP Server' },
  'mama-core': { path: 'packages/mama-core/package.json', label: 'MAMA Core' },
  'claude-code-plugin': {
    path: 'packages/claude-code-plugin/package.json',
    label: 'Claude Plugin',
  },
};

// semver pattern: 0.4.0, 1.7.2, 0.5.0-beta, 2.0.0-rc.1, etc.
const SEMVER = '[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.]+)?';

/**
 * Define replacement rules: each rule targets a specific file + pattern.
 * Patterns use a capture group around the prefix to preserve context.
 *
 * @param {Record<string, string>} versions - Package key -> version string
 * @returns {Array<{file: string, patterns: Array<{regex: RegExp, version: string, suffix?: boolean}>}>}
 */
function buildRules(versions) {
  const os = versions['mama-os'];
  const core = versions['mama-core'];
  const server = versions['mama-server'];
  const plugin = versions['claude-code-plugin'];
  // Package table rows: | [Label](packages/<dir>/README.md) | role | <version> |
  const row = (label, dir, version) => ({
    regex: new RegExp(
      `(\\| \\[${label}\\]\\(packages/${dir}/README\\.md\\)\\s*\\|[^|]*\\| )${SEMVER}(\\s*\\|)`,
      'g'
    ),
    version,
    suffix: true,
  });
  // Package README headers: Version **x.y.z**
  const header = (version) => ({
    regex: new RegExp(`(Version \\*\\*)${SEMVER}(\\*\\*)`, 'g'),
    version,
    suffix: true,
  });
  return [
    {
      file: 'README.md',
      patterns: [
        row('MAMA OS', 'standalone', os),
        row('mama-core', 'mama-core', core),
        row('Public MCP server', 'mcp-server', server),
        row('Claude Code plugin', 'claude-code-plugin', plugin),
      ],
    },
    {
      file: 'packages/standalone/README.md',
      patterns: [
        header(os),
        {
          regex: new RegExp(`(Current manifest: \\*\\*)${SEMVER}(\\*\\*)`, 'g'),
          version: os,
          suffix: true,
        },
      ],
    },
    { file: 'packages/mama-core/README.md', patterns: [header(core)] },
    { file: 'packages/mcp-server/README.md', patterns: [header(server)] },
    { file: 'packages/claude-code-plugin/README.md', patterns: [header(plugin)] },
    {
      // The plugin runs the server released with it.
      file: 'packages/claude-code-plugin/.mcp.json',
      patterns: [
        {
          regex: new RegExp(`("@jungjaehoon/mama-server@)${SEMVER}(")`, 'g'),
          version: server,
          suffix: true,
        },
      ],
    },
  ];
}

/**
 * Read version from a package.json file.
 *
 * @param {string} relativePath - Path relative to monorepo root
 * @returns {string} Version string
 */
function readVersion(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  if (!pkg.version) {
    throw new Error(`No "version" field in ${relativePath}`);
  }
  return pkg.version;
}

/**
 * Load all package versions.
 *
 * @returns {Record<string, string>} Package key -> version
 */
function loadVersions() {
  const versions = {};
  for (const [key, config] of Object.entries(PACKAGES)) {
    versions[key] = readVersion(config.path);
  }
  return versions;
}

/**
 * Process a single file with its replacement rules.
 *
 * @param {string} file - Relative file path
 * @param {Array<{regex: RegExp, version: string, suffix?: boolean}>} patterns
 * @param {{ check: boolean, dryRun: boolean }} opts
 * @returns {{ replacements: number, changes: string[] }}
 */
function processFile(file, patterns, opts) {
  const fullPath = path.join(ROOT, file);
  if (!fs.existsSync(fullPath)) {
    return { replacements: 0, changes: [] };
  }

  let content = fs.readFileSync(fullPath, 'utf8');
  let replacements = 0;
  const changes = [];

  for (const rule of patterns) {
    const newContent = content.replace(rule.regex, (match, prefix, maybeSuffix) => {
      const oldVersion = rule.suffix
        ? match.replace(prefix, '').replace(maybeSuffix, '').trim()
        : match.replace(prefix, '').trim();

      if (oldVersion === rule.version) {
        return match; // Already up to date
      }

      replacements++;
      changes.push(`${oldVersion} -> ${rule.version}`);

      if (rule.suffix) {
        return `${prefix}${rule.version}${maybeSuffix}`;
      }
      return `${prefix}${rule.version}`;
    });
    content = newContent;
  }

  if (replacements > 0 && !opts.check && !opts.dryRun) {
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  return { replacements, changes };
}

/**
 * Parse CLI flags.
 *
 * @returns {{ check: boolean, dryRun: boolean }}
 */
function parseFlags() {
  const args = process.argv.slice(2);
  return {
    check: args.includes('--check'),
    dryRun: args.includes('--dry-run'),
  };
}

function main() {
  const opts = parseFlags();
  const versions = loadVersions();
  const rules = buildRules(versions);

  const mode = opts.check ? 'Checking' : opts.dryRun ? 'Dry run' : 'Syncing';
  console.log(`${mode} doc versions against package.json…\n`);

  console.log('Current versions (from package.json):');
  for (const [key, config] of Object.entries(PACKAGES)) {
    console.log(`  ${config.label.padEnd(15)} ${versions[key]}`);
  }
  console.log();

  let totalReplacements = 0;
  const outdatedFiles = [];

  for (const rule of rules) {
    const { replacements, changes: fileChanges } = processFile(rule.file, rule.patterns, opts);

    if (replacements > 0) {
      totalReplacements += replacements;
      outdatedFiles.push(rule.file);
      const label = opts.check ? '!' : '*';
      console.log(`  ${label} ${rule.file} (${replacements} update${replacements > 1 ? 's' : ''})`);
      for (const change of fileChanges) {
        console.log(`      ${change}`);
      }
    }
  }

  console.log();

  if (opts.check) {
    if (outdatedFiles.length > 0) {
      console.log(
        `FAIL: ${totalReplacements} outdated version${totalReplacements > 1 ? 's' : ''} in ${outdatedFiles.length} file${outdatedFiles.length > 1 ? 's' : ''}.`
      );
      console.log('Run "pnpm sync-versions" to update them.');
      process.exit(1);
    } else {
      console.log('OK: All doc versions are in sync.');
    }
  } else if (opts.dryRun) {
    if (totalReplacements > 0) {
      console.log(
        `Would update ${totalReplacements} version${totalReplacements > 1 ? 's' : ''}. Run without --dry-run to apply.`
      );
    } else {
      console.log('OK: All doc versions are in sync.');
    }
  } else {
    if (totalReplacements > 0) {
      console.log(`Updated ${totalReplacements} version${totalReplacements > 1 ? 's' : ''}.`);
    } else {
      console.log('OK: All doc versions are in sync.');
    }
  }
}

main();
