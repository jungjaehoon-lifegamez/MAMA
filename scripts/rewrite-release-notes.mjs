#!/usr/bin/env node
// Rewrite each `vX.Y.Z` GitHub release so its notes carry that version's section of the root
// CHANGELOG and the package versions at its tag, in the release workflow's format, under the
// title `MAMA vX.Y.Z`. Dry run by default; `--apply` writes. Every run saves all current titles
// and bodies first (`--backup <file>`), and a release whose title and body already match is left.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const backupIndex = args.indexOf('--backup');
const backupPath = resolve(
  backupIndex >= 0
    ? args[backupIndex + 1]
    : `../mama-release-notes-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
);
const sampleIndex = args.indexOf('--sample');
const sampleTag = sampleIndex >= 0 ? args[sampleIndex + 1] : null;

const run = (cmd, cmdArgs, input) =>
  execFileSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input });
const repo = JSON.parse(run('gh', ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;

// The root CHANGELOG's section for each MAMA OS version. Two heading styles exist:
// `## mama-os [X.Y.Z] / ...` and the older `## [X.Y.Z] / mama-core [...] ...` or `## [X.Y.Z] - date`,
// where the first bracket is the MAMA OS version. Package-only sections (`## [plugin-1.7.13]`) are skipped.
const sections = new Map();
{
  const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
  let current = null;
  const flush = () => {
    if (current && !sections.has(current.version)) {
      sections.set(current.version, current.lines.join('\n').replace(/\s+$/, ''));
    }
  };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      const os = line.match(/mama-os \[(\d+\.\d+\.\d+)\]/) ?? line.match(/^## \[(0\.\d+\.\d+)\]/);
      current = os ? { version: os[1], lines: [line] } : null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
}

// A package that did not exist yet at a tag shows a dash; any other Git failure stops the run.
function packageVersion(tag, dir) {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${tag}:packages/${dir}/package.json`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).version;
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return '—';
    throw error;
  }
}

// The release workflow's notes (.github/workflows/release.yml), filled for one tag.
function render(version, tag, changelog) {
  const core = packageVersion(tag, 'mama-core');
  const server = packageVersion(tag, 'mcp-server');
  const os = packageVersion(tag, 'standalone');
  const plugin = packageVersion(tag, 'claude-code-plugin');
  return `## MAMA v${version}

### Package Versions
| Package | Version | npm |
|---------|---------|-----|
| @jungjaehoon/mama-core | ${core} | [![npm](https://img.shields.io/npm/v/@jungjaehoon/mama-core)](https://www.npmjs.com/package/@jungjaehoon/mama-core) |
| @jungjaehoon/mama-server | ${server} | [![npm](https://img.shields.io/npm/v/@jungjaehoon/mama-server)](https://www.npmjs.com/package/@jungjaehoon/mama-server) |
| @jungjaehoon/mama-os | ${os} | [![npm](https://img.shields.io/npm/v/@jungjaehoon/mama-os)](https://www.npmjs.com/package/@jungjaehoon/mama-os) |
| mama (Claude Plugin) | ${plugin} | Claude Marketplace |

### Installation

\`\`\`bash
# MAMA OS (Always-on Agent)
npm install -g @jungjaehoon/mama-os

# MCP Server (Claude Desktop/Code)
npx @jungjaehoon/mama-server

# Claude Code Plugin
/plugin marketplace add jungjaehoon-lifegamez/claude-plugins
/plugin install mama
\`\`\`

### Changelog
${changelog}

---
📚 [Documentation](https://jungjaehoon-lifegamez.github.io/MAMA)`;
}

const releases = JSON.parse(
  run('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases`])
).flat();
// Package versions come from each tag, so a checkout without the tags must not plan anything.
const missingTags = releases
  .map((release) => release.tag_name)
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  .filter((tag) => {
    try {
      run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
      return false;
    } catch {
      return true;
    }
  });
if (missingTags.length > 0) {
  throw new Error(`Local tags missing (run git fetch --tags): ${missingTags.join(' ')}`);
}
// The first snapshot is the one a restore needs, so an existing backup is never overwritten.
writeFileSync(
  backupPath,
  JSON.stringify(
    releases.map((r) => ({ id: r.id, tag: r.tag_name, name: r.name, body: r.body })),
    null,
    1
  ),
  { flag: 'wx' }
);

const plan = { rewrite: [], unchanged: [], skipped: [] };
for (const release of releases) {
  const tag = release.tag_name;
  const match = tag.match(/^v(\d+\.\d+\.\d+)$/);
  if (!match) {
    plan.skipped.push({ tag, reason: 'not a vX.Y.Z tag' });
    continue;
  }
  const version = match[1];
  const changelog = sections.get(version);
  if (!changelog) {
    plan.skipped.push({ tag, reason: 'no MAMA OS section in the root CHANGELOG' });
    continue;
  }
  const name = `MAMA v${version}`;
  const body = render(version, tag, changelog);
  if (release.name === name && (release.body ?? '').trim() === body.trim()) {
    plan.unchanged.push(tag);
    continue;
  }
  plan.rewrite.push({
    id: release.id,
    tag,
    name,
    body,
    before: release.body ?? '',
    beforeName: release.name,
  });
}

console.log(
  `releases ${releases.length}: rewrite ${plan.rewrite.length}, unchanged ${plan.unchanged.length}, skipped ${plan.skipped.length}`
);
console.log(`backup of every current title and body: ${backupPath}`);
const reasons = {};
for (const s of plan.skipped) (reasons[s.reason] ??= []).push(s.tag);
for (const [reason, tags] of Object.entries(reasons))
  console.log(`skipped (${reason}): ${tags.join(' ')}`);
const sample = plan.rewrite.find((r) => r.tag === sampleTag) ?? plan.rewrite[0];
if (sample) {
  console.log(`\n--- sample ${sample.tag}: title "${sample.beforeName}" -> "${sample.name}"`);
  console.log('--- before (first 15 lines)\n' + sample.before.split('\n').slice(0, 15).join('\n'));
  console.log('--- after\n' + sample.body);
}

if (apply) {
  for (const r of plan.rewrite) {
    const payload = join(tmpdir(), `release-${r.id}.json`);
    writeFileSync(payload, JSON.stringify({ name: r.name, body: r.body }));
    run('gh', ['api', '-X', 'PATCH', `repos/${repo}/releases/${r.id}`, '--input', payload]);
    console.log(`rewrote ${r.tag}`);
  }
}
