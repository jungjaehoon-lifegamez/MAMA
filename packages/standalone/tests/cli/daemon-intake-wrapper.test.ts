import { expect, it, vi } from 'vitest';
import { loggedOwnerIntake } from '../../src/cli/commands/daemon.js';

it('keeps the deferral of a retired member intake through the logging wrapper', () => {
  const intake = {
    accept: vi.fn(),
    acceptOwnerMessage: vi.fn(),
    recordOwnerReply: vi.fn(),
    acceptSourceDelta: vi.fn(),
    acceptScheduled: vi.fn(),
    deferIncoming: () => true,
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  // Without it the gateway never takes its durable-envelope branch for a member under erasure.
  expect(loggedOwnerIntake(intake as never, logger).deferIncoming?.()).toBe(true);
  expect(
    loggedOwnerIntake({ ...intake, deferIncoming: undefined } as never, logger)
  ).not.toHaveProperty('deferIncoming');
});
