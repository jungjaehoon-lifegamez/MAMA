import { readFileSync } from 'node:fs';

export interface JevQuestion {
  readonly type: string;
  readonly instructions: unknown;
  /** noul true/false meanings, choice options {key: meaning}, or score levels in order. */
  readonly criteria?: unknown;
}

export type JevQuestions = Readonly<Record<string, JevQuestion>>;
export type JevAnswers = Readonly<Record<string, Record<string, unknown>>>;

export interface JevBatchRequest {
  readonly state: unknown;
  readonly questions: JevQuestions;
  readonly observationRefs: readonly string[];
  /** Cancels the request with the turn that made it. */
  readonly signal?: AbortSignal;
}

export interface JevClientOptions {
  readonly keyFile: string;
  readonly vocabFile: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly readKey?: (path: string) => string;
  readonly readVocab?: (path: string) => unknown;
}

export class JevBatchIncompleteError extends Error {
  readonly observationRefs: readonly string[];
  readonly cause: unknown;

  constructor(observationRefs: readonly string[], cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Jev batch incomplete for observation refs: ${observationRefs.join(', ')}: ${message}`);
    this.name = 'JevBatchIncompleteError';
    this.observationRefs = Object.freeze([...observationRefs]);
    this.cause = cause;
  }
}

interface JevClient {
  readonly vocabulary: unknown;
  ask(request: JevBatchRequest): Promise<JevAnswers>;
  askBatch(requests: readonly JevBatchRequest[]): Promise<readonly JevAnswers[]>;
}

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_ATTEMPTS = 3;

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Jev ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** The API's error type and request id, so a failure can be traced with the provider. */
function errorDetail(text: string): string {
  try {
    const detail = (JSON.parse(text) as { detail?: { error_type?: unknown; request_id?: unknown } })
      .detail;
    const type = typeof detail?.error_type === 'string' ? detail.error_type : null;
    const id = typeof detail?.request_id === 'string' ? detail.request_id : null;
    return type || id ? ` (${[type, id].filter(Boolean).join(', ')})` : '';
  } catch {
    return '';
  }
}

export function createJevClient(options: JevClientOptions): JevClient {
  const requestFetch = options.fetch ?? globalThis.fetch;
  if (typeof requestFetch !== 'function') throw new Error('Jev fetch is unavailable');
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const readKey = options.readKey ?? ((path) => readFileSync(path, 'utf8'));
  const readVocab = options.readVocab ?? readJson;
  let key: string | undefined;
  let vocabulary: unknown;

  const loadKey = (): string => {
    if (key === undefined) {
      const value = readKey(options.keyFile).trim();
      if (value === '') throw new Error('Jev key file is empty');
      key = value;
    }
    return key;
  };
  const loadVocabulary = (): unknown => {
    if (vocabulary === undefined) vocabulary = object(readVocab(options.vocabFile), 'vocabulary');
    return vocabulary;
  };

  const ask = async (request: JevBatchRequest): Promise<JevAnswers> => {
    const body = {
      model: options.model ?? 'jev-latest',
      state: request.state,
      questions: request.questions,
    };
    let lastRetryStatus = 529;
    let lastDetail = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const response = await requestFetch(options.endpoint ?? DEFAULT_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${loadKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const text = await response.text();
      if (response.ok) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          throw new Error('Jev response is not JSON');
        }
        const answers = object(parsed, 'answers response').answers;
        return object(answers, 'answers') as JevAnswers;
      }
      // 429/529 are the archive's retried statuses; 500/502/503 are transient server errors of
      // an idempotent judgment (live 2026-09-25: one 500 stopped the 9/11 window).
      if (![429, 500, 502, 503, 529].includes(response.status)) {
        throw new Error(`Jev HTTP ${response.status}${errorDetail(text)}`);
      }
      lastRetryStatus = response.status;
      lastDetail = errorDetail(text);
      if (attempt + 1 < MAX_ATTEMPTS) await sleep(1_500 * (attempt + 1));
    }
    throw new Error(`Jev HTTP ${lastRetryStatus} x${MAX_ATTEMPTS}${lastDetail}`);
  };

  return {
    get vocabulary() {
      return loadVocabulary();
    },
    ask,
    askBatch: async (requests) => {
      const answers: JevAnswers[] = [];
      for (const request of requests) {
        try {
          answers.push(await ask(request));
        } catch (error) {
          throw new JevBatchIncompleteError(request.observationRefs, error);
        }
      }
      return Object.freeze(answers);
    },
  };
}

export async function pool<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency = 5
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Jev pool concurrency must be a positive safe integer');
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await worker(items[index]!);
      }
    })
  );
}
