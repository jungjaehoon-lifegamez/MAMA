import { createHash } from 'node:crypto';

import type { ToolMeta } from './host-bridge.js';
import { TypeDefinitionGenerator } from './type-definition-generator.js';

const TOOL_SEARCH_DEFAULT_LIMIT = 6;
const TOOL_SEARCH_MAX_LIMIT = 12;
const TOOL_DESCRIBE_MAX_NAMES = 4;
const CURSOR_VERSION = 1;
const CURSOR_ORDER = 'name:asc';
const CURSOR_ERROR = 'Invalid or stale tool catalog cursor.';

interface ToolCatalogPolicy {
  readonly definitions: readonly ToolMeta[];
  readonly fingerprintPayload: string;
}

interface ToolSearchInput {
  readonly query?: unknown;
  readonly category?: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

interface ToolDescribeInput {
  readonly names?: unknown;
}

interface CursorPayload {
  readonly version: 1;
  readonly policy: string;
  readonly query: string;
  readonly category: string;
  readonly order: typeof CURSOR_ORDER;
  readonly offset: number;
}

export interface ToolSearchResult {
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly category: ToolMeta['category'];
  }>;
  readonly nextCursor: string | null;
}

export interface ToolDescribeResult {
  readonly contracts: readonly string[];
}

export class ProjectedToolCatalog {
  private readonly definitions: readonly ToolMeta[];
  private readonly definitionsByName: ReadonlyMap<string, ToolMeta>;
  private readonly policyHash: string;

  constructor(policy: ToolCatalogPolicy) {
    this.definitions = [...policy.definitions].sort((left, right) =>
      compareNames(left.name, right.name)
    );
    this.definitionsByName = new Map(
      this.definitions.map((definition) => [definition.name, definition])
    );
    this.policyHash = createHash('sha256').update(policy.fingerprintPayload).digest('base64url');
  }

  search(rawInput: unknown): ToolSearchResult {
    const input = optionalObjectInput(rawInput, 'tool_search');
    const query = optionalNormalizedString(input.query, 'tool_search query');
    const category = optionalNormalizedString(input.category, 'tool_search category');
    const limit = searchLimit(input.limit);
    const offset =
      input.cursor === undefined ? 0 : this.decodeCursor(input.cursor, query, category);
    const matches = this.definitions.filter((definition) => {
      if (category && definition.category.toLowerCase() !== category) {
        return false;
      }
      if (!query) {
        return true;
      }
      return `${definition.name}\n${definition.description}\n${definition.category}`
        .toLowerCase()
        .includes(query);
    });
    if (offset > matches.length) {
      throw new Error(CURSOR_ERROR);
    }
    const selected = matches.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    return {
      tools: selected.map((definition) => ({
        name: definition.name,
        description: definition.description,
        category: definition.category,
      })),
      nextCursor:
        nextOffset < matches.length ? this.encodeCursor(query, category, nextOffset) : null,
    };
  }

  describe(rawInput: unknown): ToolDescribeResult {
    const input = requiredObjectInput(rawInput, 'tool_describe') as ToolDescribeInput;
    if (!Array.isArray(input.names)) {
      throw new Error('tool_describe names must be an array of 1 to 4 distinct tool names.');
    }
    if (input.names.length < 1 || input.names.length > TOOL_DESCRIBE_MAX_NAMES) {
      throw new Error('tool_describe names must contain 1 to 4 distinct tool names.');
    }
    if (
      !input.names.every(
        (name): name is string => typeof name === 'string' && name.trim().length > 0
      )
    ) {
      throw new Error('tool_describe names must contain 1 to 4 distinct tool names.');
    }
    const names = input.names.map((name) => name.trim());
    if (new Set(names).size !== names.length) {
      throw new Error('tool_describe names must contain 1 to 4 distinct tool names.');
    }
    const definitions = names.map((name) => this.definitionsByName.get(name));
    if (definitions.some((definition) => definition === undefined)) {
      throw new Error('Requested tool is unavailable.');
    }
    return {
      contracts: (definitions as ToolMeta[]).map((definition) =>
        TypeDefinitionGenerator.generateContract(definition)
      ),
    };
  }

  private encodeCursor(query: string, category: string, offset: number): string {
    const payload: CursorPayload = {
      version: CURSOR_VERSION,
      policy: this.policyHash,
      query,
      category,
      order: CURSOR_ORDER,
      offset,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  private decodeCursor(rawCursor: unknown, query: string, category: string): number {
    if (typeof rawCursor !== 'string' || rawCursor.length === 0 || rawCursor.length > 2_048) {
      throw new Error(CURSOR_ERROR);
    }
    try {
      const parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(CURSOR_ERROR);
      }
      const cursor = parsed as Partial<CursorPayload>;
      if (
        cursor.version !== CURSOR_VERSION ||
        cursor.policy !== this.policyHash ||
        cursor.query !== query ||
        cursor.category !== category ||
        cursor.order !== CURSOR_ORDER ||
        !Number.isSafeInteger(cursor.offset) ||
        Number(cursor.offset) < 0
      ) {
        throw new Error(CURSOR_ERROR);
      }
      return Number(cursor.offset);
    } catch {
      throw new Error(CURSOR_ERROR);
    }
  }
}

function optionalObjectInput(rawInput: unknown, functionName: string): ToolSearchInput {
  if (rawInput === undefined) {
    return {};
  }
  return requiredObjectInput(rawInput, functionName) as ToolSearchInput;
}

function requiredObjectInput(rawInput: unknown, functionName: string): Record<string, unknown> {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new Error(`${functionName} input must be an object.`);
  }
  return rawInput as Record<string, unknown>;
}

function optionalNormalizedString(value: unknown, fieldName: string): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`);
  }
  return value.trim().toLowerCase();
}

function searchLimit(value: unknown): number {
  if (value === undefined) {
    return TOOL_SEARCH_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > TOOL_SEARCH_MAX_LIMIT) {
    throw new Error('tool_search limit must be an integer from 1 to 12.');
  }
  return Number(value);
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
