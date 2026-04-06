import { describe, it, expect } from 'vitest';
import { recallDecisionTool } from '../../src/tools/recall-decision.js';

describe('recall_decision v2: scopes + format', () => {
  it('has scopes in inputSchema', () => {
    expect(recallDecisionTool.inputSchema.properties.scopes).toBeDefined();
    expect(recallDecisionTool.inputSchema.properties.scopes.type).toBe('array');
  });

  it('has format in inputSchema', () => {
    expect(recallDecisionTool.inputSchema.properties.format).toBeDefined();
    expect(recallDecisionTool.inputSchema.properties.format.enum).toEqual(['markdown', 'json']);
  });

  it('topic is still required', () => {
    expect(recallDecisionTool.inputSchema.required).toContain('topic');
  });

  it('rejects empty topic', async () => {
    const result = await recallDecisionTool.handler({ topic: '' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Validation error');
  });

  it('rejects missing topic', async () => {
    const result = await recallDecisionTool.handler({});
    expect(result.success).toBe(false);
  });
});
