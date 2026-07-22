import { describe, expect, it } from 'vitest';

import {
  isOperatorTriggerLoopEnabled,
  resolveOperatorReportChatId,
} from '../../src/operator/runtime-config.js';

describe('operator runtime parity defaults', () => {
  it('starts proactive monitoring by default and only disables it explicitly', () => {
    expect(isOperatorTriggerLoopEnabled({})).toBe(true);
    expect(isOperatorTriggerLoopEnabled({ MAMA_TRIGGER_LOOP: '1' })).toBe(true);
    expect(isOperatorTriggerLoopEnabled({ MAMA_TRIGGER_LOOP: '0' })).toBe(false);
  });

  it('uses the sole verified private owner chat when no duplicate env setting exists', () => {
    expect(resolveOperatorReportChatId({}, ['1111111111'])).toBe('1111111111');
    expect(resolveOperatorReportChatId({}, ['1111111111', '2222222222'])).toBe('');
    expect(resolveOperatorReportChatId({}, ['-100123456'])).toBe('');
  });

  it('keeps an explicit report destination authoritative', () => {
    expect(
      resolveOperatorReportChatId({ MAMA_TRIGGER_LOOP_REPORT_CHAT: '9000000000' }, [
        '1111111111',
        '9000000000',
      ])
    ).toBe('9000000000');
  });

  it('rejects an explicit destination that is not an allowlisted private owner chat', () => {
    expect(
      resolveOperatorReportChatId({ MAMA_TRIGGER_LOOP_REPORT_CHAT: '-100123' }, ['-100123'])
    ).toBe('');
    expect(
      resolveOperatorReportChatId({ MAMA_TRIGGER_LOOP_REPORT_CHAT: '9000000000' }, ['1111111111'])
    ).toBe('');
  });
});
