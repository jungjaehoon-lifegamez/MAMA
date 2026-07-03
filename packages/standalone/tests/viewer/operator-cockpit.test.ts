import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, post } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../public/viewer/src/utils/api.js', () => ({
  API: { get, post },
}));

describe('viewer operator cockpit module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe('OperatorCockpitController.fetchReviewBatch', () => {
    it('reads preview and migration dry-run data from existing vNext ingress endpoints', async () => {
      get
        .mockResolvedValueOnce({
          ok: true,
          mode: 'dry_run',
          preview: {
            cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
            connector: 'slack',
            channel: 'C_PUBLIC_SYNTHETIC',
            advancedThroughSeq: 0,
            events: [],
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          mode: 'dry_run',
          dry_run: {
            status: 'idle',
            candidates: [],
            candidateCount: 0,
            advancedThroughSeq: 0,
          },
        });

      const { OperatorCockpitController } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');
      const controller = new OperatorCockpitController();
      const result = await controller.fetchReviewBatch({
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        limit: 10,
      });

      expect(get).toHaveBeenNthCalledWith(1, '/api/vnext/ingress/preview', {
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        limit: 10,
      });
      expect(get).toHaveBeenNthCalledWith(2, '/api/vnext/ingress/migration-dry-run', {
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        limit: 10,
      });
      expect(result.preview.preview.cursorName).toBe('connector:slack:channel:C_PUBLIC_SYNTHETIC');
      expect(result.dryRun.dry_run.status).toBe('idle');
    });
  });

  describe('buildOperatorReviewState', () => {
    it('renders only review-safe event fields', async () => {
      const { buildOperatorReviewState } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      const state = buildOperatorReviewState({
        preview: {
          ok: true,
          mode: 'dry_run',
          preview: {
            cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
            connector: 'slack',
            channel: 'C_PUBLIC_SYNTHETIC',
            advancedThroughSeq: 7,
            events: [
              {
                seq: 8,
                eventIndexId: 'raw_synthetic_8',
                sourceTimestampMs: 1710000001000,
                sourceId: 'msg-8',
                channel: 'C_PUBLIC_SYNTHETIC',
                sourceRef: {
                  kind: 'raw',
                  connector: 'slack',
                  id: 'raw_synthetic_8',
                  source_id: 'msg-8',
                  channel_id: 'C_PUBLIC_SYNTHETIC',
                },
                content: 'RAW_BODY_SHOULD_NOT_RENDER',
                author: 'synthetic-user',
                source_locator: 'LOCAL_PATH_SHOULD_NOT_RENDER',
                provider_internal: { request_id: 'PROVIDER_REQUEST_SHOULD_NOT_RENDER' },
              },
            ],
          },
        },
        dryRun: {
          ok: true,
          mode: 'dry_run',
          dry_run: {
            mode: 'dry_run',
            status: 'ready',
            cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
            connector: 'slack',
            channel: 'C_PUBLIC_SYNTHETIC',
            advancedThroughSeq: 7,
            candidateCount: 1,
            highestCandidateSeq: 8,
            requiresOperatorDecision: true,
            durableWrites: { commits: 0, cursors: 0, noUpdates: 0 },
            candidates: [
              {
                seq: 8,
                eventIndexId: 'raw_synthetic_8',
                sourceRef: {
                  kind: 'raw',
                  connector: 'slack',
                  id: 'raw_synthetic_8',
                  source_id: 'msg-8',
                  channel_id: 'C_PUBLIC_SYNTHETIC',
                },
                readiness: 'requires_decision',
              },
            ],
          },
        },
      });

      expect(state.cursor.cursorName).toBe('connector:slack:channel:C_PUBLIC_SYNTHETIC');
      expect(state.cursor.advancedThroughSeq).toBe(7);
      expect(state.events).toEqual([
        {
          seq: 8,
          eventIndexId: 'raw_synthetic_8',
          sourceRefText: 'raw:slack:raw_synthetic_8',
          sourceId: 'msg-8',
          channel: 'C_PUBLIC_SYNTHETIC',
          sourceTimestampMs: 1710000001000,
          readiness: 'requires_decision',
        },
      ]);
      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain('RAW_BODY_SHOULD_NOT_RENDER');
      expect(serialized).not.toContain('LOCAL_PATH_SHOULD_NOT_RENDER');
      expect(serialized).not.toContain('PROVIDER_REQUEST_SHOULD_NOT_RENDER');
    });

    it('uses safe defaults for missing optional review fields', async () => {
      const { buildOperatorReviewState } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      const malformedBatch = {
        preview: {
          ok: true,
          mode: 'dry_run',
          preview: {
            cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
            connector: 'slack',
            channel: 'C_PUBLIC_SYNTHETIC',
            advancedThroughSeq: 7,
            events: [
              {
                seq: 8,
                eventIndexId: 'raw_synthetic_8',
                sourceTimestampMs: 1710000001000,
                sourceId: 'msg-8',
                channel: 'C_PUBLIC_SYNTHETIC',
              },
            ],
          },
        },
        dryRun: {
          ok: true,
          mode: 'dry_run',
          dry_run: {
            status: 'ready',
            candidateCount: 1,
          },
        },
      } as unknown as Parameters<typeof buildOperatorReviewState>[0];

      const state = buildOperatorReviewState(malformedBatch);

      expect(state.cursor.status).toBe('ready');
      expect(state.cursor.candidateCount).toBe(1);
      expect(state.events[0].sourceRefText).toBe('raw:unknown:unknown');
      expect(state.events[0].readiness).toBe('requires_decision');
    });

    it('throws an explicit error when an event timestamp is missing', async () => {
      const { buildOperatorReviewState } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      const malformedBatch = {
        preview: {
          ok: true,
          mode: 'dry_run',
          preview: {
            cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
            connector: 'slack',
            channel: 'C_PUBLIC_SYNTHETIC',
            advancedThroughSeq: 7,
            events: [
              {
                seq: 8,
                eventIndexId: 'raw_synthetic_8',
                sourceId: 'msg-8',
                channel: 'C_PUBLIC_SYNTHETIC',
                sourceRef: { kind: 'raw', connector: 'slack', id: 'raw_synthetic_8' },
              },
            ],
          },
        },
        dryRun: {
          ok: true,
          mode: 'dry_run',
          dry_run: {
            status: 'ready',
            candidateCount: 1,
            candidates: [],
          },
        },
      } as unknown as Parameters<typeof buildOperatorReviewState>[0];

      expect(() => buildOperatorReviewState(malformedBatch)).toThrow(
        'sourceTimestampMs is required'
      );
    });
  });

  describe('buildCommitResultState', () => {
    it('allowlists commit response fields before rendering', async () => {
      const { buildCommitResultState } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      const state = buildCommitResultState({
        ok: true,
        mode: 'manual_memory_commit',
        status: 'committed',
        cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        requestedCount: 1,
        processed: 1,
        advancedThroughSeq: 8,
        firstSeq: 8,
        lastSeq: 8,
        memoriesSaved: 1,
        commits: [{ seq: 8, status: 'changed', outcome: 'committed', cursorAdvanced: true }],
        memoryIds: ['MEMORY_ID_SHOULD_NOT_RENDER'],
        localPath: 'LOCAL_PATH_SHOULD_NOT_RENDER',
        providerResponse: { request_id: 'PROVIDER_REQUEST_SHOULD_NOT_RENDER' },
      });

      expect(state).toEqual({
        ok: true,
        mode: 'manual_memory_commit',
        status: 'committed',
        cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        requestedCount: 1,
        processed: 1,
        advancedThroughSeq: 8,
        firstSeq: 8,
        lastSeq: 8,
        pagesStored: null,
        memoriesSaved: 1,
        commits: [{ seq: 8, status: 'changed', outcome: 'committed', cursorAdvanced: true }],
      });
      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain('MEMORY_ID_SHOULD_NOT_RENDER');
      expect(serialized).not.toContain('LOCAL_PATH_SHOULD_NOT_RENDER');
      expect(serialized).not.toContain('PROVIDER_REQUEST_SHOULD_NOT_RENDER');
    });
  });

  describe('rendering', () => {
    it('renders generic request errors without backend internals', async () => {
      const { renderOperatorError } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const html = renderOperatorError('Operator request failed.', {
        message: 'LOCAL_PATH_SHOULD_NOT_RENDER',
      });

      expect(html).toContain('Operator request failed.');
      expect(html).not.toContain('LOCAL_PATH_SHOULD_NOT_RENDER');
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it('renders the cockpit shell with synthetic defaults', async () => {
      const { renderOperatorCockpitShell } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      const html = renderOperatorCockpitShell();

      expect(html).toContain('id="operator-cockpit-form"');
      expect(html).toContain('value="slack"');
      expect(html).toContain('value="C_PUBLIC_SYNTHETIC"');
      expect(html).toContain('name="admin-token"');
      expect(html).toContain('type="password"');
      expect(html).toContain('id="operator-cockpit-batch"');
      expect(html).toContain('id="operator-cockpit-result"');
    });

    it('renders cockpit review rows without raw connector payloads', async () => {
      const { renderOperatorReviewState } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      const html = renderOperatorReviewState({
        cursor: {
          cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          advancedThroughSeq: 7,
          status: 'ready',
          candidateCount: 1,
        },
        events: [
          {
            seq: 8,
            eventIndexId: 'raw_synthetic_8',
            sourceRefText: 'raw:slack:raw_synthetic_8',
            sourceId: 'msg-8',
            channel: 'C_PUBLIC_SYNTHETIC',
            sourceTimestampMs: 1710000001000,
            readiness: 'requires_decision',
          },
        ],
      });

      expect(html).toContain('connector:slack:channel:C_PUBLIC_SYNTHETIC');
      expect(html).toContain('raw:slack:raw_synthetic_8');
      expect(html).toContain('requires_decision');
      expect(html).toContain('data-action="no_update"');
      expect(html).toContain('data-action="wiki"');
      expect(html).toContain('data-action="memory"');
      expect(html).not.toContain('RAW_BODY_SHOULD_NOT_RENDER');
      expect(html).not.toContain('LOCAL_PATH_SHOULD_NOT_RENDER');
      expect(html).not.toContain('PROVIDER_REQUEST_SHOULD_NOT_RENDER');
    });

    it('renders commit results from the allowlisted state only', async () => {
      const { renderCommitResultState } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      const html = renderCommitResultState({
        ok: true,
        mode: 'manual_memory_commit',
        status: 'committed',
        cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        requestedCount: 1,
        processed: 1,
        advancedThroughSeq: 8,
        firstSeq: 8,
        lastSeq: 8,
        pagesStored: null,
        memoriesSaved: 1,
        commits: [{ seq: 8, status: 'changed', outcome: 'committed', cursorAdvanced: true }],
      });

      expect(html).toContain('manual_memory_commit');
      expect(html).toContain('committed');
      expect(html).toContain('8');
      expect(html).not.toContain('MEMORY_ID_SHOULD_NOT_RENDER');
      expect(html).not.toContain('LOCAL_PATH_SHOULD_NOT_RENDER');
      expect(html).not.toContain('PROVIDER_REQUEST_SHOULD_NOT_RENDER');
    });
  });

  describe('manual commit actions', () => {
    it('posts decisions to the existing primary-operator endpoints with admin auth', async () => {
      post.mockResolvedValue({ ok: true, status: 'committed' });
      const { OperatorCockpitController } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');
      const controller = new OperatorCockpitController();
      const adminAuth = { adminToken: 'ADMIN_BEARER_VALUE' };

      await controller.commitNoUpdate(
        {
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 7,
          event_index_ids: ['raw_synthetic_8'],
        },
        adminAuth
      );
      await controller.commitWiki(
        {
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 8,
          event_pages: [],
        },
        adminAuth
      );
      await controller.commitMemory(
        {
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 9,
          event_memories: [],
        },
        adminAuth
      );

      const expectedOptions = { headers: { Authorization: 'Bearer ADMIN_BEARER_VALUE' } };
      expect(post).toHaveBeenNthCalledWith(
        1,
        '/api/vnext/ingress/manual-no-update-commit',
        {
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 7,
          event_index_ids: ['raw_synthetic_8'],
        },
        expectedOptions
      );
      expect(post).toHaveBeenNthCalledWith(
        2,
        '/api/vnext/ingress/manual-wiki-commit',
        {
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 8,
          event_pages: [],
        },
        expectedOptions
      );
      expect(post).toHaveBeenNthCalledWith(
        3,
        '/api/vnext/ingress/manual-memory-commit',
        {
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 9,
          event_memories: [],
        },
        expectedOptions
      );
    });

    it('rejects manual commit calls without an explicit admin token', async () => {
      const { OperatorCockpitController } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');
      const controller = new OperatorCockpitController();

      await expect(
        controller.commitNoUpdate(
          {
            connector: 'slack',
            channel: 'C_PUBLIC_SYNTHETIC',
            expected_advanced_through_seq: 7,
            event_index_ids: ['raw_synthetic_8'],
          },
          { adminToken: '   ' }
        )
      ).rejects.toThrow('Admin token is required');
      expect(post).not.toHaveBeenCalled();
    });

    it('derives memory scopes from the active connector channel', async () => {
      const { buildOperatorMemoryScopes } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      expect(buildOperatorMemoryScopes('discord', 'G_PUBLIC')).toEqual([
        { kind: 'channel', id: 'discord:G_PUBLIC' },
      ]);
      expect(JSON.stringify(buildOperatorMemoryScopes('discord', 'G_PUBLIC'))).not.toContain(
        'project_public_synthetic'
      );
    });

    it('clamps review limit input to its visible max bound', async () => {
      const { OperatorCockpitModule } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      class FakeInput {
        constructor(
          readonly value: string,
          readonly max = ''
        ) {}
      }
      vi.stubGlobal('HTMLInputElement', FakeInput);
      vi.stubGlobal('HTMLTextAreaElement', FakeInput);

      const container = {
        querySelector: vi.fn((selector: string) => {
          if (selector === 'input[name="connector"]') {
            return new FakeInput('discord');
          }
          if (selector === 'input[name="channel"]') {
            return new FakeInput('G_PUBLIC');
          }
          if (selector === 'input[name="limit"]') {
            return new FakeInput('10000', '100');
          }
          return null;
        }),
      };
      const module = new OperatorCockpitModule();
      Reflect.set(module, 'container', container);
      const readScope = Reflect.get(module, 'readScope') as () => {
        connector: string;
        channel: string;
        limit?: number;
      };

      expect(readScope.call(module)).toEqual({
        connector: 'discord',
        channel: 'G_PUBLIC',
        limit: 100,
      });
    });

    it('blocks duplicate commits while the same row is already committing', async () => {
      const { OperatorCockpitModule } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      class FakeHTMLElement {
        innerHTML = '';
      }
      class FakeInput {
        constructor(readonly value: string) {}
      }
      class FakeButton extends FakeHTMLElement {
        disabled = false;
      }
      const firstButton = new FakeButton();
      const secondButton = new FakeButton();
      const row = {
        querySelectorAll: vi.fn(() => [firstButton, secondButton]),
      };
      const resultSlot = new FakeHTMLElement();
      const container = {
        querySelector: vi.fn((selector: string) => {
          if (selector === '#operator-cockpit-result') {
            return resultSlot;
          }
          if (selector === 'input[name="admin-token"]') {
            return new FakeInput('ADMIN_BEARER_VALUE');
          }
          return null;
        }),
      };
      let resolveCommit: (value: { ok: boolean; status: string }) => void = () => {};
      const pendingCommit = new Promise<{ ok: boolean; status: string }>((resolve) => {
        resolveCommit = resolve;
      });
      const controller = {
        commitNoUpdate: vi.fn(() => pendingCommit),
      };

      vi.stubGlobal('HTMLElement', FakeHTMLElement);
      vi.stubGlobal('HTMLButtonElement', FakeButton);
      vi.stubGlobal('HTMLInputElement', FakeInput);
      vi.stubGlobal('HTMLTextAreaElement', FakeInput);

      const module = new OperatorCockpitModule(
        controller as unknown as ConstructorParameters<typeof OperatorCockpitModule>[0]
      );
      Reflect.set(module, 'container', container);
      Reflect.set(module, 'currentState', {
        cursor: {
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          advancedThroughSeq: 7,
        },
        events: [],
      });
      Reflect.set(module, 'loadBatch', vi.fn().mockResolvedValue(undefined));
      const commitEvent = Reflect.get(module, 'commitEvent') as (
        action: string,
        eventIndexId: string,
        row: Element | null,
        trigger?: HTMLElement
      ) => Promise<void>;

      const firstCommit = commitEvent.call(
        module,
        'no_update',
        'raw_synthetic_8',
        row as unknown as Element,
        firstButton as unknown as HTMLElement
      );
      await commitEvent.call(
        module,
        'no_update',
        'raw_synthetic_8',
        row as unknown as Element,
        secondButton as unknown as HTMLElement
      );

      expect(controller.commitNoUpdate).toHaveBeenCalledTimes(1);
      expect(firstButton.disabled).toBe(true);
      expect(secondButton.disabled).toBe(true);

      resolveCommit({ ok: true, status: 'committed' });
      await firstCommit;

      expect(firstButton.disabled).toBe(false);
      expect(secondButton.disabled).toBe(false);
    });

    it('does not fall back to document inputs when the event row is missing', async () => {
      const { OperatorCockpitModule } =
        await import('../../public/viewer/src/modules/operator-cockpit.js');

      class FakeHTMLElement {
        innerHTML = '';
      }
      class FakeInput {
        constructor(readonly value: string) {}
      }
      class FakeTextArea extends FakeInput {}

      const documentRoot = {
        querySelector: vi.fn((selector: string) => {
          if (selector === '[data-field="wiki-path"]') {
            return new FakeInput('WRONG_FIRST_ROW_PATH');
          }
          if (selector === '[data-field="wiki-title"]') {
            return new FakeInput('WRONG_FIRST_ROW_TITLE');
          }
          if (selector === '[data-field="wiki-content"]') {
            return new FakeTextArea('WRONG_FIRST_ROW_CONTENT');
          }
          return null;
        }),
      };
      const resultSlot = new FakeHTMLElement();
      const container = {
        querySelector: vi.fn((selector: string) =>
          selector === '#operator-cockpit-result' ? resultSlot : null
        ),
      };
      const controller = {
        commitWiki: vi.fn().mockResolvedValue({ ok: true, status: 'committed' }),
      };
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('document', documentRoot);
      vi.stubGlobal('HTMLElement', FakeHTMLElement);
      vi.stubGlobal('HTMLInputElement', FakeInput);
      vi.stubGlobal('HTMLTextAreaElement', FakeTextArea);

      const module = new OperatorCockpitModule(
        controller as unknown as ConstructorParameters<typeof OperatorCockpitModule>[0]
      );
      Reflect.set(module, 'container', container);
      Reflect.set(module, 'currentState', {
        cursor: {
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          advancedThroughSeq: 7,
        },
        events: [],
      });
      const commitEvent = Reflect.get(module, 'commitEvent') as (
        action: string,
        eventIndexId: string,
        row: Element | null,
        trigger?: HTMLElement
      ) => Promise<void>;

      await commitEvent.call(module, 'wiki', 'raw_synthetic_8', null);

      expect(controller.commitWiki).not.toHaveBeenCalled();
      expect(documentRoot.querySelector).not.toHaveBeenCalled();
      expect(resultSlot.innerHTML).toContain('Operator commit failed.');
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe('service worker cache', () => {
    it('caches the operator cockpit module behind a bumped cache version', () => {
      const sw = readFileSync(new URL('../../public/viewer/sw.js', import.meta.url), 'utf8');

      expect(sw).toContain("const CACHE_NAME = 'mama-mobile-v1.6.1'");
      expect(sw).toContain("'/viewer/js/modules/operator-cockpit.js'");
    });
  });
});
