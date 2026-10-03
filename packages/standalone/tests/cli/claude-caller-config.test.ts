import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  claudeOwnerAllowedTools,
  claudeOwnerDisallowedTools,
} from '../../src/agent/claude-native-tool-policy.js';
import { ensureClaudeCallerHook } from '../../src/cli/runtime/claude-caller-config.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-settings-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.claude'), { recursive: true });
  const path = join(workspace, '.claude', 'settings.json');
  return { root, workspace, path };
}

describe('owner Claude workspace settings', () => {
  it("sends the shell sandbox's network to the host proxy when the host gives one", () => {
    const { workspace, path } = fixture();
    ensureClaudeCallerHook(workspace, [], { httpProxyPort: 41001, socksProxyPort: 41002 });
    expect(JSON.parse(readFileSync(path, 'utf8')).sandbox.network).toEqual({
      httpProxyPort: 41001,
      socksProxyPort: 41002,
    });
    ensureClaudeCallerHook(workspace);
    expect(JSON.parse(readFileSync(path, 'utf8')).sandbox.network).toBeUndefined();
  });

  it('removes stale grants from both host-owned scopes; permission rules go on the CLI', () => {
    const { workspace, path } = fixture();
    const localPath = join(workspace, '.claude', 'settings.local.json');
    writeFileSync(
      localPath,
      JSON.stringify({
        permissions: { allow: ['Edit', 'Write'], additionalDirectories: ['/tmp'] },
        sandbox: { enabled: false, filesystem: { allowWrite: ['/tmp'] } },
        model: 'test-model',
      })
    );
    ensureClaudeCallerHook(workspace);
    const project = JSON.parse(readFileSync(path, 'utf8'));
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    expect(project.permissions).toBeUndefined();
    expect(local.permissions).toBeUndefined();
    expect(local).toEqual({});
    expect(local.model).toBeUndefined();
  });

  it('replaces broad permissions with a required sandbox and discards every non-host setting', () => {
    const { workspace, path } = fixture();
    const otherHook = { matcher: 'Read', hooks: [{ type: 'command', command: 'true' }] };
    writeFileSync(
      path,
      JSON.stringify({
        model: 'test-model',
        permissions: { allow: ['Edit', 'Write'], defaultMode: 'bypassPermissions' },
        sandbox: { enabled: false, excludedCommands: ['python'] },
        hooks: { PreToolUse: [otherHook], Stop: [] },
      })
    );
    ensureClaudeCallerHook(workspace);
    const first = readFileSync(path, 'utf8');
    ensureClaudeCallerHook(workspace);
    expect(readFileSync(path, 'utf8')).toBe(first);
    const settings = JSON.parse(first);
    expect(settings.model).toBeUndefined();
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: 'mcp__mama__.*',
        hooks: [{ type: 'command', command: expect.stringContaining('claude-caller-hook.js') }],
      },
    ]);
    expect(settings.hooks.Stop).toBeUndefined();
    expect(settings.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        allowWrite: [workspace],
        denyRead: [],
        denyWrite: [join(workspace, '.claude')],
      },
    });
    expect(settings.permissions).toBeUndefined();
    expect(settings.env.CLAUDE_CODE_TMPDIR).toBe(join(workspace, '.tmp'));
    expect(settings.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
  });

  it('denies native edits of host settings while allowing other workspace files', () => {
    const { workspace } = fixture();
    const rules = claudeOwnerDisallowedTools([], workspace);
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(rules).toContain(`${tool}(/${workspace}/.claude)`);
      expect(rules).toContain(`${tool}(/${workspace}/.claude/**)`);
    }
  });

  it('allows writes only under the workspace by one absolute Edit rule, plus web and MAMA tools', () => {
    const { root, workspace } = fixture();
    const rules = claudeOwnerAllowedTools(workspace);
    // Measured on Claude Code 2.1.282 with --permission-mode dontAsk: Edit(//<dir>/**) allowed Write
    // inside and denied outside; a bare Write rule allowed both.
    const edits = rules.filter((rule) => /^(Edit|Write|NotebookEdit)(\(|$)/.test(rule));
    expect(edits).toEqual([`Edit(/${workspace}/**)`]);
    expect(rules).toEqual(
      expect.arrayContaining(['WebFetch', 'WebSearch', 'mcp__mama__*', 'Agent'])
    );
    const anchor = edits[0]!.slice('Edit(/'.length, -'/**)'.length);
    const permitted = (target: string): boolean => {
      const fromAnchor = relative(anchor, resolve(workspace, target));
      return (
        fromAnchor !== '..' && !fromAnchor.startsWith(`..${sep}`) && !fromAnchor.startsWith(sep)
      );
    };
    expect(permitted('report.txt')).toBe(true);
    expect(permitted('nested/report.txt')).toBe(true);
    expect(permitted(join(root, 'outside.txt'))).toBe(false);
    expect(permitted('../outside.txt')).toBe(false);
    expect(permitted('nested/../../outside.txt')).toBe(false);
    expect(permitted(`${workspace}-other/report.txt`)).toBe(false);
  });
});
