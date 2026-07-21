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
    const lines: string[] = ['// Args: Read({path:"/file"}) or Read("/file")'];
    const projectedNames = new Set(policy.names);
    const renderedNames = new Set<string>();
    const categories = new Map<string, ToolMeta[]>();
    for (const meta of policy.definitions) {
      if (!projectedNames.has(meta.name) || renderedNames.has(meta.name)) {
        continue;
      }
      renderedNames.add(meta.name);
      const definitions = categories.get(meta.category) ?? [];
      definitions.push(meta);
      categories.set(meta.category, definitions);
    }

    for (const [category, definitions] of categories) {
      lines.push(`\n// --- ${category} ---`);
      for (const meta of definitions) {
        const params = meta.params
          .map((p) => {
            const opt = p.required ? '' : '?';
            return `${p.name}${opt}: ${p.type}`;
          })
          .join(',');

        lines.push(`declare function ${meta.name}(${params}): ${meta.returnType};`);
      }
    }

    return lines.join('\n');
  }

  /** Estimate token count (rough: 1 token ≈ 4 chars) */
  static estimateTokens(policy: CodeActToolPolicy): number {
    return Math.ceil(this.generate(policy).length / 4);
  }
}
