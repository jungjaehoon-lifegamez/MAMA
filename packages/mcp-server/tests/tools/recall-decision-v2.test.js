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
});
