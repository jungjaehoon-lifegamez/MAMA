/**
 * Owner policy and lessons, injected into every turn.
 *
 * Conversation changes operations only if what the owner said reaches the next turn.
 * Two kinds of memory rows do that: `policy:` rows (rules in force, rendered
 * unconditionally for the turn's scope) and `lesson:` rows (corrections, ranked by the
 * turn's query, bounded). Both are OWNER-authored data inside a trusted block, so every
 * rendered value is markup-escaped and every line is budgeted before assembly: a stored
 * string can never close the block or author a tag, and a closing tag is never truncated.
 */
import type { MemoryScopeRef, MemoryTruthRow } from '@jungjaehoon/mama-core/memory/types';

export interface LearningContextInput {
  /** Same scope list the turn's envelope uses; build it with deriveMemoryScopes. */
  scopes: MemoryScopeRef[];
  /** Free-text used to rank lessons only. Policies ignore it. */
  query: string;
  /** Bounded reads. `query: ''` returns everything in scope. */
  readClaims: (input: { scopes: MemoryScopeRef[]; query: string }) => Promise<MemoryTruthRow[]>;
  limits?: { maxLessons?: number; maxSummaryChars?: number; maxTotalChars?: number };
}

export interface LearningContext {
  /** Ready-to-append prompt text. Empty string when nothing qualifies. */
  promptBlock: string;
  policyIds: string[];
  lessonIds: string[];
  /** For the daemon.log prompt-audit line the acceptance test reads. */
  audit: { policyCount: number; lessonCount: number; renderedChars: number };
}

export const POLICY_TOPIC_PREFIX = 'policy:';
export const LESSON_TOPIC_PREFIX = 'lesson:';

/** Topics the host owns: only the turn observer writes them (gateway refuses the agent). */
export function isLearningTopic(topic: unknown): boolean {
  return (
    typeof topic === 'string' &&
    (topic.trimStart().toLowerCase().startsWith(POLICY_TOPIC_PREFIX) ||
      topic.trimStart().toLowerCase().startsWith(LESSON_TOPIC_PREFIX))
  );
}
const DEFAULT_LIMITS = { maxLessons: 3, maxSummaryChars: 240, maxTotalChars: 2400 } as const;
const POLICY_INSTRUCTION =
  'Owner policy, in force. Apply it. The host still enforces revisions, receipts and destinations.';
const LESSON_INSTRUCTION = 'Use as lessons, not facts; verify with the packet.';

/** Owner text is data inside a trusted block: it must not be able to author markup. */
export function escapePromptMarkup(text: string): string {
  return text
    .replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Ported gate: never render a half-formed row. */
function renderable(row: MemoryTruthRow): boolean {
  if (typeof row.effective_summary !== 'string' || row.effective_summary.trim() === '') {
    return false;
  }
  if (!Array.isArray(row.scope_refs)) {
    return false;
  }
  if (!row.scope_refs.some((scope) => scope.kind === 'project')) {
    return false;
  }
  return typeof row.updated_at === 'number' || typeof row.created_at === 'number';
}

function hasChannelScope(row: MemoryTruthRow, channelScopeId: string | null): boolean {
  return (
    channelScopeId !== null &&
    row.scope_refs.some((scope) => scope.kind === 'channel' && scope.id === channelScopeId)
  );
}

/** A policy applies when it names no channel (project- or global-wide) or exactly this one. */
function policyScopeMatches(row: MemoryTruthRow, channelScopeId: string | null): boolean {
  const channels = row.scope_refs.filter((scope) => scope.kind === 'channel');
  if (channels.length === 0) {
    return true;
  }
  return hasChannelScope(row, channelScopeId);
}

function recency(row: MemoryTruthRow): number {
  return row.updated_at ?? row.created_at ?? 0;
}

function renderLine(row: MemoryTruthRow, prefix: string, maxSummaryChars: number): string {
  const name = escapePromptMarkup(row.topic.slice(prefix.length).trim() || 'untitled');
  const summary = escapePromptMarkup(row.effective_summary.trim().slice(0, maxSummaryChars));
  return `- ${name}: ${summary}`;
}

/**
 * Budget each line against the remaining chars and drop whole lines; never slice the
 * assembled string. Returns the block and the rows that made it in.
 */
function renderBlock(
  tag: string,
  instruction: string,
  rows: MemoryTruthRow[],
  prefix: string,
  maxSummaryChars: number,
  budget: number
): { block: string; rendered: MemoryTruthRow[] } {
  if (rows.length === 0) {
    return { block: '', rendered: [] };
  }
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const frame = open.length + 1 + instruction.length + 1 + close.length;
  if (frame > budget) {
    return { block: '', rendered: [] };
  }
  let used = frame;
  const lines: string[] = [];
  const rendered: MemoryTruthRow[] = [];
  for (const row of rows) {
    const line = renderLine(row, prefix, maxSummaryChars);
    if (used + line.length + 1 > budget) {
      continue;
    }
    used += line.length + 1;
    lines.push(line);
    rendered.push(row);
  }
  if (lines.length === 0) {
    return { block: '', rendered: [] };
  }
  return { block: [open, instruction, ...lines, close].join('\n'), rendered };
}

export async function buildLearningContext(input: LearningContextInput): Promise<LearningContext> {
  const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  const channelScopeId = input.scopes.find((scope) => scope.kind === 'channel')?.id ?? null;

  // Policies are unconditional: an empty query bypasses matchesQuery ranking.
  const policyRows = await input.readClaims({ scopes: input.scopes, query: '' });
  const lessonRows = await input.readClaims({ scopes: input.scopes, query: input.query });

  const policies = policyRows
    .filter((row) => row.topic.startsWith(POLICY_TOPIC_PREFIX) && renderable(row))
    .filter((row) => policyScopeMatches(row, channelScopeId))
    .sort((a, b) => recency(b) - recency(a));
  const lessons = lessonRows
    .filter((row) => row.topic.startsWith(LESSON_TOPIC_PREFIX) && renderable(row))
    .filter((row) => hasChannelScope(row, channelScopeId))
    .sort((a, b) => recency(b) - recency(a))
    .slice(0, limits.maxLessons);

  const policyBlock = renderBlock(
    'policy',
    POLICY_INSTRUCTION,
    policies,
    POLICY_TOPIC_PREFIX,
    limits.maxSummaryChars,
    limits.maxTotalChars
  );
  const remaining = limits.maxTotalChars - (policyBlock.block ? policyBlock.block.length + 2 : 0);
  const lessonBlock = renderBlock(
    'lessons',
    LESSON_INSTRUCTION,
    lessons,
    LESSON_TOPIC_PREFIX,
    limits.maxSummaryChars,
    remaining
  );

  const promptBlock = [policyBlock.block, lessonBlock.block].filter(Boolean).join('\n\n');
  return {
    promptBlock,
    policyIds: policyBlock.rendered.map((row) => row.memory_id),
    lessonIds: lessonBlock.rendered.map((row) => row.memory_id),
    audit: {
      policyCount: policyBlock.rendered.length,
      lessonCount: lessonBlock.rendered.length,
      renderedChars: promptBlock.length,
    },
  };
}

/** One prompt-audit line per turn; the installed acceptance test greps it. */
export function formatLearningAuditLine(
  turn: string,
  channelScopeId: string | null,
  context: LearningContext
): string {
  return `[learning] turn=${turn} channel=${channelScopeId ?? '-'} policyIds=[${context.policyIds.join(',')}] lessonIds=[${context.lessonIds.join(',')}] chars=${context.audit.renderedChars}`;
}
