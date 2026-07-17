/**
 * history-extractor.ts
 *
 * 3-pass Memory Agent history extraction utilities.
 * Pass 0: truth channels → build ground-truth project state (no LLM)
 * Pass 1: activity channels (hub + deliverable + reference) → extract decisions/tasks with full context
 * Pass 2: spoke channels → connect to hub projects
 */

import type { NormalizedItem, ChannelConfig } from '../connectors/framework/types.js';

export interface ClassifiedItems {
  truth: NormalizedItem[]; // role=truth
  activity: NormalizedItem[]; // role=hub + deliverable + reference, sorted by timestamp
  spoke: NormalizedItem[]; // role=spoke
}

export interface ProjectTruth {
  projects: Record<
    string,
    {
      workUnits: Record<
        string,
        {
          status: string;
          assigned?: string;
          column?: string;
          metadata?: Record<string, string>;
        }
      >;
    }
  >;
}

export interface EntityObservationDraft {
  id: string;
  observation_type: 'generic' | 'author' | 'channel';
  entity_kind_hint: 'project' | 'person' | 'organization' | 'work_item' | null;
  surface_form: string;
  normalized_form: string;
  lang: string | null;
  script: string | null;
  context_summary: string | null;
  related_surface_forms: string[];
  timestamp_observed: number | null;
  scope_kind: 'project' | 'channel' | 'user' | 'global';
  scope_id: string | null;
  extractor_version: string;
  embedding_model_version: string | null;
  source_connector: string;
  source_raw_db_ref: string | null;
  source_raw_record_id: string;
}

function detectObservationScript(input: string): EntityObservationDraft['script'] {
  if (/\p{Script=Hangul}/u.test(input)) {
    return 'Hang';
  }
  if (/\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u.test(input)) {
    return 'Jpan';
  }
  if (/\p{Script=Latin}/u.test(input)) {
    return 'Latn';
  }
  return null;
}

function normalizeObservationLabel(input: string): string {
  const collapsed = input.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const script = detectObservationScript(collapsed);
  return script === 'Latn' ? collapsed.toLowerCase() : collapsed;
}

function buildObservationScope(
  item: NormalizedItem
): Pick<EntityObservationDraft, 'scope_kind' | 'scope_id'> {
  const channelId =
    typeof item.metadata?.channelId === 'string' ? (item.metadata.channelId as string) : null;
  if (item.source === 'slack' && channelId) {
    return { scope_kind: 'channel', scope_id: channelId };
  }
  return { scope_kind: 'channel', scope_id: item.channel };
}

function getRawConnectorSource(item: NormalizedItem): string {
  if (typeof item.metadata?.rawConnector === 'string' && item.metadata.rawConnector.length > 0) {
    return item.metadata.rawConnector;
  }
  return item.source;
}

function getStableChannelKey(item: NormalizedItem): string {
  const channelId =
    item.source === 'slack' && typeof item.metadata?.channelId === 'string'
      ? item.metadata.channelId
      : item.channel;
  return `${item.source}:${channelId}`;
}

export function buildEntityObservations(
  items: NormalizedItem[],
  options: {
    extractorVersion: string;
    embeddingModelVersion: string | null;
    rawDbRefForSource?: (source: string, item?: NormalizedItem) => string | null;
  }
): EntityObservationDraft[] {
  const observations: EntityObservationDraft[] = [];

  for (const item of items) {
    const scope = buildObservationScope(item);
    const rawConnector = getRawConnectorSource(item);
    const sourceRawDbRef = options.rawDbRefForSource?.(rawConnector, item) ?? null;
    const channelLabel =
      typeof item.metadata?.channelName === 'string'
        ? (item.metadata.channelName as string)
        : item.channel;

    const relatedSurfaceForms = [channelLabel].filter(Boolean);

    if (item.author.trim().length > 0) {
      observations.push({
        id: `obs_${item.sourceId}_author`,
        observation_type: 'author',
        entity_kind_hint: 'person',
        surface_form: item.author,
        normalized_form: normalizeObservationLabel(item.author),
        lang: null,
        script: detectObservationScript(item.author),
        context_summary: item.content.slice(0, 240),
        related_surface_forms: relatedSurfaceForms,
        timestamp_observed: item.timestamp.getTime(),
        scope_kind: scope.scope_kind,
        scope_id: scope.scope_id,
        extractor_version: options.extractorVersion,
        embedding_model_version: options.embeddingModelVersion,
        source_connector: item.source,
        source_raw_db_ref: sourceRawDbRef,
        source_raw_record_id: item.sourceId,
      });
    }

    if (channelLabel.trim().length > 0) {
      observations.push({
        id: `obs_${item.sourceId}_channel`,
        observation_type: 'channel',
        entity_kind_hint: 'project',
        surface_form: channelLabel,
        normalized_form: normalizeObservationLabel(channelLabel),
        lang: null,
        script: detectObservationScript(channelLabel),
        context_summary: item.content.slice(0, 240),
        related_surface_forms: [item.author].filter(Boolean),
        timestamp_observed: item.timestamp.getTime(),
        scope_kind: scope.scope_kind,
        scope_id: scope.scope_id,
        extractor_version: options.extractorVersion,
        embedding_model_version: options.embeddingModelVersion,
        source_connector: item.source,
        source_raw_db_ref: sourceRawDbRef,
        source_raw_record_id: item.sourceId,
      });
    }
  }

  return observations;
}

/**
 * Classify NormalizedItems into truth, activity, and spoke groups based on channel configs.
 * Items with role 'ignore' or no matching config are dropped.
 * Activity items (hub + deliverable + reference) are sorted by timestamp ascending.
 *
 * @param items - Normalized items to classify
 * @param channelConfigs - Keyed by source (e.g. 'chatwork'), then by channel name
 */
export function classifyItemsByRole(
  items: NormalizedItem[],
  channelConfigs: Record<string, Record<string, ChannelConfig>>,
  defaultRole: ChannelConfig['role'] = 'ignore'
): ClassifiedItems {
  const truth: NormalizedItem[] = [];
  const activity: NormalizedItem[] = [];
  const spoke: NormalizedItem[] = [];

  for (const item of items) {
    const sourceConfigs = channelConfigs[item.source];
    let channelCfg = sourceConfigs?.[item.channel];
    // Fallback: search by name field when direct key lookup fails
    if (!channelCfg && sourceConfigs) {
      for (const cfg of Object.values(sourceConfigs)) {
        if (cfg.name === item.channel) {
          channelCfg = cfg;
          break;
        }
      }
    }
    const role = channelCfg?.role ?? defaultRole;
    if (role === 'ignore') continue;

    if (role === 'truth') {
      truth.push(item);
    } else if (role === 'hub' || role === 'deliverable' || role === 'reference') {
      activity.push(item);
    } else if (role === 'spoke') {
      spoke.push(item);
    }
  }

  // Sort activity items by timestamp ascending
  activity.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return { truth, activity, spoke };
}

/**
 * Build ground-truth project state from truth-role items (Pass 0).
 * No LLM needed — directly parses structured data from kanban_card and spreadsheet_row items.
 *
 * @param truthItems - NormalizedItems with role=truth
 */
export function buildProjectTruth(truthItems: NormalizedItem[]): ProjectTruth {
  const projects: ProjectTruth['projects'] = {};

  for (const item of truthItems) {
    if (!projects[item.channel]) {
      projects[item.channel] = { workUnits: {} };
    }

    if (item.type === 'kanban_card') {
      // Parse from metadata: cardName, listName, prevListName
      const cardName = (item.metadata?.cardName as string) ?? item.sourceId;
      const listName = (item.metadata?.listName as string) ?? 'unknown';
      const assigned = item.metadata?.members as string;
      projects[item.channel].workUnits[cardName] = {
        status: listName,
        column: listName,
        assigned,
      };
    } else if (item.type === 'spreadsheet_row') {
      const headers = (item.metadata?.headers as string[]) ?? [];
      const values = (item.metadata?.values as string[]) ?? [];
      const meta: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i]?.replace(/\n/g, '').trim() ?? '';
        meta[h] = values[i]?.trim() ?? '';
      }
      // Spreadsheet schema example: client, project, name, deadline, Trello (Korean fallback keys retained for user data)
      const client = meta['클라이언트'] ?? meta['client'] ?? '';
      const project = meta['프로젝트'] ?? meta['project'] ?? item.channel;
      const name = meta['명칭'] ?? meta['name'] ?? meta['LIST_NO'] ?? '';
      const deadline = meta['제출기한'] ?? meta['deadline'] ?? meta['Due'] ?? '';
      const trello = meta['Trello'] ?? '';
      const projectKey = client ? `${client}/${project}` : project;
      if (!projects[projectKey]) {
        projects[projectKey] = { workUnits: {} };
      }
      projects[projectKey].workUnits[name || item.sourceId] = {
        status: deadline ? `deadline:${deadline}` : 'active',
        assigned: meta['담당'] ?? meta['담당자'] ?? meta['assigned'],
        metadata: { ...meta, trello },
      };
    }
  }

  return { projects };
}

/**
 * Group items by "${source}:${channel}" key.
 */
export function groupByChannel(items: NormalizedItem[]): Map<string, NormalizedItem[]> {
  const groups = new Map<string, NormalizedItem[]>();
  for (const item of items) {
    const key = getStableChannelKey(item);
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }
  return groups;
}
