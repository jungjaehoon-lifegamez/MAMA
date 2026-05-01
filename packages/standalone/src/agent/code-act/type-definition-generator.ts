import { HostBridge, MEMORY_WRITE_TOOLS, READ_ONLY_TOOLS } from './host-bridge.js';

/**
 * Generates TypeScript-style function declarations for LLM context.
 * Produces compact .d.ts-like output (~2000 chars) instead of
 * verbose markdown tool descriptions (~8000+ chars).
 */
export class TypeDefinitionGenerator {
  /** Generate .d.ts string for available tools at given tier */
  static generate(tier: 1 | 2 | 3 = 1, allowedTools?: string[]): string {
    const registry = HostBridge.getToolRegistry();
    const filtered = registry.filter((meta) => {
      if (!isAllowedTool(meta.name, allowedTools)) {
        return false;
      }
      if (tier === 1) {
        return true;
      }
      if (tier === 2) {
        return READ_ONLY_TOOLS.has(meta.name) || MEMORY_WRITE_TOOLS.has(meta.name);
      }
      return READ_ONLY_TOOLS.has(meta.name);
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

      lines.push(`declare function ${meta.name}(${params}): ${meta.returnType};`);
    }

    return lines.join('\n');
  }

  /** Estimate token count (rough: 1 token ≈ 4 chars) */
  static estimateTokens(tier: 1 | 2 | 3 = 1, allowedTools?: string[]): number {
    return Math.ceil(this.generate(tier, allowedTools).length / 4);
  }
}

function isAllowedTool(toolName: string, allowedTools?: string[]): boolean {
  if (!allowedTools || allowedTools.length === 0 || allowedTools.includes('*')) {
    return true;
  }
  return allowedTools.some((pattern) => matchToolPattern(pattern, toolName));
}

function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return pattern === toolName;
}
