import { createHash } from 'node:crypto';
import { scanForSecrets } from '../memory/secret-filter.js';
import type { ProcedureAccess } from './procedure-store.js';

const MAX_EVIDENCE_BYTES = 65_536;
const SECRET_FIELD =
  /^(password|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|private[_-]?key)$/i;

export interface ExecutionEvidence {
  input: unknown;
  result: unknown;
  inputHash: string | null;
  resultHash: string | null;
  completeness: 'complete' | 'redacted' | 'oversized' | 'unserializable';
  redactions: string[];
}

const CREDENTIAL_TEXT =
  /(?:["']?\b(?:password|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|private[_-]?key)["']?\s*[:=]\s*[^\s,;}]+|--(?:password|token|api-key)\s+\S+)/i;

function hasSecretField(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (typeof value === 'string') return CREDENTIAL_TEXT.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      (SECRET_FIELD.test(key) && entry !== null && entry !== '') || hasSecretField(entry, depth + 1)
  );
}

export function safeExperienceSummary(text: string): string {
  return !scanForSecrets(text).clean || CREDENTIAL_TEXT.test(text)
    ? '[redacted execution summary]'
    : text;
}

/** Preserve comparable execution evidence, never turn an error into an action recipe. */
export function captureExecutionEvidence(input: unknown, result: unknown): ExecutionEvidence {
  let inputText: string;
  let resultText: string;
  try {
    inputText = JSON.stringify(input ?? null);
    resultText = JSON.stringify(result ?? null);
    if (typeof inputText !== 'string' || typeof resultText !== 'string')
      throw new Error('non-JSON evidence');
  } catch {
    return {
      input: null,
      result: null,
      inputHash: null,
      resultHash: null,
      completeness: 'unserializable',
      redactions: [],
    };
  }
  const inputHash = createHash('sha256').update(inputText).digest('hex');
  const resultHash = createHash('sha256').update(resultText).digest('hex');
  const common = { inputHash, resultHash };
  if (Buffer.byteLength(inputText) + Buffer.byteLength(resultText) > MAX_EVIDENCE_BYTES) {
    return { ...common, input: null, result: null, completeness: 'oversized', redactions: [] };
  }
  const inputValue: unknown = JSON.parse(inputText);
  const resultValue: unknown = JSON.parse(resultText);
  const scan = scanForSecrets(inputText + '\n' + resultText);
  const secretFields = hasSecretField(inputValue) || hasSecretField(resultValue);
  if (!scan.clean || secretFields) {
    return {
      ...common,
      input: null,
      result: null,
      completeness: 'redacted',
      redactions: [...scan.matches, ...(secretFields ? ['credential-field'] : [])],
    };
  }
  return {
    ...common,
    input: inputValue,
    result: resultValue,
    completeness: 'complete',
    redactions: [],
  };
}

export function traceReadScope(access: ProcedureAccess): {
  owner_scope: string;
  project_id: string;
  channel_id?: string;
} {
  if (access.ownerScope !== 'owner:runtime' && !access.channelId) {
    throw new Error('Execution evidence member channel required');
  }
  return {
    owner_scope: access.ownerScope,
    project_id: access.projectId,
    ...(access.ownerScope === 'owner:runtime' ? {} : { channel_id: access.channelId }),
  };
}
