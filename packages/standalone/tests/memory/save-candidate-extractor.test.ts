import { describe, expect, it } from 'vitest';

import { extractSaveCandidates } from '../../src/memory/save-candidate-extractor.js';

describe('Story: Extract save candidates', () => {
  describe('AC #1: Decision extraction', () => {
    it('extracts an explicit decision candidate', () => {
      const candidates = extractSaveCandidates({
        userText:
          '앞으로 이 프로젝트에서는 PostgreSQL을 기본 데이터베이스로 사용하자. 이건 기억해.',
        botResponse: '알겠습니다. PostgreSQL을 기본 DB로 사용하겠습니다.',
        channelKey: 'telegram:5551000001',
        source: 'telegram',
        channelId: '5551000001',
        userId: '5551000001',
        projectId: '/repo',
        createdAt: 1,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toEqual(
        expect.objectContaining({
          kind: 'decision',
          topicHint: 'database_choice',
          channelKey: 'telegram:5551000001',
        })
      );
    });
  });

  describe('AC #2: Preference extraction', () => {
    it('extracts an explicit preference candidate', () => {
      const candidates = extractSaveCandidates({
        userText: '나는 Sony 호환 액세서리를 선호해. 나중에 사진 장비 추천할 때 기억해.',
        botResponse: '알겠습니다. Sony 호환 장비 선호를 기억하겠습니다.',
        channelKey: 'telegram:5551000001',
        source: 'telegram',
        channelId: '5551000001',
        userId: '5551000001',
        projectId: '/repo',
        createdAt: 1,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toEqual(
        expect.objectContaining({
          kind: 'preference',
          topicHint: 'photography_preference',
        })
      );
    });

    it('extracts an explicit change candidate', () => {
      const candidates = extractSaveCandidates({
        userText: '이제는 PostgreSQL을 기본 DB로 바꿀게. 이 결정 기억해.',
        botResponse: '알겠습니다. 이제 PostgreSQL로 전환하는 것으로 기억하겠습니다.',
        channelKey: 'telegram:5551000001',
        source: 'telegram',
        channelId: '5551000001',
        userId: '5551000001',
        projectId: '/repo',
        createdAt: 2,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toEqual(
        expect.objectContaining({
          kind: 'change',
          topicHint: 'database_choice',
          channelKey: 'telegram:5551000001',
        })
      );
    });
  });

  describe('AC #3: Ignore acknowledgements', () => {
    it('returns no candidates for pure acknowledgements', () => {
      const candidates = extractSaveCandidates({
        userText: '고마워',
        botResponse: '천만에요.',
        channelKey: 'telegram:5551000001',
        source: 'telegram',
        channelId: '5551000001',
        userId: '5551000001',
        projectId: '/repo',
        createdAt: 1,
      });

      expect(candidates).toEqual([]);
    });

    it('does not extract a candidate from ordinary chat with weak temporal words', () => {
      const candidates = extractSaveCandidates({
        userText: 'before we continue, can you explain this one more time?',
        botResponse: '물론입니다.',
        channelKey: 'telegram:5551000001',
        source: 'telegram',
        channelId: '5551000001',
        userId: '5551000001',
        projectId: '/repo',
        createdAt: 3,
      });

      expect(candidates).toEqual([]);
    });
  });
});

import { wrapUntrustedContent } from '../../src/utils/untrusted-content.js';

// prettier-ignore
const directiveKeywords = ['보고는 항상 한글로 작성해줘', '내일부터는 아침에 먼저 요약을 보내줘', '고객 채널에는 이모지 쓰지 마'];

describe('Story OPS-1 / S1-T6: owner directive persistence', () => {
  const base = {
    botResponse: 'ok',
    channelKey: 'telegram:5551000001',
    source: 'telegram',
    channelId: '5551000001',
    userId: '5551000001',
    projectId: '/repo',
    createdAt: 1,
  };

  describe('AC #1: standing directives become preference candidates', () => {
    it.each(directiveKeywords)('detects: %s', (utterance) => {
      const candidates = extractSaveCandidates({ ...base, userText: utterance });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].kind).toBe('preference');
    });

    it('detects english standing directives', () => {
      const candidates = extractSaveCandidates({
        ...base,
        userText: 'From now on send the summary before 9am.',
      });
      expect(candidates.length).toBeGreaterThan(0);
    });
  });

  describe('AC #2: directives inside untrusted blocks are data, not instructions', () => {
    it('produces zero candidates for a wrapped third-party directive', () => {
      const wrapped = wrapUntrustedContent('telegram-forward', directiveKeywords[0]);
      const candidates = extractSaveCandidates({ ...base, userText: wrapped });
      expect(candidates).toEqual([]);
    });

    it('still extracts the owner text surrounding a wrapped block', () => {
      const wrapped = wrapUntrustedContent('telegram-forward', 'noise');
      const candidates = extractSaveCandidates({
        ...base,
        userText: `${directiveKeywords[0]}\n${wrapped}`,
      });
      expect(candidates).toHaveLength(1);
    });
  });
});
