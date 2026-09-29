import type { ActionContract, ActionRegistration } from '@jungjaehoon/mama-core';

type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Schema)
    : null;
}

function firstSentence(summary: string): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end === -1 ? flat : flat.slice(0, end + 1);
  return first.length <= 160 ? first : `${first.slice(0, 157)}...`;
}

/** Top-level arguments in schema order, required ones first; `?` marks an optional one. */
function orderedProperties(schema: Schema): Array<[string, unknown, boolean]> {
  const properties = asSchema(schema.properties);
  if (!properties) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const entries = Object.entries(properties);
  return [
    ...entries.filter(([name]) => required.has(name)).map(([name, value]) => [name, value, true]),
    ...entries.filter(([name]) => !required.has(name)).map(([name, value]) => [name, value, false]),
  ] as Array<[string, unknown, boolean]>;
}

function enumText(schema: Schema): string | null {
  if ('const' in schema) return JSON.stringify(schema.const);
  return Array.isArray(schema.enum)
    ? schema.enum.map((value) => JSON.stringify(value)).join('|')
    : null;
}

/**
 * The argument sets a top-level `oneOf`/`anyOf` requires, e.g. `observationRef | observationRefs`
 * for `source.read`, when each alternative only names required arguments.
 */
function requiredChoice(schema: Schema): string | null {
  const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf : schema.anyOf;
  if (!Array.isArray(alternatives)) return null;
  const sets = alternatives.map((alternative) => {
    const required = asSchema(alternative)?.required;
    return Array.isArray(required) && required.length > 0 ? required.join(' + ') : null;
  });
  return sets.every((set) => set !== null) ? sets.join(' | ') : null;
}

/**
 * The bound a caller cannot guess from the name, e.g. `≤50` for a limit, `≤4 items` for a list or
 * `≤1024 chars` for a caption:
 * on the first live day the agent sent `limit: 100` to `work.list`, whose maximum is 50.
 */
function boundText(schema: Schema): string | null {
  if (typeof schema.maximum === 'number') return `≤${schema.maximum}`;
  if (typeof schema.maxItems === 'number') return `≤${schema.maxItems} items`;
  if (typeof schema.maxLength === 'number') return `≤${schema.maxLength} chars`;
  return null;
}

/**
 * The argument list the agent calls with, as Kagemusha's code_act description lists
 * `task_update({id, status, priority, deadline})`: top-level names, `?` for optional ones, the
 * allowed values of a plain enum and the bound of a number, list or text.
 */
export function actionSignature(inputSchema: unknown): string {
  const schema = asSchema(inputSchema);
  if (!schema) return '{}';
  const parts = orderedProperties(schema).map(([name, value, required]) => {
    const property = asSchema(value);
    const detail = property ? (enumText(property) ?? boundText(property)) : null;
    return `${name}${required ? '' : '?'}${detail ? `: ${detail}` : ''}`;
  });
  const choice = requiredChoice(schema);
  return `{${parts.join(', ')}${choice ? `; one of: ${choice}` : ''}}`;
}

/**
 * What every turn shows for an action: its name and first sentence, an index entry. The
 * arguments come from help({actions: [name]}) when the agent is about to call it.
 */
export function actionCatalogLine(contract: Pick<ActionContract, 'name' | 'summary'>): string {
  return `${contract.name} — ${firstSentence(contract.summary)}`;
}

function typeText(value: unknown, depth: number): string {
  const schema = asSchema(value);
  if (!schema) return 'any';
  const values = enumText(schema);
  if (values) return values;
  const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf : schema.anyOf;
  if (Array.isArray(alternatives))
    return alternatives.map((alternative) => typeText(alternative, depth)).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  if (schema.type === 'array') {
    const item = typeText(schema.items, depth);
    return `${/[ |]/.test(item) ? `(${item})` : item}[]`;
  }
  if (schema.type === 'object' || schema.properties !== undefined) {
    const properties = orderedProperties(schema);
    // Two levels show an argument's shape; deeper parts are named `object`, and the argument's
    // description gives an example of the whole value. Keeping help short is what help is for.
    if (properties.length === 0 || depth >= 3) return 'object';
    return `{${properties
      .map(
        ([name, property, required]) =>
          `${name}${required ? '' : '?'}: ${typeText(property, depth + 1)}`
      )
      .join(', ')}}`;
  }
  return typeof schema.type === 'string' ? schema.type : 'any';
}

const items = (count: number): string => `${count} item${count === 1 ? '' : 's'}`;

/** The limits the dispatcher enforces on one argument, e.g. ` (at most 4 items)`. */
function limitsText(value: unknown): string {
  const schema = asSchema(value);
  if (!schema) return '';
  const limits = [
    typeof schema.minItems === 'number' ? `at least ${items(schema.minItems)}` : null,
    typeof schema.maxItems === 'number' ? `at most ${items(schema.maxItems)}` : null,
    typeof schema.minimum === 'number' ? `min ${schema.minimum}` : null,
    typeof schema.maximum === 'number' ? `max ${schema.maximum}` : null,
    typeof schema.maxLength === 'number' ? `at most ${schema.maxLength} chars` : null,
    typeof schema.pattern === 'string' ? `pattern ${schema.pattern}` : null,
  ].filter((limit) => limit !== null);
  return limits.length === 0 ? '' : ` (${limits.join(', ')})`;
}

/** One action's contract as plain lines: signature, summary, each argument and the examples. */
function helpText(contract: ActionContract): string {
  const schema = asSchema(contract.inputSchema) ?? {};
  const lines = [`${contract.name}(${actionSignature(schema)})`, contract.summary];
  for (const [name, property, required] of orderedProperties(schema)) {
    const description = asSchema(property)?.description;
    lines.push(
      `- ${name}${required ? ' (required)' : ''}: ${typeText(property, 1)}${limitsText(property)}${
        typeof description === 'string' ? `. ${description}` : ''
      }`
    );
  }
  const alternatives = [schema.oneOf, schema.anyOf].find(Array.isArray);
  if (alternatives)
    lines.push(
      `- one of: ${requiredChoice(schema) ?? alternatives.map((alternative) => typeText(alternative, 1)).join(' | ')}`
    );
  for (const example of contract.examples ?? [])
    lines.push(`example (${example.title}): ${JSON.stringify(example.input)}`);
  return lines.join('\n');
}

function invalidInput(message: string): Error {
  const error = new Error(message);
  error.name = 'invalid_input';
  return error;
}

export interface HelpActionPorts {
  /** The granted contracts, read when `help` runs so it sees the finished catalog. */
  contracts(): readonly ActionContract[];
  /** The procedures a turn reads when it needs one, by topic name. */
  topics?(): Readonly<Record<string, string>>;
}

export function helpActionRegistrations(ports: HelpActionPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'help',
        summary:
          "Read what you need next: an action's arguments, allowed values and an example before you first call it (actions), or a procedure when a turn needs it (topic); with neither, list the topics and actions.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            actions: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
            topic: { type: 'string', minLength: 1 },
          },
        },
        examples: [
          { title: 'Read one contract', input: { actions: ['report.publish'] } },
          { title: 'Read a procedure', input: { topic: 'full-report' } },
        ],
      },
      exec: (input) => {
        const { actions: requested, topic } = input as { actions?: unknown; topic?: unknown };
        const contracts = ports.contracts();
        const topics = ports.topics?.() ?? {};
        const parts: string[] = [];
        if (topic !== undefined) {
          const text = typeof topic === 'string' ? topics[topic] : undefined;
          if (text === undefined)
            throw invalidInput(
              `unknown topic: ${String(topic)}; topics: ${Object.keys(topics).join(', ')}`
            );
          parts.push(text);
        }
        if (requested === undefined) {
          if (topic !== undefined) return parts.join('\n\n');
          return [
            `Topics: ${Object.keys(topics).join(', ')}`,
            'Actions:',
            ...contracts.map(actionCatalogLine),
          ].join('\n');
        }
        if (!Array.isArray(requested)) throw invalidInput('actions must be a list of action names');
        // Codex sees tools.work_list and Claude calls work.list inside code_act; both name work.list.
        const key = (name: string): string => name.replace(/[.:]/g, '_');
        const byName = new Map(contracts.map((contract) => [key(contract.name), contract]));
        const unknown = requested.filter((name) => !byName.has(key(String(name))));
        if (unknown.length > 0) throw invalidInput(`unknown actions: ${unknown.join(', ')}`);
        parts.push(...requested.map((name) => helpText(byName.get(key(String(name)))!)));
        return parts.join('\n\n');
      },
    },
  ];
}
