/**
 * history-extractor.ts
 *
 * 3-pass Memory Agent history extraction utilities.
 * Pass 0: truth channels → build ground-truth project state (no LLM)
 * Pass 1: activity channels (hub + deliverable + reference) → extract decisions/tasks with full context
 * Pass 2: spoke channels → connect to hub projects
 */

import type { NormalizedItem, ChannelConfig } from '../connectors/framework/types.js';

export interface HubContextEntry {
  project: string;
  workUnit?: string;
  assignedTo?: string;
  status?: string;
}

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

export function buildEntityObservations(
  items: NormalizedItem[],
  options: {
    extractorVersion: string;
    embeddingModelVersion: string | null;
    rawDbRefForSource?: (source: string) => string | null;
  }
): EntityObservationDraft[] {
  const observations: EntityObservationDraft[] = [];

  for (const item of items) {
    const scope = buildObservationScope(item);
    const sourceRawDbRef = options.rawDbRefForSource?.(item.source) ?? null;
    const channelLabel =
      typeof item.metadata?.channelName === 'string'
        ? (item.metadata.channelName as string)
        : item.channel;

    const relatedSurfaceForms = [channelLabel].filter(Boolean);

    if (item.author.trim().length > 0) {
      observations.push({
        id: `obs_${item.sourceId}_author`,
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
 * Format a single NormalizedItem as a prompt line: "author(HH:MM): content"
 */
function formatItemLine(item: NormalizedItem): string {
  const hh = String(item.timestamp.getHours()).padStart(2, '0');
  const mm = String(item.timestamp.getMinutes()).padStart(2, '0');
  return `${item.author}(${hh}:${mm}): ${item.content}`;
}

/**
 * Group items by "${source}:${channel}" key.
 */
export function groupByChannel(items: NormalizedItem[]): Map<string, NormalizedItem[]> {
  const groups = new Map<string, NormalizedItem[]>();
  for (const item of items) {
    const key = `${item.source}:${item.channel}`;
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }
  return groups;
}

/**
 * Build an LLM prompt for activity channel extraction (Pass 1).
 * Includes truth context as a header so the agent can identify changes relative to ground truth.
 *
 * @param activity - Activity NormalizedItems (hub + deliverable + reference)
 * @param truth - Ground-truth project state from Pass 0
 */
export function buildActivityExtractionPrompt(
  activity: NormalizedItem[],
  truth: ProjectTruth
): string {
  let prompt = 'You are a project historian.\n';
  prompt +=
    'IMPORTANT: Write all summary and reasoning fields in the same language as the source messages.\n\n';
  prompt += 'Current project state (from management docs / kanban):\n';

  const truthEntries = Object.entries(truth.projects);
  if (truthEntries.length === 0) {
    prompt += '(none)\n';
  } else {
    for (const [projectName, project] of truthEntries) {
      for (const [workUnit, state] of Object.entries(project.workUnits)) {
        prompt += `- ${projectName}/${workUnit}: ${state.status}`;
        if (state.assigned) prompt += `, assigned: ${state.assigned}`;
        prompt += '\n';
      }
    }
  }

  prompt += '\nBelow is the cross-channel activity for this period.\n';
  prompt += 'Extract changes relative to the ground truth:\n';
  prompt += '- Status changes (in-progress → submitted, etc.)\n';
  prompt += '- Deliverable uploads (file changes)\n';
  prompt += '- Decisions / agreements\n';
  prompt += '- Schedule changes\n';
  prompt += '- Lessons learned / problem-resolution\n\n';
  prompt += 'Ignore casual conversation, greetings, and small talk.\n\n';
  prompt +=
    'Return as a JSON array: [{project, work_unit, kind, topic, summary, reasoning, event_date, confidence}]\n';
  prompt += 'If there is nothing to extract, return an empty array [].\n\n---\n';

  // Add activity items grouped by source:channel
  const grouped = groupByChannel(activity);
  for (const [channel, channelItems] of grouped) {
    prompt += `\n### ${channel}\n`;
    for (const item of channelItems) {
      const time = item.timestamp.toISOString().slice(11, 16);
      prompt += `${item.author}(${time}): ${item.content}\n`;
    }
  }

  return prompt;
}

/**
 * Build an LLM prompt for spoke channel extraction (Pass 2).
 * Includes hub context so the agent can connect spoke messages to known projects.
 * Optionally includes project truth for richer context.
 *
 * @param items - Spoke NormalizedItems
 * @param hubContext - Active project context from Pass 1
 * @param truth - Optional ground-truth project state for richer context
 */
export function buildSpokeExtractionPrompt(
  items: NormalizedItem[],
  hubContext: HubContextEntry[],
  truth?: ProjectTruth
): string {
  const groups = groupByChannel(items);

  const channelSections: string[] = [];
  for (const [channelKey, channelItems] of groups.entries()) {
    const lines = channelItems.map(formatItemLine).join('\n');
    channelSections.push(`### Channel: ${channelKey}\n${lines}`);
  }

  const messagesBlock = channelSections.join('\n\n');

  const hubContextLines = hubContext
    .map((entry) => {
      const parts: string[] = [`- Project: ${entry.project}`];
      if (entry.workUnit) parts.push(`  Work unit: ${entry.workUnit}`);
      if (entry.assignedTo) parts.push(`  Assigned: ${entry.assignedTo}`);
      if (entry.status) parts.push(`  Status: ${entry.status}`);
      return parts.join('\n');
    })
    .join('\n');

  let prompt = `You are a historian.\nIMPORTANT: Write all summary and reasoning fields in the same language as the source messages.\n\n`;

  // Include truth context if provided
  if (truth && Object.keys(truth.projects).length > 0) {
    prompt += 'Project truth state (from management docs / kanban):\n';
    for (const [projectName, project] of Object.entries(truth.projects)) {
      for (const [workUnit, state] of Object.entries(project.workUnits)) {
        prompt += `- ${projectName}/${workUnit}: ${state.status}`;
        if (state.assigned) prompt += `, assigned: ${state.assigned}`;
        prompt += '\n';
      }
    }
    prompt += '\n';
  }

  prompt += `Current active project context:\n${hubContextLines || '(none)'}

Extract important tasks, decisions, lessons, and schedules from the spoke channel messages below.
Where possible, connect them to the hub projects above.
Ignore casual small talk unrelated to hub projects.

Output format: respond with a JSON array only. Output only JSON, no other text.
Schema for each item:
[
  {
    "project": "project name (use the hub context project name if linkable)",
    "work_unit": "work unit or feature name (optional)",
    "assigned_to": "assignee name (optional)",
    "kind": "task | decision | lesson | schedule",
    "topic": "one-line title",
    "summary": "summary (2-3 sentences)",
    "reasoning": "why this item was extracted and evidence linking it to a hub project",
    "event_date": "YYYY-MM-DD format (if a date can be inferred from messages, otherwise null)",
    "confidence": 0.0~1.0
  }
]

Messages:
${messagesBlock}`;

  return prompt;
}
