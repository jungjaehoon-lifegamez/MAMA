import { describe, expect, it } from 'vitest';

import { inferTimelineEventRole, type InferredCaseRole } from '../../src/cases/role-inference.js';

describe('case role inference', () => {
  it('infers requester from English and Korean request language', () => {
    expect(inferTimelineEventRole({ userText: 'Please create the rollout plan.' })).toBe(
      'requester'
    );
    expect(
      inferTimelineEventRole({ userText: '\ubc30\ud3ec \uacc4\ud68d \uc815\ub9ac\ud574\uc918' })
    ).toBe('requester');
  });

  it('infers implementer from English and Korean work language', () => {
    expect(
      inferTimelineEventRole({
        userText: '',
        assistantText: 'I will handle the migration update.',
      })
    ).toBe('implementer');
    expect(
      inferTimelineEventRole({
        userText: '',
        assistantText: '\uc81c\uac00 \uc218\uc815\ud588\uc2b5\ub2c8\ub2e4.',
      })
    ).toBe('implementer');
  });

  it('infers reviewer from English and Korean review language', () => {
    expect(
      inferTimelineEventRole({
        userText: '',
        assistantText: 'I reviewed and approved the change.',
      })
    ).toBe('reviewer');
    expect(
      inferTimelineEventRole({
        userText: '',
        assistantText:
          '\ubcc0\uacbd\uc0ac\ud56d\uc744 \uac80\ud1a0\ud558\uace0 \uc2b9\uc778\ud588\uc2b5\ub2c8\ub2e4.',
      })
    ).toBe('reviewer');
  });

  it('infers affected from English and Korean blocked language', () => {
    expect(inferTimelineEventRole({ userText: 'The release is blocked waiting on CI.' })).toBe(
      'affected'
    );
    expect(
      inferTimelineEventRole({
        userText: '\ub9b4\ub9ac\uc2a4\uac00 CI \ub300\uae30\ub85c \ub9c9\ud614\uc2b5\ub2c8\ub2e4.',
      })
    ).toBe('affected');
  });

  it('infers observer from English and Korean status-only language', () => {
    expect(inferTimelineEventRole({ userText: 'FYI only: deploy finished.' })).toBe('observer');
    expect(
      inferTimelineEventRole({
        userText: '\ucc38\uace0\uc6a9 \uc0c1\ud0dc \uacf5\uc720\uc785\ub2c8\ub2e4.',
      })
    ).toBe('observer');
  });

  it('returns null when patterns conflict', () => {
    expect(
      inferTimelineEventRole({
        userText: 'Please update the case.',
        assistantText: 'I will handle it.',
      })
    ).toBeNull();
  });

  it('does not map owner or blocker wording without clear actor role mapping', () => {
    expect(inferTimelineEventRole({ userText: 'Alice is the owner.' })).toBeNull();
    expect(inferTimelineEventRole({ userText: 'Bob is the blocker.' })).toBeNull();
  });

  it('maps owner or blocker wording only when the actor role is clear', () => {
    expect(
      inferTimelineEventRole({
        userText: 'Alice owns the work and will handle the migration.',
        actorHints: ['Alice'],
      })
    ).toBe('implementer');
    expect(
      inferTimelineEventRole({
        userText: 'Alice is blocked waiting for the migration window.',
        actorHints: ['Alice'],
      })
    ).toBe('affected');
  });

  it('never returns non-enum role labels', () => {
    const values = [
      inferTimelineEventRole({ userText: 'Alice is the owner.' }),
      inferTimelineEventRole({ userText: 'Bob is the blocker.' }),
      inferTimelineEventRole({ userText: 'Merged source was retained.' }),
      inferTimelineEventRole({ userText: '', assistantText: 'I fixed the broken tests.' }),
    ];

    expect(values).not.toContain('owner');
    expect(values).not.toContain('blocker');
    expect(values).not.toContain('merged_source');

    const allowed = new Set<InferredCaseRole>([
      'requester',
      'implementer',
      'reviewer',
      'observer',
      'affected',
    ]);
    for (const value of values) {
      expect(value === null || allowed.has(value)).toBe(true);
    }
  });
});
