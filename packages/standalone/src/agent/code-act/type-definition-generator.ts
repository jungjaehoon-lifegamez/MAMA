import { HostBridge } from './host-bridge.js';

/**
 * Generates TypeScript-style function declarations for LLM context.
 * Produces compact .d.ts-like output (~2000 chars) instead of
 * verbose markdown tool descriptions (~8000+ chars).
 */
export class TypeDefinitionGenerator {
  /** Generate .d.ts string for available tools at given tier */
  static generate(tier: 1 | 2 | 3 = 1): string {
    const registry = HostBridge.getToolRegistry();
    const filtered = registry.filter((meta) => {
      if (tier === 1) return true;
      const readOnly = new Set([
        'mama_search',
        'mama_load_checkpoint',
        'Read',
        'browser_get_text',
        'browser_screenshot',
        'os_list_bots',
        'os_get_config',
        'pr_review_threads',
      ]);
      return readOnly.has(meta.name);
    });

    const lines: string[] = [
      '// Call with object: Read({path: "/file"}) or positional: Read("/file")',
    ];
    let currentCategory = '';

    for (const meta of filtered) {
      if (meta.category !== currentCategory) {
        currentCategory = meta.category;
        lines.push(`\n// --- ${currentCategory} ---`);
      }

      const params = meta.params
        .map((p) => {
          const opt = p.required ? '' : '?';
          return `${p.name}${opt}: ${p.type}`;
        })
        .join(', ');

      lines.push(`/** ${meta.description} */`);
      lines.push(`declare function ${meta.name}(${params}): ${meta.returnType};`);
    }

    return lines.join('\n');
  }

  /** Estimate token count (rough: 1 token ≈ 4 chars) */
  static estimateTokens(tier: 1 | 2 | 3 = 1): number {
    return Math.ceil(this.generate(tier).length / 4);
  }
}
