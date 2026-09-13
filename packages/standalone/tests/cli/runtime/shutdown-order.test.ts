import { describe, expect, it } from 'vitest';

import { closeRuntimeDataStores } from '../../../src/cli/runtime/shutdown.js';

describe('TG-05/TG-06: graceful shutdown ordering', () => {
  it('closes every runtime data store in order', async () => {
    const events: string[] = [];

    await closeRuntimeDataStores({
      sessionStore: { close: () => events.push('session:closed') },
      metricsCleanup: { stop: () => events.push('metrics-cleanup:stopped') },
      metricsStore: { close: () => events.push('metrics:closed') },
      db: { close: () => events.push('db:closed') },
    } as Parameters<typeof closeRuntimeDataStores>[0]);

    expect(events).toEqual([
      'session:closed',
      'metrics-cleanup:stopped',
      'metrics:closed',
      'db:closed',
    ]);
  });

  it('TG-05/TG-06 closes every data store when one close throws', async () => {
    const events: string[] = [];
    const closeError = new Error('session close failed');

    const closing = closeRuntimeDataStores({
      sessionStore: {
        close: () => {
          events.push('session:failed');
          throw closeError;
        },
      },
      metricsCleanup: { stop: () => events.push('metrics-cleanup:stopped') },
      metricsStore: { close: () => events.push('metrics:closed') },
      db: { close: () => events.push('db:closed') },
    } as Parameters<typeof closeRuntimeDataStores>[0]);

    await expect(closing).rejects.toMatchObject({
      errors: [closeError],
    });
    expect(events).toEqual([
      'session:failed',
      'metrics-cleanup:stopped',
      'metrics:closed',
      'db:closed',
    ]);
  });
});
