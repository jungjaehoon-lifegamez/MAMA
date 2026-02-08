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
  'openclaw-plugin': { path: 'packages/openclaw-plugin/package.json', label: 'OpenClaw' },
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
  return [
    {
      file: 'README.md',
      patterns: [
        // **Package:** `@jungjaehoon/mama-os` 0.5.0-beta
        {
          regex: new RegExp(`(\\*\\*Package:\\*\\* \`@jungjaehoon/mama-os\` )${SEMVER}`, 'g'),
          version: versions['mama-os'],
        },
        {
          regex: new RegExp(`(\\*\\*Package:\\*\\* \`@jungjaehoon/mama-server\` )${SEMVER}`, 'g'),
          version: versions['mama-server'],
        },
        {
          regex: new RegExp(`(\\*\\*Package:\\*\\* \`@jungjaehoon/openclaw-mama\` )${SEMVER}`, 'g'),
          version: versions['openclaw-plugin'],
        },
        {
          regex: new RegExp(`(\\*\\*Package:\\*\\* \`@jungjaehoon/mama-core\` )${SEMVER}`, 'g'),
          version: versions['mama-core'],
        },
        // Table rows: | [@jungjaehoon/mama-os](...) | 0.5.0-beta |
        {
          regex: new RegExp(`(\\| \\[@jungjaehoon/mama-os\\][^|]+\\| )${SEMVER}(\\s*\\|)`, 'g'),
          version: versions['mama-os'],
          suffix: true,
        },
        {
          regex: new RegExp(`(\\| \\[@jungjaehoon/mama-server\\][^|]+\\| )${SEMVER}(\\s*\\|)`, 'g'),
          version: versions['mama-server'],
          suffix: true,
        },
        {
          regex: new RegExp(`(\\| \\[@jungjaehoon/mama-core\\][^|]+\\| )${SEMVER}(\\s*\\|)`, 'g'),
          version: versions['mama-core'],
          suffix: true,
        },
        {
          regex: new RegExp(`(\\| \\[mama\\][^|]+\\| )${SEMVER}(\\s*\\|)`, 'g'),
          version: versions['claude-code-plugin'],
          suffix: true,
        },
        {
          regex: new RegExp(
            `(\\| \\[@jungjaehoon/openclaw-mama\\][^|]+\\| )${SEMVER}(\\s*\\|)`,
            'g'
          ),
          version: versions['openclaw-plugin'],
          suffix: true,
        },
      ],
    },
    {
      file: 'docs/architecture/package-structure.md',
      patterns: [
        {
          regex: new RegExp(`(- \\*\\*mama-core:\\*\\* )${SEMVER}`, 'g'),
          version: versions['mama-core'],
        },
        {
          regex: new RegExp(`(- \\*\\*mama-server:\\*\\* )${SEMVER}`, 'g'),
          version: versions['mama-server'],
        },
        {
          regex: new RegExp(`(- \\*\\*claude-code-plugin:\\*\\* )${SEMVER}`, 'g'),
          version: versions['claude-code-plugin'],
        },
        {
          regex: new RegExp(`(- \\*\\*mama-os:\\*\\* )${SEMVER}`, 'g'),
          version: versions['mama-os'],
        },
      ],
    },
    {
      file: 'docs/guides/deployment.md',
      patterns: [
        // Top summary table (5 package rows)
        {
          regex: new RegExp(`(\\| MAMA OS[^|]+\\|[^|]+\\|[^|]+\\|[^|]+\\| )${SEMVER}`, 'g'),
          version: versions['mama-os'],
        },
        {
          regex: new RegExp(`(\\| MCP Server[^|]+\\|[^|]+\\|[^|]+\\|[^|]+\\| )${SEMVER}`, 'g'),
          version: versions['mama-server'],
        },
        {
          regex: new RegExp(`(\\| MAMA Core[^|]+\\|[^|]+\\|[^|]+\\|[^|]+\\| )${SEMVER}`, 'g'),
          version: versions['mama-core'],
        },
        {
          regex: new RegExp(
            `(\\| Claude Code Plugin[^|]+\\|[^|]+\\|[^|]+\\|[^|]+\\| )${SEMVER}`,
            'g'
          ),
          version: versions['claude-code-plugin'],
        },
        {
          regex: new RegExp(`(\\| OpenClaw Plugin[^|]+\\|[^|]+\\|[^|]+\\|[^|]+\\| )${SEMVER}`, 'g'),
          version: versions['openclaw-plugin'],
        },
        // Version Update Locations table (5 rows by package.json path)
        {
          regex: new RegExp(
            `(\\| \`packages/standalone/package\\.json\`[^|]+\\|[^|]+\\| )${SEMVER}`,
            'g'
          ),
          version: versions['mama-os'],
        },
        {
          regex: new RegExp(
            `(\\| \`packages/mcp-server/package\\.json\`[^|]+\\|[^|]+\\| )${SEMVER}`,
            'g'
          ),
          version: versions['mama-server'],
        },
        {
          regex: new RegExp(
            `(\\| \`packages/mama-core/package\\.json\`[^|]+\\|[^|]+\\| )${SEMVER}`,
            'g'
          ),
          version: versions['mama-core'],
        },
        {
          regex: new RegExp(
            `(\\| \`packages/claude-code-plugin/package\\.json\`[^|]+\\|[^|]+\\| )${SEMVER}`,
            'g'
          ),
          version: versions['claude-code-plugin'],
        },
        {
          regex: new RegExp(
            `(\\| \`packages/openclaw-plugin/package\\.json\`[^|]+\\|[^|]+\\| )${SEMVER}`,
            'g'
          ),
          version: versions['openclaw-plugin'],
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
