/**
 * trigger-author - Task 3, the heart (G1 + G3).
 *
 * The agent recognizes a recurring situation in a window of polled events and AUTHORS a
 * trigger (its match keywords, memoryQuery, procedure, requiredEvidence). This replaces both
 * Kagemusha's hardcoded regex markers (G1) and its 4-profile executable catalog (G3).
 *
 * The agent is injected (`AskAgent`) so the flow is deterministic + unit-testable; the real
 * claude-CLI agent is `askAgentCLI`, exercised by the LLM eval.
 *
 * G3 GUARD: validation is STRUCTURAL only. `kind` and `procedure[].action` are open strings;
 * unknown VALUES are accepted. Never narrow them to a fixed enum - that re-freezes G3.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodexRuntimeProcess } from '../multi-agent/runtime-process.js';
import { ClineCLIAdapter } from '../agent/cline-cli-adapter.js';
import type { CodexRuntimeProcessOptions } from '../multi-agent/runtime-process.js';
import type { IModelRunner } from '../agent/model-runner.js';
import type { OperatorChannelEvent } from './operator-interfaces.js';
import type { CreateTriggerInput, TriggerRecord } from './trigger-types.js';
import type { TriggerRegistry } from './trigger-registry.js';

const execFileAsync = promisify(execFile);

/** Injected agent: prompt in, raw text answer out. */
export type AskAgent = (prompt: string) => Promise<string>;

/** What the agent returns (a CreateTriggerInput minus server-managed fields). */
export interface TriggerSpec {
  id?: string;
  kind: string;
  memoryQuery: string;
  match: {
    keywords: string[];
    keywordMode: 'any' | 'every';
    scopeChannelIds?: string[];
    minConfidence: number;
  };
  procedure: { action: string; description: string }[];
  requiredEvidence: string[];
}

export interface AuthorOptions {
  note?: string;
}

type TriggerCodexRunner = Pick<IModelRunner, 'prompt' | 'stop'>;
type TriggerClineRunner = Pick<IModelRunner, 'prompt' | 'stop'>;

export interface TriggerAgentRuntimeOptions {
  model?: string;
  cwd?: string;
  command?: string;
  requestTimeout?: number;
  provider?: string;
  dataDir?: string;
}

export interface TriggerAgentRuntime {
  askAuthor: AskAgent;
  askReview: AskAgent;
  stop(): Promise<void>;
}

export interface TriggerAgentRuntimeDependencies {
  askClaude?: AskAgent;
  createClaudeAsk?: (options: { model?: string; signal?: AbortSignal }) => AskAgent;
  createCodexRuntime?: (options: CodexRuntimeProcessOptions) => TriggerCodexRunner;
  createClineRuntime?: (options: {
    command?: string;
    provider?: string;
    model?: string;
    systemPrompt?: string;
    cwd?: string;
    dataDir?: string;
    requestTimeout?: number;
  }) => TriggerClineRunner;
}

export type ClaudeCliExecutor = (
  file: string,
  args: string[],
  options: { maxBuffer: number; signal?: AbortSignal }
) => Promise<{ stdout: string }>;

const TRIGGER_CODEX_SYSTEM_PROMPT =
  'Return only the requested JSON value, with no prose or code fences.';
const TRIGGER_AUTHOR_SESSION_KEY = 'operator:trigger-author';
const TRIGGER_REVIEW_SESSION_KEY = 'operator:trigger-review';
const AUTHOR_EVENT_CHARS = 500;
const AUTHOR_EVENT_SECTION_CHARS = 10_000;
const AUTHOR_TRIGGER_SUMMARY_CHARS = 300;
const AUTHOR_TRIGGER_SECTION_CHARS = 12_000;

export async function authorTriggers(
  events: OperatorChannelEvent[],
  registry: TriggerRegistry,
  askAgent: AskAgent,
  opts: AuthorOptions = {}
): Promise<TriggerRecord[]> {
  const existing = registry.listActive();
  const prompt = buildAuthorPrompt(events, existing);
  const answer = await askAgent(prompt);
  const specs = parseTriggerSpecs(answer); // throws on unparseable output (no-fallback)

  const created: TriggerRecord[] = [];
  const seen = existing.map((t) => ({
    keywords: t.match.keywords,
    scopeChannelIds: t.match.scopeChannelIds,
  }));
  for (const spec of specs) {
    if (isDuplicate(spec, seen)) continue;
    const id = spec.id ?? deriveId(spec);
    if (registry.getById(id)) continue;
    const input: CreateTriggerInput = {
      id,
      kind: spec.kind,
      memoryQuery: spec.memoryQuery,
      match: spec.match,
      procedure: spec.procedure,
      requiredEvidence: spec.requiredEvidence,
      authoredBy: 'agent',
      provenance: { createdFrom: 'agent-authored', note: opts.note ?? '' },
    };
    created.push(registry.create(input));
    seen.push({ keywords: spec.match.keywords, scopeChannelIds: spec.match.scopeChannelIds });
  }
  return created;
}

function summarizeExistingTrigger(t: TriggerRecord): string {
  const scope = t.match.scopeChannelIds?.length ? t.match.scopeChannelIds.join(', ') : '*';
  return `- kind=${t.kind} scope=[${scope}] mode=${t.match.keywordMode} keywords=[${t.match.keywords.join(', ')}]`;
}

function boundedLines(
  lines: string[],
  perLineChars: number,
  sectionChars: number,
  newestFirstBudget = false
): string {
  const selected: string[] = [];
  let used = 0;
  const candidates = newestFirstBudget ? [...lines].reverse() : lines;
  for (const raw of candidates) {
    const line = raw.replace(/[\r\n]+/g, ' ').slice(0, perLineChars);
    if (used + line.length + 1 > sectionChars) break;
    selected.push(line);
    used += line.length + 1;
  }
  const omitted = lines.length - selected.length;
  const ordered = newestFirstBudget ? selected.reverse() : selected;
  if (omitted > 0) {
    const note = `- [... ${omitted} item(s) omitted by input budget]`;
    if (newestFirstBudget) ordered.unshift(note);
    else ordered.push(note);
  }
  return ordered.join('\n');
}

export function buildAuthorPrompt(
  events: OperatorChannelEvent[],
  existing: TriggerRecord[]
): string {
  // English default. Personal phrasing overrides load from ~/.mama/operator/*.json (later refinement).
  const window = boundedLines(
    events.map((e) => `- [${e.channelId}] ${e.content}`),
    AUTHOR_EVENT_CHARS,
    AUTHOR_EVENT_SECTION_CHARS,
    true
  );
  const existingList =
    existing.length === 0
      ? '(none yet)'
      : boundedLines(
          existing.map(summarizeExistingTrigger),
          AUTHOR_TRIGGER_SUMMARY_CHARS,
          AUTHOR_TRIGGER_SECTION_CHARS
        );
  return [
    "You maintain a personal operator's library of TRIGGERS. A trigger fires on future messages",
    'that match its keywords and then recalls a memory to help the operator intervene proactively.',
    '',
    'Look at the recent messages below. Propose new triggers ONLY for situations that genuinely',
    'RECUR (appear repeatedly, possibly phrased differently). Do NOT create triggers for one-off',
    'messages. If nothing recurs, return an empty array.',
    '',
    'Recent messages:',
    window,
    '',
    'Existing triggers (do not duplicate these):',
    existingList,
    '',
    'A situation already covered by an existing trigger -- even with different wording or a',
    'partial keyword overlap -- does NOT need a new trigger. Near-variants make several',
    'triggers fire on the same message, which wastes recall and dilutes the report. Prefer',
    'proposing NOTHING over proposing a variant of an existing trigger.',
    '',
    'Return ONLY a JSON array (no prose) of trigger objects with this shape:',
    '[{ "kind": string, "memoryQuery": string,',
    '   "match": { "keywords": string[], "keywordMode": "any"|"every", "minConfidence": number },',
    '   "procedure": [{ "action": string, "description": string }],',
    '   "requiredEvidence": string[] }]',
    'kind and action are free text you choose - describe the situation and steps in your own words.',
  ].join('\n');
}

export function parseTriggerSpecs(text: string): TriggerSpec[] {
  const arr = extractJsonArray(stripCodeFences(text));
  if (arr === null) throw new Error('agent output contained no JSON array of trigger specs');
  let parsed: unknown;
  try {
    parsed = JSON.parse(arr);
  } catch (error) {
    throw new Error(`agent trigger JSON did not parse: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('agent trigger JSON was not an array');
  return parsed.map(validateTriggerSpec);
}

export function validateTriggerSpec(spec: unknown): TriggerSpec {
  if (!isObject(spec)) throw new Error('trigger spec must be an object');
  const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

  const boundedString = (label: string, value: unknown, maxChars: number): string => {
    if (!nonEmptyString(value) || value.length > maxChars) {
      throw new Error(`${label} must be a non-empty string of at most ${maxChars} characters`);
    }
    return value;
  };

  const id = spec.id === undefined ? undefined : boundedString('trigger.id', spec.id, 512);
  const kind = boundedString('trigger.kind', spec.kind, 256);
  const memoryQuery = boundedString('trigger.memoryQuery', spec.memoryQuery, 4_000);

  if (!isObject(spec.match)) throw new Error('trigger.match must be an object');
  const match = spec.match;
  if (
    !Array.isArray(match.keywords) ||
    match.keywords.length === 0 ||
    match.keywords.length > 64 ||
    !match.keywords.every((keyword) => nonEmptyString(keyword) && keyword.length <= 256)
  ) {
    throw new Error('trigger.match.keywords must be a non-empty string[]');
  }
  if (match.keywordMode !== 'any' && match.keywordMode !== 'every') {
    throw new Error("trigger.match.keywordMode must be 'any' or 'every'");
  }
  if (typeof match.minConfidence !== 'number')
    throw new Error('trigger.match.minConfidence must be a number');
  if (
    match.scopeChannelIds !== undefined &&
    (!Array.isArray(match.scopeChannelIds) ||
      match.scopeChannelIds.length > 64 ||
      !match.scopeChannelIds.every(
        (channelId) => nonEmptyString(channelId) && channelId.length <= 256
      ))
  ) {
    throw new Error('trigger.match.scopeChannelIds must be string[] when present');
  }

  if (
    !Array.isArray(spec.procedure) ||
    spec.procedure.length > 64 ||
    !spec.procedure.every(
      (p) =>
        isObject(p) &&
        nonEmptyString(p.action) &&
        p.action.length <= 256 &&
        typeof p.description === 'string' &&
        p.description.length <= 2_000
    )
  ) {
    throw new Error('trigger.procedure must be an array of {action, description}');
  }
  if (
    !Array.isArray(spec.requiredEvidence) ||
    spec.requiredEvidence.length > 64 ||
    !spec.requiredEvidence.every(
      (evidence) => typeof evidence === 'string' && evidence.length <= 1_000
    )
  ) {
    throw new Error('trigger.requiredEvidence must be string[]');
  }

  // Deliberately NO check of kind/action VALUES against any catalog (G3 guard).
  return {
    id,
    kind,
    memoryQuery,
    match: {
      keywords: match.keywords as string[],
      keywordMode: match.keywordMode,
      minConfidence: match.minConfidence,
      scopeChannelIds: match.scopeChannelIds as string[] | undefined,
    },
    procedure: spec.procedure as { action: string; description: string }[],
    requiredEvidence: spec.requiredEvidence as string[],
  };
}

/**
 * Effort for the isolated structured-JSON calls, named rather than inherited.
 *
 * Without this the call inherits `effortLevel` from ~/.claude/settings.json, which on the
 * owner's install is `xhigh` - and the daemon exports MAX_THINKING_TOKENS=0 (added
 * 2026-07-27 to stop sonnet-5 empty thinking blocks corrupting chat transcripts). The two
 * together are a hard API 400: "output_config.effort 'xhigh' is not supported when thinking
 * is disabled on this model."
 *
 * The trigger author died on that from 2026-07-28 onward - 46 failures against 8 successes
 * that day, then 34 against ZERO the next - and nobody could see it, because the executor
 * dropped the CLI's output and Node's message carried only the 240 KB command line. The
 * diagnostics added in 0.29.1 printed the cause on the first failure after deploy.
 *
 * Naming the effort here keeps the daemon-wide thinking setting untouched: it exists for a
 * real transcript-corruption problem, and this call is a small structured-JSON task that
 * never needed the top tier.
 */
const TRIGGER_AUTHOR_EFFORT = 'high';

export function createAskAgentCLI(
  execute: ClaudeCliExecutor = executeClaudeCLI,
  options: { model?: string; signal?: AbortSignal } = {}
): AskAgent {
  return async (prompt) => {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--effort',
      TRIGGER_AUTHOR_EFFORT,
      '--safe-mode',
      '--tools',
      '',
      '--no-session-persistence',
    ];
    if (options.model) {
      args.push('--model', options.model);
    }
    const executeOptions = {
      maxBuffer: 16 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const { stdout } = await execute('claude', args, executeOptions);
    const parsed = JSON.parse(stdout) as { type?: string; result?: unknown };
    if (parsed.type === 'result' && typeof parsed.result === 'string') return parsed.result;
    throw new Error('claude CLI did not return a text result');
  };
}

/** Real agent: the local claude CLI (CLI-over-API). Preserved for eval compatibility. */
export const askAgentCLI: AskAgent = createAskAgentCLI();

/**
 * Provider boundary for trigger authoring and review.
 *
 * Claude keeps an isolated JSON-only CLI path. Codex shares one app-server
 * connection, but every structured task starts a fresh, isolated, read-only
 * session and advertises no host tools.
 */
export function createTriggerAgentRuntime(
  backend: 'claude' | 'codex' | 'cline',
  options: TriggerAgentRuntimeOptions = {},
  dependencies: TriggerAgentRuntimeDependencies = {}
): TriggerAgentRuntime {
  if (backend === 'claude') {
    const controller = new AbortController();
    const createClaudeAsk =
      dependencies.createClaudeAsk ??
      ((runtimeOptions: { model?: string; signal?: AbortSignal }) =>
        createAskAgentCLI(executeClaudeCLI, runtimeOptions));
    const askClaude =
      dependencies.askClaude ??
      createClaudeAsk({ model: options.model, signal: controller.signal });
    const activeCalls = new Set<Promise<string>>();
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    const askTracked: AskAgent = (prompt) => {
      if (stopped) return Promise.reject(new Error('Claude trigger runtime has stopped'));
      let call: Promise<string>;
      try {
        call = askClaude(prompt);
      } catch (error) {
        call = Promise.reject(error);
      }
      activeCalls.add(call);
      return call.finally(() => {
        activeCalls.delete(call);
      });
    };
    return {
      askAuthor: askTracked,
      askReview: askTracked,
      stop: () => {
        stopPromise ??= Promise.resolve().then(async () => {
          stopped = true;
          controller.abort();
          await Promise.allSettled([...activeCalls]);
        });
        return stopPromise;
      },
    };
  }

  if (backend === 'cline') {
    const createClineRuntime =
      dependencies.createClineRuntime ?? ((runtimeOptions) => new ClineCLIAdapter(runtimeOptions));
    const runner = createClineRuntime({
      command: options.command,
      provider: options.provider ?? 'cline',
      model: options.model,
      systemPrompt: TRIGGER_CODEX_SYSTEM_PROMPT,
      cwd: options.cwd,
      dataDir: options.dataDir,
      requestTimeout: options.requestTimeout,
    });
    const askInSession =
      (sessionKey: string): AskAgent =>
      async (prompt) => {
        const result = await runner.prompt(prompt, undefined, {
          sessionKey,
          resumeSession: false,
          systemPrompt: TRIGGER_CODEX_SYSTEM_PROMPT,
        });
        if (typeof result.response !== 'string') {
          throw new Error('Cline trigger agent did not return a text result');
        }
        return result.response;
      };
    let stopPromise: Promise<void> | undefined;
    return {
      askAuthor: askInSession(TRIGGER_AUTHOR_SESSION_KEY),
      askReview: askInSession(TRIGGER_REVIEW_SESSION_KEY),
      stop: () => {
        stopPromise ??= Promise.resolve().then(async () => {
          await runner.stop();
        });
        return stopPromise;
      },
    };
  }

  const createCodexRuntime =
    dependencies.createCodexRuntime ??
    ((runtimeOptions) => new CodexRuntimeProcess(runtimeOptions));
  const runner = createCodexRuntime({
    defaultSessionKey: TRIGGER_AUTHOR_SESSION_KEY,
    model: options.model,
    systemPrompt: TRIGGER_CODEX_SYSTEM_PROMPT,
    cwd: options.cwd,
    sandbox: 'read-only',
    requestTimeout: options.requestTimeout,
    command: options.command,
  });
  const askInSession =
    (sessionKey: string): AskAgent =>
    async (prompt) => {
      const result = await runner.prompt(prompt, undefined, {
        sessionKey,
        resumeSession: false,
        systemPrompt: TRIGGER_CODEX_SYSTEM_PROMPT,
      });
      if (typeof result.response !== 'string') {
        throw new Error('Codex trigger agent did not return a text result');
      }
      return result.response;
    };
  let stopPromise: Promise<void> | undefined;

  return {
    askAuthor: askInSession(TRIGGER_AUTHOR_SESSION_KEY),
    askReview: askInSession(TRIGGER_REVIEW_SESSION_KEY),
    stop: () => {
      stopPromise ??= Promise.resolve().then(async () => {
        await runner.stop();
      });
      return stopPromise;
    },
  };
}

/**
 * A run that outlives this has stopped being a 30-minute background pass.
 *
 * Measured: a healthy call takes ~41s. Without a bound, a hung CLI holds the tick open
 * forever, and the report leg runs AFTER the author pass in the same tick.
 */
const CLAUDE_CLI_TIMEOUT_MS = 240_000;

/**
 * Run the CLI and, when it fails, say WHY.
 *
 * The previous version destructured `{ stdout }` and let everything else go. Node puts the
 * cause on the rejection - `stderr`, `code`, `signal` - and none of it was read, so 193
 * failures over the log's lifetime recorded nothing but the 240 KB command line that
 * produced them. The tick that dies here takes the scheduled report with it (author runs at
 * step 3, the report at step 5), so an undiagnosable failure here is a silently missing
 * owner report.
 */
async function executeClaudeCLI(
  file: string,
  args: string[],
  options: { maxBuffer: number; signal?: AbortSignal }
): Promise<{ stdout: string }> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      ...options,
      timeout: CLAUDE_CLI_TIMEOUT_MS,
      // The CLI's "no stdin data received in 3s" warning rides along on stderr here. It is
      // noise, not the cause - closing stdin is not available on this path, because execFile
      // does not forward `stdio` to the spawn beneath it. Left alone deliberately: the
      // failure text captures stdout too, so the warning no longer hides the real error.
    });
    return { stdout: String(stdout) };
  } catch (error) {
    throw new Error(describeCliFailure(file, error));
  }
}

/**
 * One line naming the failure, with the command line left OUT.
 *
 * Node's own message embeds the whole argv, which here is the 240 KB prompt - that is what
 * made every past failure unreadable in the log without telling anyone anything.
 */
export function describeCliFailure(file: string, error: unknown): string {
  const e = (error ?? {}) as {
    code?: unknown;
    signal?: unknown;
    killed?: boolean;
    stderr?: unknown;
    stdout?: unknown;
    message?: unknown;
  };
  const parts: string[] = [`${file} failed`];
  if (e.killed === true || e.signal) {
    parts.push(`killed (signal=${String(e.signal ?? 'unknown')}) - likely the timeout`);
  }
  if (e.code !== undefined && e.code !== null) {
    parts.push(`exit=${String(e.code)}`);
  }

  const tail = (value: unknown, label: string): void => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) {
      parts.push(`${label}=${text.slice(-400)}`);
    }
  };
  tail(e.stderr, 'stderr');
  // The CLI reports API errors on stdout, so an empty stderr is not an absent cause.
  tail(e.stdout, 'stdout');

  if (parts.length === 1 && typeof e.message === 'string') {
    // Last resort. Strip the embedded argv so the log stays readable.
    parts.push(e.message.split('\n')[0].slice(0, 300));
  }
  return parts.join(' | ');
}

// ---- helpers ----

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?/gi, '');
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function normalizedKeywordSet(keywords: string[]): string {
  return [...new Set(keywords.map((k) => k.trim().toLocaleLowerCase()))].sort().join('|');
}

/**
 * Near-duplicate gate. Exact keyword-set equality alone let near-variants pile
 * up: day-1 live data showed 65% of fires were co-fires of overlapping triggers
 * on the same message. Within the same scope, a spec is a duplicate when its
 * keyword set is a subset/superset of an existing trigger's, or the Jaccard
 * overlap is >= 0.6. This is authoring HYGIENE (like the exact check before
 * it), not outcome judgment -- keep/retire decisions stay with the agent (G2).
 */
function isDuplicate(
  spec: TriggerSpec,
  seen: { keywords: string[]; scopeChannelIds?: string[] }[]
): boolean {
  const specKeys = new Set(spec.match.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean));
  const specScope = (spec.match.scopeChannelIds ?? []).slice().sort().join(',');
  return seen.some((s) => {
    if ((s.scopeChannelIds ?? []).slice().sort().join(',') !== specScope) return false;
    const seenKeys = new Set(s.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean));
    if (specKeys.size === 0 || seenKeys.size === 0) return false;
    let shared = 0;
    for (const k of specKeys) if (seenKeys.has(k)) shared += 1;
    if (shared === specKeys.size || shared === seenKeys.size) return true; // subset either way
    const jaccard = shared / (specKeys.size + seenKeys.size - shared);
    return jaccard >= 0.6;
  });
}

function deriveId(spec: TriggerSpec): string {
  const hash = createHash('sha256')
    .update(`${spec.kind}\n${normalizedKeywordSet(spec.match.keywords)}`)
    .digest('hex')
    .slice(0, 12);
  return `trigger.${hash}`;
}
