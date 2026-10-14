import { isErasedRecord, type ActionContext, type MemoryScopeRef } from '@jungjaehoon/mama-core';
import type { MemoryReadAllowance } from '@jungjaehoon/mama-core/api/catalog';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import { getObservationVersion, readObservationVersion } from '@jungjaehoon/mama-core/knowledge';
import type { RawStore } from '../storage/source-archive.js';
import { listRaw, searchRaw } from '../connectors/framework/raw-query.js';
import {
  hasStoredConnector,
  storedConnectorOverview,
  storedObservationChannel,
} from '../connectors/framework/stored-index-read.js';

type Access = ActionContext['access'];

const MAX_BATCH_SOURCE_REFS = 500;

export interface StoredSourceReaderOptions {
  adapter: DatabaseAdapter;
  rawStore?: () => Pick<RawStore, 'readVersion'> | null;
}

export interface StoredSourceReader {
  has(source: string): boolean;
  overview(
    source: string,
    access: Access,
    allowance?: Pick<MemoryReadAllowance, 'maxSourceMs'>
  ): Record<string, unknown>;
  search(
    source: string,
    input: Record<string, unknown>,
    access: Access,
    allowance?: Pick<MemoryReadAllowance, 'maxSourceMs'>
  ): Record<string, unknown>;
  read(
    source: string,
    input: Record<string, unknown>,
    access: Access,
    allowance?: Pick<MemoryReadAllowance, 'maxSourceMs'>
  ): Record<string, unknown>;
  readObservation(
    observationRef: string,
    access: Access,
    allowance?: Pick<MemoryReadAllowance, 'maxSourceMs'>,
    window?: Partial<Pick<Record<string, unknown>, 'content_offset' | 'content_limit'>>
  ): Record<string, unknown>;
}

function denied(): Error {
  const error = new Error('Stored source requires a granted connector and channel scope');
  error.name = 'stored_source_out_of_scope';
  return error;
}

function missing(): Error {
  const error = new Error('No stored observation exists for this source and reference');
  error.name = 'stored_source_not_found';
  return error;
}

function erasedObservation(access: Access, scopes: readonly MemoryScopeRef[]): Error {
  // Erasure removes the source identity. A caller-supplied source cannot establish a wide grant;
  // only the surviving bindings can admit this tombstone.
  if (
    !scopes.some((scope) =>
      [...access.scopes, ...(access.readScopes ?? [])].some(
        (allowed) => allowed.kind === scope.kind && allowed.id === scope.id
      )
    )
  )
    throw denied();
  return new Error('observation_erased');
}

function allowedChannels(source: string, access: Access): string[] | null {
  if (!access.connectors?.includes(source)) throw denied();
  if (access.connectorWideRead?.includes(source)) return null;
  const channels = access.channels?.[source];
  if (!channels || channels.length === 0) throw denied();
  return [...new Set(channels.map((value) => value.trim()).filter(Boolean))];
}

function time(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw new Error(`${field} must be an epoch millisecond or ISO timestamp with timezone`);
}

function pageChannels(
  input: Record<string, unknown>,
  granted: string[] | null
): string[] | undefined {
  const requested = input.channel;
  if (requested !== undefined && (typeof requested !== 'string' || requested.trim() === '')) {
    throw new Error('channel must be nonblank text');
  }
  if (typeof requested === 'string') {
    if (granted && !granted.includes(requested)) throw denied();
    return [requested];
  }
  return granted ?? undefined;
}

function readRefs(input: Record<string, unknown>): { refs: string[]; batched: boolean } {
  if (input.observationRefs !== undefined) {
    if (!Array.isArray(input.observationRefs)) {
      throw new Error('source.read observationRefs must be an array');
    }
    if (input.observationRefs.length < 1 || input.observationRefs.length > MAX_BATCH_SOURCE_REFS) {
      throw new Error(
        `source.read observationRefs must contain 1 to ${MAX_BATCH_SOURCE_REFS} handles`
      );
    }
    if (input.observationRefs.some((value) => typeof value !== 'string' || value.trim() === '')) {
      throw new Error('source.read observationRefs must contain nonblank handles');
    }
    if (input.observationRef !== undefined) {
      throw new Error('source.read accepts observationRef or observationRefs, not both');
    }
    return { refs: input.observationRefs as string[], batched: true };
  }

  const ref = input.observationRef;
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error('source.read stored view requires observationRef');
  }
  return { refs: [ref], batched: false };
}

function readError(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof Error && error.name !== 'Error' ? error.name : 'source_read_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function createStoredSourceReader(options: StoredSourceReaderOptions): StoredSourceReader {
  const { adapter } = options;
  return {
    has: (source) => hasStoredConnector(adapter, source),
    overview(source, access, allowance) {
      const channels = allowedChannels(source, access);
      const row = storedConnectorOverview(adapter, source, channels, allowance?.maxSourceMs);
      return {
        source,
        mode: 'stored',
        count: Number(row.count),
        channelCount: Number(row.channel_count),
        firstSourceAt: row.first_source_at,
        lastSourceAt: row.last_source_at,
        lastObservedAt: row.last_observed_at,
        coverage: {
          complete: false,
          reason: 'Stored observations; upstream coverage may be partial',
        },
      };
    },
    search(source, input, access, allowance) {
      const granted = allowedChannels(source, access);
      const query = input.query === undefined ? '' : input.query;
      if (typeof query !== 'string') throw new Error('query must be text');
      const channels = pageChannels(input, granted);
      const fromMs = time(input.from, 'from');
      const toMs = time(input.to, 'to');
      if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
        throw new Error('from must not be later than to');
      }
      if (
        input.limit !== undefined &&
        (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)
      ) {
        throw new Error('limit must be an integer from 1 to 100');
      }
      if (input.cursor !== undefined && typeof input.cursor !== 'string') {
        throw new Error('cursor must be text');
      }
      const detail = input.detail ?? 'compact';
      if (detail !== 'compact' && detail !== 'full') {
        throw new Error('detail must be compact or full');
      }
      const queryInput = {
        query,
        connectors: [source],
        ...(channels === undefined ? {} : { channels }),
        ...(fromMs === undefined ? {} : { fromMs }),
        ...(toMs === undefined ? {} : { toMs }),
        ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(allowance?.maxSourceMs === undefined ? {} : { maxSourceMs: allowance.maxSourceMs }),
      };
      const result = query.trim() ? searchRaw(adapter, queryInput) : listRaw(adapter, queryInput);
      return {
        source,
        mode: 'stored',
        ...result,
        hits: result.hits.map((hit) =>
          detail === 'full'
            ? {
                ...hit,
                observationRef: hit.raw_id || null,
                nextRead: hit.raw_id
                  ? { source, view: 'stored', observationRef: hit.raw_id }
                  : null,
              }
            : {
                raw_id: hit.raw_id,
                source_id: hit.source_id,
                channel_id: hit.channel_id,
                ...(typeof hit.metadata?.channelName === 'string'
                  ? { channel_name: hit.metadata.channelName }
                  : {}),
                author_label: hit.author_label,
                source_at: hit.source_at,
                observed_at: hit.observed_at,
                content_preview: hit.content_preview,
                score: hit.score,
                observationRef: hit.raw_id || null,
                nextRead: hit.raw_id
                  ? { source, view: 'stored', observationRef: hit.raw_id }
                  : null,
              }
        ),
        coverage: {
          returned: result.hits.length,
          pageComplete: result.next_cursor === null,
        },
      };
    },
    read(source, input, access, allowance) {
      const granted = allowedChannels(source, access);
      const { refs, batched } = readRefs(input);
      const rawStore = options.rawStore?.();

      const readOne = (ref: string): Record<string, unknown> => {
        const stored = getObservationVersion(adapter, ref);
        if (stored && isErasedRecord(stored)) throw erasedObservation(access, stored.scopes);
        const channel = storedObservationChannel(adapter, ref, source, allowance?.maxSourceMs);
        if (channel === undefined) {
          if (access.connectorWideRead?.includes(source)) throw missing();
          throw denied();
        }
        if (granted && (!channel || !granted.includes(channel))) throw denied();
        const result = readObservationVersion(
          adapter,
          ref,
          rawStore
            ? {
                readVersion: ({ connectorName, revisionSourceId, expectedContentHash }) => {
                  const found = rawStore.readVersion(
                    connectorName,
                    revisionSourceId,
                    expectedContentHash
                  );
                  if (found.status === 'available') {
                    if (found.body === undefined || found.contentHash === undefined) {
                      throw new Error('Raw version reader omitted its available body or hash');
                    }
                    return {
                      status: 'available' as const,
                      body: found.body,
                      contentHash: found.contentHash,
                    };
                  }
                  if (found.reason === undefined) {
                    throw new Error('Raw version reader omitted its unavailable reason');
                  }
                  return { status: 'version_unavailable' as const, reason: found.reason };
                },
              }
            : undefined,
          allowance?.maxSourceMs === undefined ? undefined : { maxSourceMs: allowance.maxSourceMs }
        );
        if (isErasedRecord(result)) throw erasedObservation(access, result.scopes);
        if (result.status !== 'available') {
          throw new Error(result.status === 'not_found' ? 'observation_not_found' : result.reason);
        }
        const offset = input.content_offset === undefined ? 0 : Number(input.content_offset);
        const limit = input.content_limit === undefined ? 4_000 : Number(input.content_limit);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 4_000
        ) {
          throw new Error('content_offset/content_limit must be bounded integers');
        }
        const chars = [...result.body];
        const content = chars.slice(offset, offset + limit).join('');
        const observation = result.observation;
        return {
          source,
          mode: 'stored',
          observationRef: observation.observationId,
          sourceId: observation.sourceId,
          sourceAt: observation.sourceAt,
          observedAt: observation.observedAt,
          channel: observation.channel,
          author: observation.author,
          metadata: observation.metadata,
          content,
          contentHash: observation.contentHash,
          complete: offset + limit >= chars.length,
          nextRead:
            offset + limit < chars.length
              ? {
                  source,
                  view: 'stored',
                  observationRef: ref,
                  content_offset: offset + limit,
                  content_limit: limit,
                }
              : null,
        };
      };

      if (!batched) return readOne(refs[0]!);
      return {
        source,
        mode: 'stored',
        results: refs.map((ref) => {
          try {
            return { observationRef: ref, status: 'completed', data: readOne(ref) };
          } catch (error) {
            return { observationRef: ref, status: 'failed', error: readError(error) };
          }
        }),
      };
    },
    readObservation(observationRef, access, allowance, window) {
      if (typeof observationRef !== 'string' || observationRef.trim() === '') {
        throw new Error('observationRef must be nonblank text');
      }
      const stored = getObservationVersion(adapter, observationRef);
      if (stored === null) {
        if (access.connectorWideRead?.length) throw missing();
        throw denied();
      }
      if (isErasedRecord(stored)) throw erasedObservation(access, stored.scopes);
      return this.read(stored.source, { observationRef, ...window }, access, allowance);
    },
  };
}
