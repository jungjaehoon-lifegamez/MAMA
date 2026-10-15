import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readWebFetchTurnMode,
  webFetchDecision,
  webFetchTurnMode,
  writeWebFetchTurnMode,
} from '../../src/runtime/web-fetch-scope.js';
import { webFetchHookOutput } from '../../src/runtime/claude-caller-hook.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const dir = () => {
  const root = mkdtempSync(join(tmpdir(), 'web-fetch-scope-'));
  roots.push(root);
  return root;
};

describe('WebFetch scope in turns with no person in them', () => {
  it('lets a person-spoken turn fetch anything and scopes every other turn to listed hosts', () => {
    const hosts = ['stat.go.jp', 'exchange-rates.org'];
    expect(
      webFetchDecision(webFetchTurnMode('owner_message', []), 'https://any.example/x')
    ).toEqual({ allow: true });
    for (const source of ['source_delta', 'scheduled', undefined]) {
      const mode = webFetchTurnMode(source, hosts);
      expect(mode.autonomous).toBe(true);
      expect(webFetchDecision(mode, 'https://www.stat.go.jp/data/cpi/')).toEqual({ allow: true });
      expect(webFetchDecision(mode, 'https://exchange-rates.org:443/a')).toEqual({ allow: true });
      for (const url of [
        'https://attacker.example/?d=secret',
        'https://stat.go.jp.attacker.example/',
        'https://notstat.go.jp/',
        'not a url',
      ])
        expect(webFetchDecision(mode, url)).toMatchObject({
          allow: false,
          reason: expect.stringContaining('WebSearch'),
        });
    }
    expect(
      webFetchDecision(webFetchTurnMode('scheduled', []), 'https://stat.go.jp/')
    ).toMatchObject({ allow: false });
    expect(webFetchDecision(webFetchTurnMode('scheduled', ['*']), 'https://a.example/')).toEqual({
      allow: true,
    });
    expect(webFetchDecision(null, 'https://stat.go.jp/')).toMatchObject({
      allow: false,
      reason: expect.stringContaining('could not be read'),
    });
  });

  it('round-trips the mode file and reads a missing or malformed one as no mode', () => {
    const path = join(dir(), 'runtime', 'web-fetch-turn.json');
    expect(readWebFetchTurnMode(path)).toBeNull();
    writeWebFetchTurnMode(path, { autonomous: false, hosts: ['stat.go.jp'] });
    expect(readWebFetchTurnMode(path)).toEqual({ autonomous: false, hosts: ['stat.go.jp'] });
    writeFileSync(path, '{"autonomous":"no","hosts":[]}');
    expect(readWebFetchTurnMode(path)).toBeNull();
    writeFileSync(path, 'not json');
    expect(readWebFetchTurnMode(path)).toBeNull();
  });

  it('answers the Claude hook with a deny and its reason, or nothing to add', () => {
    const path = join(dir(), 'web-fetch-turn.json');
    writeWebFetchTurnMode(path, { autonomous: true, hosts: [] });
    expect(webFetchHookOutput({ tool_input: { url: 'https://a.example/?d=x' } }, path)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('agent.autonomous_web_fetch'),
      },
    });
    writeWebFetchTurnMode(path, { autonomous: false, hosts: [] });
    expect(webFetchHookOutput({ tool_input: { url: 'https://a.example/' } }, path)).toEqual({});
    expect(
      webFetchHookOutput({ tool_input: { url: 'https://a.example/' } }, join(dir(), 'missing'))
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});
