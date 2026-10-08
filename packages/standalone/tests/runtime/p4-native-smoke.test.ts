import { expect, it } from 'vitest';
// Import pure helpers only. No prepare/run/verify command, login or model process is invoked.
import {
  classifyProbe,
  parseArguments,
  smokeProbes,
  toolCalls,
} from '../../../../scripts/p4-native-smoke.mjs';

const probe = { id: 'python-db', kind: 'shell', command: 'head -c 16 /fixture/db # p4:python-db' };
it('does not call a model refusal, missing file, missing import or incomplete CLI event a boundary proof', () => {
  expect(classifyProbe(probe, [])).toBe('unverified');
  for (const output of [
    'No such file or directory',
    'ModuleNotFoundError: openpyxl',
    'binary file not supported',
  ])
    expect(
      classifyProbe(probe, [{ kind: 'shell', input: probe.command, error: true, output }])
    ).toBe('unverified');
  expect(classifyProbe(probe, [{ kind: 'shell', input: probe.command, error: true }])).toBe(
    'unverified'
  );
  expect(
    classifyProbe(probe, [
      {
        kind: 'shell',
        input: probe.command,
        error: true,
        output: 'Permission denied',
        exitCode: undefined,
      },
    ])
  ).toBe('unverified');
  expect(
    classifyProbe(probe, [
      {
        kind: 'Bash',
        input: { command: probe.command },
        error: false,
        output: 'binary file not supported',
      },
    ])
  ).toBe('unverified');
});
it('uses raw Claude is_error and Codex exit code plus refusal text, and catches a successful retry', () => {
  const claude = toolCalls(
    [
      {
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'fixture-call',
              name: 'Bash',
              input: { command: probe.command },
            },
          ],
        },
      },
      {
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'fixture-call',
              is_error: true,
              content: 'Operation not permitted',
            },
          ],
        },
      },
    ],
    'claude'
  );
  expect(classifyProbe(probe, claude)).toBe('refused-by-CLI/sandbox');
  const codex = toolCalls(
    [
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'fixture-call',
            type: 'commandExecution',
            command: probe.command,
            exitCode: 1,
            aggregatedOutput: 'Permission denied',
          },
        },
      },
    ],
    'codex'
  );
  expect(classifyProbe(probe, codex)).toBe('refused-by-CLI/sandbox');
  expect(
    classifyProbe(probe, [
      ...codex,
      { ...codex[0], error: false, exitCode: 0, output: 'SQLite format 3' },
    ])
  ).toBe('succeeded');
});
it('requires the same explicit root and typed Telegram identity on every command and bounds DB shell reads', () => {
  expect(() => parseArguments(['prepare', '--member-root', '/fixture/members'])).toThrow(/Usage/);
  expect(
    parseArguments([
      'run',
      'claude',
      'fixture-model',
      '--member-root',
      '/fixture/members',
      '--telegram-id',
      '0',
    ]).command
  ).toBe('run');
  const state = {
    ownerHome: '/fixture/home',
    databasePath: '/fixture/db',
    ownerSentinel: '/fixture/home/sentinel',
    otherWorkspaceSentinel: '/fixture/other/workspace/sentinel',
    otherDownloadsSentinel: '/fixture/other/downloads/sentinel',
  };
  for (const backend of ['claude', 'codex'])
    for (const entry of smokeProbes(state, '/fixture/workspace', backend)) {
      if (entry.id.endsWith('-db') && entry.kind === 'shell')
        expect(entry.command).toMatch(/read\(16\)|head -c 16/);
    }
});
