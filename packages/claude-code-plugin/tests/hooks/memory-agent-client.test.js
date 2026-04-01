import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseTranscriptMessages } = require('../../scripts/memory-agent-client');

describe('parseTranscriptMessages', () => {
  it('should extract user and assistant messages from Claude Code JSONL', () => {
    const content = [
      '{"type":"file-history-snapshot","content":""}',
      '{"type":"user","content":"PostgreSQL로 전환하자"}',
      '{"type":"assistant","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"네, PostgreSQL로 전환하겠습니다."}]}',
      '{"type":"user","content":"좋아 진행해"}',
    ].join('\n');

    const result = parseTranscriptMessages(content, 5);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'user', content: 'PostgreSQL로 전환하자' });
    expect(result[1]).toEqual({ role: 'assistant', content: '네, PostgreSQL로 전환하겠습니다.' });
    expect(result[2]).toEqual({ role: 'user', content: '좋아 진행해' });
  });

  it('should skip system, thinking-only, and tool_use-only entries', () => {
    const content = [
      '{"type":"system","content":"system prompt"}',
      '{"type":"user","content":"hello world test"}',
      '{"type":"assistant","content":[{"type":"tool_use","name":"Read"}]}',
      '{"type":"assistant","content":[{"type":"text","text":"Here is the result of the operation."}]}',
    ].join('\n');

    const result = parseTranscriptMessages(content, 5);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toBe('Here is the result of the operation.');
  });

  it('should limit to maxPairs * 2 messages', () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`{"type":"user","content":"message number ${i} here"}`);
      lines.push(
        `{"type":"assistant","content":[{"type":"text","text":"reply to message ${i} here"}]}`
      );
    }
    const content = lines.join('\n');

    const result = parseTranscriptMessages(content, 3);
    expect(result).toHaveLength(6);
    expect(result[0].content).toBe('message number 17 here');
  });

  it('should handle empty content', () => {
    expect(parseTranscriptMessages('', 5)).toEqual([]);
    expect(parseTranscriptMessages(null, 5)).toEqual([]);
    expect(parseTranscriptMessages(undefined, 5)).toEqual([]);
  });

  it('should handle malformed JSON lines gracefully', () => {
    const content = [
      'not json',
      '{"type":"user","content":"valid message here"}',
      '{broken',
      '{"type":"assistant","content":[{"type":"text","text":"valid reply here too"}]}',
    ].join('\n');

    const result = parseTranscriptMessages(content, 5);
    expect(result).toHaveLength(2);
  });

  it('should skip short messages (user < 3 chars, assistant < 6 chars)', () => {
    const content = [
      '{"type":"user","content":"hi"}',
      '{"type":"user","content":"tell me about databases"}',
      '{"type":"assistant","content":[{"type":"text","text":"ok"}]}',
      '{"type":"assistant","content":[{"type":"text","text":"Databases are structured data stores."}]}',
    ].join('\n');

    const result = parseTranscriptMessages(content, 5);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('tell me about databases');
    expect(result[1].content).toBe('Databases are structured data stores.');
  });

  it('should truncate content to 2000 chars', () => {
    const longContent = 'x'.repeat(5000);
    const content = `{"type":"user","content":"${longContent}"}`;

    const result = parseTranscriptMessages(content, 5);
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2000);
  });

  it('should handle simple role-based format', () => {
    const content = [
      '{"role":"user","content":"simple format question here"}',
      '{"role":"assistant","content":"simple format answer is longer than five"}',
    ].join('\n');

    const result = parseTranscriptMessages(content, 5);
    expect(result).toHaveLength(2);
  });

  it('should concatenate multiple text blocks in assistant response', () => {
    const content =
      '{"type":"assistant","content":[{"type":"text","text":"First part."},{"type":"text","text":"Second part."}]}';

    const result = parseTranscriptMessages(content, 5);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('First part.\nSecond part.');
  });
});
