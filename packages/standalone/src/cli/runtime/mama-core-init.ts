/**
 * MAMA Core API initialization.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 *
 * Responsibilities:
 *   1. Dynamically require mama-core (initDB, getAdapter, mamaCore)
 *   2. Wire up connectorExtractionFn via PersistentClaudeProcess (lazy-init + lifecycle)
 *   3. Normalize the MAMA API shape into mamaApi
 *   4. Build search() / searchForContext() wrapper functions with fallback handling
 *   5. Build loadCheckpointForContext / listDecisionsForContext wrappers
 *   6. Assemble and return the mamaApiClient object
 */

import type { MAMAConfig } from '../config/types.js';
import { expandPath } from '../config/config-manager.js';
import type {
  Checkpoint,
  Decision,
  MamaApiClient,
  SearchResult,
} from '../../gateways/context-injector.js';
import type { MAMAApiShape } from './types.js';

/**
 * Result returned by initMamaCore.
 */
export interface MamaCoreInitResult {
  mamaApi: MAMAApiShape;
  mamaApiClient: MamaApiClient;
  connectorExtractionFn: ((prompt: string) => Promise<string>) | null;
}

/**
 * Initialize the MAMA Core API.
 *
 * Reads `config.database.path`, boots the mama-core DB, sets up the
 * connector extraction process (if supported), normalises the API shape,
 * and returns the three values that the rest of runAgentLoop() consumes.
 */
export async function initMamaCore(config: MAMAConfig): Promise<MamaCoreInitResult> {
  // Initialize message router with MAMA database
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { initDB, getAdapter } = require('@jungjaehoon/mama-core/db-manager');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mamaCore = require('@jungjaehoon/mama-core');

  // Suppress unused variable warning — getAdapter may be used by mama-core internally
  void getAdapter;

  // Connector extraction function — set when Claude CLI extraction process is ready
  let connectorExtractionFn: ((prompt: string) => Promise<string>) | null = null;

  // Set extraction backend to Claude CLI persistent session (no API key needed)
  if (mamaCore.setExtractionFn) {
    const { PersistentClaudeProcess } = await import('../../agent/persistent-cli-process.js');
    const { parseExtractionResponse } = mamaCore;
    let extractionProcess: InstanceType<typeof PersistentClaudeProcess> | null = null;
    let extractionInitPromise: Promise<InstanceType<typeof PersistentClaudeProcess>> | null = null;
    let extractionInitLock = false;

    const getExtractionProcess = async (): Promise<
      InstanceType<typeof PersistentClaudeProcess>
    > => {
      if (extractionProcess) return extractionProcess;
      if (extractionInitPromise) return extractionInitPromise;
      if (extractionInitLock) {
        // Another call is between attempts; wait a tick and retry
        await new Promise((r) => setTimeout(r, 50));
        return getExtractionProcess();
      }
      extractionInitLock = true;
      extractionInitPromise = (async () => {
        const proc = new PersistentClaudeProcess({
          sessionId: `${crypto.randomUUID()}`,
          model: 'sonnet',
          systemPrompt:
            'You are a memory extraction assistant. Extract structured memory units from conversations.',
          dangerouslySkipPermissions: true,
        });
        await proc.start();
        extractionProcess = proc;
        return proc;
      })();
      try {
        return await extractionInitPromise;
      } catch (err) {
        extractionProcess = null;
        extractionInitPromise = null;
        throw err;
      } finally {
        extractionInitLock = false;
      }
    };

    // Cleanup extraction process on exit
    const cleanupExtraction = () => {
      if (extractionProcess) {
        try {
          extractionProcess.stop?.();
        } catch {
          /* best-effort */
        }
        extractionProcess = null;
        extractionInitPromise = null;
      }
    };
    process.on('exit', cleanupExtraction);
    process.on('SIGINT', cleanupExtraction);
    process.on('SIGTERM', cleanupExtraction);

    mamaCore.setExtractionFn(async (prompt: string) => {
      const proc = await getExtractionProcess();
      const result = await proc.sendMessage(prompt);
      return parseExtractionResponse(result.response);
    });

    // Expose extraction for connector pipeline
    connectorExtractionFn = async (prompt: string): Promise<string> => {
      const proc = await getExtractionProcess();
      const result = await proc.sendMessage(prompt);
      return result.response;
    };
  }

  const mamaApi = (
    mamaCore && typeof mamaCore === 'object' && 'mama' in mamaCore ? mamaCore.mama : mamaCore
  ) as MAMAApiShape;

  const suggest = (mamaApi.suggest ?? mamaApi.search) as
    | ((query: string, options?: { limit?: number }) => Promise<unknown>)
    | ((query: string, limit?: number) => Promise<unknown>)
    | undefined;
  const loadCheckpoint = mamaApi.loadCheckpoint;
  const listDecisions = mamaApi.list ?? mamaApi.listDecisions;
  if (!suggest) {
    throw new Error('MAMA API shape is incompatible; failed to initialize memory helpers');
  }

  // Set isolated DB path for MAMA OS (kagemusha pattern: process.env before initDB)
  const mamaDbPathForCore = expandPath(config.database.path);
  process.env.MAMA_DB_PATH = mamaDbPathForCore;

  // Initialize MAMA database first
  await initDB();

  console.log('✓ MAMA memory API available (loaded directly in auto-recall)');

  const search = async (query: string, limit?: number): Promise<unknown> => {
    if (!suggest) {
      throw new Error('MAMA search/suggest API is unavailable');
    }

    try {
      return await (suggest as (q: string, options?: { limit?: number }) => Promise<unknown>)(
        query,
        limit !== undefined ? { limit } : undefined
      );
    } catch (error) {
      const shouldFallback = error instanceof TypeError && /object/i.test(error.message);
      if (!shouldFallback) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      return await (suggest as (q: string, limit?: number) => Promise<unknown>)(query, limit);
    }
  };

  const searchForContext = async (query: string, limit?: number): Promise<SearchResult[]> => {
    const result = await search(query, limit);

    if (!result) {
      return [];
    }

    if (Array.isArray(result)) {
      return result as SearchResult[];
    }

    const wrapped = result as { results?: unknown };
    if (wrapped.results && Array.isArray(wrapped.results)) {
      return wrapped.results as SearchResult[];
    }

    return [];
  };

  const loadCheckpointForContext =
    loadCheckpoint !== undefined
      ? async (): Promise<Checkpoint | null> => {
          const result = await loadCheckpoint();
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            return null;
          }

          const checkpointRow = result as {
            id?: unknown;
            timestamp?: unknown;
            summary?: unknown;
            next_steps?: unknown;
            open_files?: unknown;
          };

          if (
            typeof checkpointRow.timestamp !== 'number' &&
            typeof checkpointRow.timestamp !== 'string'
          ) {
            return null;
          }

          const timestamp =
            typeof checkpointRow.timestamp === 'number'
              ? checkpointRow.timestamp
              : Date.parse(checkpointRow.timestamp);
          if (!Number.isFinite(timestamp)) {
            return null;
          }

          const parsedOpenFiles = Array.isArray(checkpointRow.open_files)
            ? checkpointRow.open_files.filter((item): item is string => typeof item === 'string')
            : [];

          return {
            id:
              typeof checkpointRow.id === 'number'
                ? checkpointRow.id
                : Number.isFinite(Number(checkpointRow.id))
                  ? Number(checkpointRow.id)
                  : 0,
            timestamp,
            summary: typeof checkpointRow.summary === 'string' ? checkpointRow.summary : '',
            next_steps:
              typeof checkpointRow.next_steps === 'string' ? checkpointRow.next_steps : undefined,
            open_files: parsedOpenFiles,
          };
        }
      : undefined;

  const listDecisionsForContext =
    listDecisions !== undefined
      ? async (options?: { limit?: number }): Promise<Decision[]> => {
          const result = await listDecisions(options);
          if (!Array.isArray(result)) {
            return [];
          }

          return result as Decision[];
        }
      : undefined;

  // Create MAMA API client for context injection
  // Provides both SessionStart (checkpoint + recent decisions) and UserPromptSubmit (related decisions) functionality
  const mamaApiClient: MamaApiClient = {
    search: searchForContext, // mama-core exports 'suggest' for semantic search
    loadCheckpoint: loadCheckpointForContext,
    listDecisions: listDecisionsForContext,
    save: mamaApi.save,
    recallMemory: mamaApi.recallMemory as MamaApiClient['recallMemory'],
    ingestMemory: mamaApi.ingestMemory as MamaApiClient['ingestMemory'],
    buildMemoryBootstrap: mamaApi.buildMemoryBootstrap as MamaApiClient['buildMemoryBootstrap'],
    getChannelSummary: mamaApi.getChannelSummary as MamaApiClient['getChannelSummary'],
    upsertChannelSummary: mamaApi.upsertChannelSummary as MamaApiClient['upsertChannelSummary'],
  };

  return {
    mamaApi,
    mamaApiClient,
    connectorExtractionFn,
  };
}
