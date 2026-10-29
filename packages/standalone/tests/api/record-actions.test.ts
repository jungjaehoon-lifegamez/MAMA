import { describe, expect, it } from 'vitest';
import { workNoUpdateActionRegistrations } from '../../src/api/record-actions.js';

const exec = async (input: Record<string, unknown>) =>
  workNoUpdateActionRegistrations()[0]!.exec(input as never, {} as never);

describe('work.no_update', () => {
  it('names the observations, the work items, or both, and refuses naming neither', async () => {
    await expect(exec({ reason: 'greetings only', observationRefs: ['obs-1'] })).resolves.toEqual({
      recorded: false,
      reason: 'greetings only',
    });
    await expect(
      exec({ reason: 'its summary is current', commitmentIds: ['commitment-1'] })
    ).resolves.toMatchObject({ recorded: false });
    await expect(
      exec({ reason: 'both', observationRefs: ['obs-1'], commitmentIds: ['c-1'] })
    ).resolves.toMatchObject({
      recorded: false,
    });
    await expect(exec({ reason: 'nothing named' })).rejects.toThrow(
      /observationRefs.*commitmentIds/
    );
    await expect(exec({ reason: 'blank id', commitmentIds: [' '] })).rejects.toThrow(
      /commitmentIds/
    );
  });
});
