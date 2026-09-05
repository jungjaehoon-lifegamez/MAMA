import type { CodeActToolPolicy } from './tool-policy.js';
import type { ToolMeta } from './host-bridge.js';

/**
 * Generates TypeScript-style function declarations for LLM context.
 * Produces compact .d.ts-like output (~2000 chars) instead of
 * verbose markdown tool descriptions (~8000+ chars).
 */
export class TypeDefinitionGenerator {
  /** Generate .d.ts from an already-projected canonical policy. */
  static generate(policy: CodeActToolPolicy): string {
    const projectedNames = new Set(policy.names);
    const renderedNames = new Set<string>();
    const selected: ToolMeta[] = [];
    for (const meta of policy.definitions) {
      if (!projectedNames.has(meta.name) || renderedNames.has(meta.name)) {
        continue;
      }
      renderedNames.add(meta.name);
      selected.push(meta);
    }

    return this.generateDefinitions(selected);
  }

  /** Render complete declarations for an already-selected metadata batch. */
  static generateDefinitions(definitions: readonly ToolMeta[]): string {
    const lines: string[] = ['// Args: Read({path:"/file"}) or Read("/file")'];
    const categories = new Map<string, ToolMeta[]>();
    for (const meta of definitions) {
      const categoryDefinitions = categories.get(meta.category) ?? [];
      categoryDefinitions.push(meta);
      categories.set(meta.category, categoryDefinitions);
    }

    for (const [category, definitions] of categories) {
      lines.push(`\n// --- ${category} ---`);
      for (const meta of definitions) {
        lines.push(this.declaration(meta));
      }
    }

    return lines.join('\n');
  }

  /** One atomic, self-describing contract for tool_describe. */
  static generateContract(meta: ToolMeta): string {
    const comments = [`/** ${escapeComment(meta.description)}`];
    for (const param of meta.params) {
      const requirement = param.required ? 'required' : 'optional';
      const description = param.description ? ` - ${escapeComment(param.description)}` : '';
      comments.push(` * @field ${param.name} (${requirement}) ${param.type}${description}`);
    }
    comments.push(' */');
    return [...comments, this.declaration(meta)].join('\n');
  }

  private static declaration(meta: ToolMeta): string {
    const params = meta.params
      .map((param) => `${param.name}${param.required ? '' : '?'}: ${param.type}`)
      .join(',');
    const optionalInput = meta.params.length > 0 && meta.params.every((param) => !param.required);
    const input = meta.inputType
      ? `input:${meta.inputType}`
      : params.length > 0
        ? `input${optionalInput ? '?' : ''}:{${params}}`
        : '';
    return `declare function ${meta.name}(${input}): ${meta.returnType};`;
  }

  /** Estimate token count (rough: 1 token ≈ 4 chars) */
  static estimateTokens(policy: CodeActToolPolicy): number {
    return Math.ceil(this.generate(policy).length / 4);
  }
}

function escapeComment(value: string): string {
  return value.replaceAll('*/', '* /').replaceAll('\n', ' ');
}
