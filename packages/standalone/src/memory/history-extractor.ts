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
      // Spreadsheet schema example: 클라이언트, 프로젝트, 명칭, 제출기한, Trello
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
        status: deadline ? `납기:${deadline}` : 'active',
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
  let prompt = '당신은 프로젝트 역사가입니다.\n\n';
  prompt += '현재 프로젝트 상태 (관리 문서/칸반 기준):\n';

  const truthEntries = Object.entries(truth.projects);
  if (truthEntries.length === 0) {
    prompt += '(없음)\n';
  } else {
    for (const [projectName, project] of truthEntries) {
      for (const [workUnit, state] of Object.entries(project.workUnits)) {
        prompt += `- ${projectName}/${workUnit}: ${state.status}`;
        if (state.assigned) prompt += `, 담당: ${state.assigned}`;
        prompt += '\n';
      }
    }
  }

  prompt += '\n아래는 이번 기간의 크로스채널 활동입니다.\n';
  prompt += '진실 대비 변경사항을 추출하세요:\n';
  prompt += '- 상태 변경 (진행→제출 등)\n';
  prompt += '- 결과물 업로드 (파일 변경)\n';
  prompt += '- 결정/합의\n';
  prompt += '- 일정 변경\n';
  prompt += '- 교훈/문제-해결\n\n';
  prompt += '일상 대화, 인사, 잡담은 무시하세요.\n\n';
  prompt +=
    'JSON 배열로 반환: [{project, work_unit, kind, topic, summary, reasoning, event_date, confidence}]\n';
  prompt += '추출할 것이 없으면 빈 배열 []을 반환하세요.\n\n---\n';

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
    channelSections.push(`### 채널: ${channelKey}\n${lines}`);
  }

  const messagesBlock = channelSections.join('\n\n');

  const hubContextLines = hubContext
    .map((entry) => {
      const parts: string[] = [`- 프로젝트: ${entry.project}`];
      if (entry.workUnit) parts.push(`  작업: ${entry.workUnit}`);
      if (entry.assignedTo) parts.push(`  담당: ${entry.assignedTo}`);
      if (entry.status) parts.push(`  상태: ${entry.status}`);
      return parts.join('\n');
    })
    .join('\n');

  let prompt = `당신은 역사가입니다.\n\n`;

  // Include truth context if provided
  if (truth && Object.keys(truth.projects).length > 0) {
    prompt += '프로젝트 진실 상태 (관리 문서/칸반 기준):\n';
    for (const [projectName, project] of Object.entries(truth.projects)) {
      for (const [workUnit, state] of Object.entries(project.workUnits)) {
        prompt += `- ${projectName}/${workUnit}: ${state.status}`;
        if (state.assigned) prompt += `, 담당: ${state.assigned}`;
        prompt += '\n';
      }
    }
    prompt += '\n';
  }

  prompt += `현재 활성 프로젝트 상황:\n${hubContextLines || '(없음)'}

아래 스포크 채널 메시지에서 중요한 작업, 결정, 교훈, 일정을 추출하세요.
가능한 경우 위의 허브 프로젝트와 연결하세요.
허브 프로젝트와 무관한 일상적인 잡담은 무시하세요.

출력 형식: JSON 배열로만 응답하세요. 다른 텍스트 없이 JSON만 출력하세요.
각 항목의 스키마:
[
  {
    "project": "프로젝트명 (허브 컨텍스트에서 연결 가능한 경우 해당 프로젝트명 사용)",
    "work_unit": "작업 단위 또는 기능명 (선택)",
    "assigned_to": "담당자 이름 (선택)",
    "kind": "task | decision | lesson | schedule",
    "topic": "한 줄 제목",
    "summary": "요약 (2-3문장)",
    "reasoning": "이 항목을 추출한 이유 및 허브 프로젝트와의 연결 근거",
    "event_date": "YYYY-MM-DD 형식 (메시지에서 날짜를 추론할 수 있는 경우, 없으면 null)",
    "confidence": 0.0~1.0
  }
]

메시지:
${messagesBlock}`;

  return prompt;
}
