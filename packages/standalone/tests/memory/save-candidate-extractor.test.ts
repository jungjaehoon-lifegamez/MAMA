import { describe, expect, it } from 'vitest';

import { extractSaveCandidates } from '../../src/memory/save-candidate-extractor.js';

describe('extractSaveCandidates', () => {
  it('extracts an explicit decision candidate', () => {
    const candidates = extractSaveCandidates({
      userText: '앞으로 이 프로젝트에서는 PostgreSQL을 기본 데이터베이스로 사용하자. 이건 기억해.',
      botResponse: '알겠습니다. PostgreSQL을 기본 DB로 사용하겠습니다.',
      channelKey: 'telegram:7026976631',
      source: 'telegram',
      channelId: '7026976631',
      userId: '7026976631',
      projectId: '/repo',
      createdAt: 1,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        kind: 'decision',
        topicHint: 'database_choice',
        channelKey: 'telegram:7026976631',
      })
    );
  });

  it('extracts an explicit preference candidate', () => {
    const candidates = extractSaveCandidates({
      userText: '나는 Sony 호환 액세서리를 선호해. 나중에 사진 장비 추천할 때 기억해.',
      botResponse: '알겠습니다. Sony 호환 장비 선호를 기억하겠습니다.',
      channelKey: 'telegram:7026976631',
      source: 'telegram',
      channelId: '7026976631',
      userId: '7026976631',
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

  it('returns no candidates for pure acknowledgements', () => {
    const candidates = extractSaveCandidates({
      userText: '고마워',
      botResponse: '천만에요.',
      channelKey: 'telegram:7026976631',
      source: 'telegram',
      channelId: '7026976631',
      userId: '7026976631',
      projectId: '/repo',
      createdAt: 1,
    });

    expect(candidates).toEqual([]);
  });
});
