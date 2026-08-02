import { describe, expect, it, vi } from 'vitest';

import { closeRuntimeDataStores } from '../../../src/cli/runtime/shutdown.js';

describe('TG-05/TG-06: graceful shutdown ordering', () => {
  it('awaits extraction shutdown before closing any data store', async () => {
    const events: string[] = [];
    let releaseExtraction!: () => void;
    const closing = closeRuntimeDataStores({
      stopExtraction: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            events.push('extraction:start');
            releaseExtraction = () => {
              events.push('extraction:stopped');
              resolve();
            };
          })
      ),
      sessionStore: { close: () => events.push('session:closed') },
      metricsCleanup: { stop: () => events.push('metrics-cleanup:stopped') },
      metricsStore: { close: () => events.push('metrics:closed') },
      db: { close: () => events.push('db:closed') },
    } as Parameters<typeof closeRuntimeDataStores>[0]);

    await Promise.resolve();
    expect(events).toEqual(['extraction:start']);
    releaseExtraction();
    await closing;
    expect(events).toEqual([
      'extraction:start',
      'extraction:stopped',
      'session:closed',
      'metrics-cleanup:stopped',
      'metrics:closed',
      'db:closed',
    ]);
  });

  it('TG-05/TG-06 closes every data store when extraction shutdown rejects', async () => {
    const events: string[] = [];
    const extractionError = new Error('extraction stop failed');

    const closing = closeRuntimeDataStores({
      stopExtraction: vi.fn(async () => {
        events.push('extraction:failed');
        throw extractionError;
      }),
      sessionStore: { close: () => events.push('session:closed') },
      metricsCleanup: { stop: () => events.push('metrics-cleanup:stopped') },
      metricsStore: { close: () => events.push('metrics:closed') },
      db: { close: () => events.push('db:closed') },
    } as Parameters<typeof closeRuntimeDataStores>[0]);

    await expect(closing).rejects.toMatchObject({
      errors: [extractionError],
    });
    expect(events).toEqual([
      'extraction:failed',
      'session:closed',
      'metrics-cleanup:stopped',
      'metrics:closed',
      'db:closed',
    ]);
  });
});
