import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SystemReminderService,
  type SystemReminder,
  type ChatNotifyCallback,
  type SystemReminderType,
} from '../../src/multi-agent/system-reminder.js';

function makeReminder(overrides: Partial<SystemReminder> = {}): SystemReminder {
  return {
    type: overrides.type ?? 'task-completed',
    taskId: overrides.taskId ?? 'bg_abc12345',
    description: overrides.description ?? 'Implement auth module',
    agentId: overrides.agentId ?? 'developer',
    requestedBy: overrides.requestedBy ?? 'sisyphus',
    channelId: overrides.channelId ?? 'ch-1',
    duration: overrides.duration,
    error: overrides.error,
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

describe('Story SRS-1: SystemReminderService', () => {
  let service: SystemReminderService;
  let mockCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new SystemReminderService({
      batchWindowMs: 2000,
      maxBatchSize: 10,
      enableChatNotifications: true,
    });
    mockCallback = vi.fn().mockResolvedValue(undefined);
    service.registerCallback(mockCallback as ChatNotifyCallback, 'discord');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('AC #1: registerCallback() / unregisterCallback()', () => {
    it('should register a discord callback', async () => {
      await service.notify(makeReminder({ type: 'task-started' }));
      expect(mockCallback).toHaveBeenCalledOnce();
    });

    it('should register a slack callback', async () => {
      const slackCb = vi.fn().mockResolvedValue(undefined);
      service.registerCallback(slackCb as ChatNotifyCallback, 'slack');
      await service.notify(makeReminder({ type: 'task-started' }));
      expect(slackCb).toHaveBeenCalledOnce();
    });

    it('should call both callbacks when both registered', async () => {
      const slackCb = vi.fn().mockResolvedValue(undefined);
      service.registerCallback(slackCb as ChatNotifyCallback, 'slack');
      await service.notify(makeReminder({ type: 'task-started' }));
      expect(mockCallback).toHaveBeenCalledOnce();
      expect(slackCb).toHaveBeenCalledOnce();
    });

    it('should unregister a callback', async () => {
      service.unregisterCallback('discord');
      await service.notify(makeReminder({ type: 'task-started' }));
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should replace callback when registering same platform twice', async () => {
      const newCb = vi.fn().mockResolvedValue(undefined);
      service.registerCallback(newCb as ChatNotifyCallback, 'discord');
      await service.notify(makeReminder({ type: 'task-started' }));
      expect(mockCallback).not.toHaveBeenCalled();
      expect(newCb).toHaveBeenCalledOnce();
    });
  });

  describe('AC #2: setLanguage()', () => {
    it('should default to English', () => {
      const msg = service.formatChatMessage(makeReminder({ type: 'task-started' }));
      expect(msg).toContain('Background Task Started');
    });

    it('should switch to Korean labels', () => {
      service.setLanguage('ko');
      const msg = service.formatChatMessage(makeReminder({ type: 'task-started' }));
      expect(msg).toContain('백그라운드 작업 시작');
    });

    it('should switch back to English', () => {
      service.setLanguage('ko');
      service.setLanguage('en');
      const msg = service.formatChatMessage(makeReminder({ type: 'task-started' }));
      expect(msg).toContain('Background Task Started');
    });
  });

  describe('AC #3: notify() with task-started sends immediately', () => {
    it('should send immediately without batching', async () => {
      await service.notify(makeReminder({ type: 'task-started' }));
      expect(mockCallback).toHaveBeenCalledOnce();
      const message = (mockCallback as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(message).toContain('Background Task Started');
    });

    it('should pass correct channelId to callback', async () => {
      await service.notify(makeReminder({ type: 'task-started', channelId: 'ch-42' }));
      expect(mockCallback).toHaveBeenCalledWith('ch-42', expect.any(String), 'discord');
    });
  });

  describe('AC #4: notify() with task-completed batches within window', () => {
    it('should not send immediately for task-completed', async () => {
      await service.notify(makeReminder({ type: 'task-completed' }));
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should send after batch window elapses', async () => {
      await service.notify(makeReminder({ type: 'task-completed' }));
      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => {
        expect(mockCallback).toHaveBeenCalledOnce();
      });
    });
  });

  describe('AC #5: notify() with task-failed batches within window', () => {
    it('should not send immediately for task-failed', async () => {
      await service.notify(makeReminder({ type: 'task-failed', error: 'boom' }));
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should send after batch window elapses', async () => {
      await service.notify(makeReminder({ type: 'task-failed', error: 'boom' }));
      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => {
        expect(mockCallback).toHaveBeenCalledOnce();
      });
    });
  });

  describe('AC #6: notify() with all-tasks-complete sends immediately', () => {
    it('should send immediately for all-tasks-complete', async () => {
      await service.notify(makeReminder({ type: 'all-tasks-complete' }));
      expect(mockCallback).toHaveBeenCalledOnce();
      const message = (mockCallback as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(message).toContain('All Background Tasks Complete');
    });
  });

  describe('AC #7: notify() with enableChatNotifications=false', () => {
    it('should store reminder but not send', async () => {
      const quietService = new SystemReminderService({
        enableChatNotifications: false,
      });
      const cb = vi.fn().mockResolvedValue(undefined);
      quietService.registerCallback(cb as ChatNotifyCallback, 'discord');

      await quietService.notify(makeReminder({ type: 'task-started', channelId: 'ch-x' }));
      expect(cb).not.toHaveBeenCalled();

      const recent = quietService.getRecentReminders('ch-x');
      expect(recent).toHaveLength(1);
    });
  });

  describe('AC #8: Batch window flushes after timeout', () => {
    it('should batch multiple completions into one message', async () => {
      await service.notify(makeReminder({ type: 'task-completed', taskId: 'bg_1' }));
      await service.notify(makeReminder({ type: 'task-completed', taskId: 'bg_2' }));
      await service.notify(makeReminder({ type: 'task-failed', taskId: 'bg_3', error: 'err' }));

      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => {
        expect(mockCallback).toHaveBeenCalledOnce();
      });

      const message = (mockCallback as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(message).toContain('bg_1');
      expect(message).toContain('bg_2');
      expect(message).toContain('bg_3');
    });
  });

  describe('AC #9: Batch window flushes immediately when maxBatchSize reached', () => {
    it('should flush immediately at maxBatchSize', async () => {
      const smallBatch = new SystemReminderService({
        batchWindowMs: 60000,
        maxBatchSize: 3,
        enableChatNotifications: true,
      });
      smallBatch.registerCallback(mockCallback as ChatNotifyCallback, 'discord');

      await smallBatch.notify(makeReminder({ type: 'task-completed', taskId: 'bg_a' }));
      await smallBatch.notify(makeReminder({ type: 'task-completed', taskId: 'bg_b' }));
      expect(mockCallback).not.toHaveBeenCalled();

      await smallBatch.notify(makeReminder({ type: 'task-completed', taskId: 'bg_c' }));
      await vi.waitFor(() => {
        expect(mockCallback).toHaveBeenCalledOnce();
      });
    });
  });

  describe('AC #10: formatChatMessage() for each type', () => {
    it('should format task-started message', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-started',
          taskId: 'bg_xyz',
          agentId: 'dev',
          description: 'Fix login',
          requestedBy: 'pm',
        })
      );
      expect(msg).toContain('Background Task Started');
      expect(msg).toContain('bg_xyz');
      expect(msg).toContain('dev');
      expect(msg).toContain('Fix login');
      expect(msg).toContain('pm');
    });

    it('should format task-completed message with duration', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-completed',
          taskId: 'bg_done',
          duration: 5000,
        })
      );
      expect(msg).toContain('Background Task Completed');
      expect(msg).toContain('bg_done');
      expect(msg).toContain('5s');
    });

    it('should format task-completed message without duration', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-completed',
          duration: undefined,
        })
      );
      expect(msg).toContain('Background Task Completed');
      expect(msg).not.toContain('Duration');
    });

    it('should format task-failed message with error', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-failed',
          error: 'Timeout exceeded',
        })
      );
      expect(msg).toContain('Background Task Failed');
      expect(msg).toContain('Timeout exceeded');
    });

    it('should format task-failed message without error', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-failed',
          error: undefined,
        })
      );
      expect(msg).toContain('Background Task Failed');
      expect(msg).not.toContain('Error');
    });

    it('should format all-tasks-complete message', () => {
      const msg = service.formatChatMessage(makeReminder({ type: 'all-tasks-complete' }));
      expect(msg).toContain('All Background Tasks Complete');
    });
  });

  describe('AC #11: formatBatchMessage()', () => {
    it('should return empty string for empty array', () => {
      expect(service.formatBatchMessage([])).toBe('');
    });

    it('should return single formatChatMessage for one item', () => {
      const reminder = makeReminder({ type: 'task-completed', taskId: 'bg_single' });
      const batchMsg = service.formatBatchMessage([reminder]);
      const singleMsg = service.formatChatMessage(reminder);
      expect(batchMsg).toBe(singleMsg);
    });

    it('should show summary with counts for multiple items', () => {
      const reminders = [
        makeReminder({ type: 'task-completed', taskId: 'bg_1', duration: 1000 }),
        makeReminder({ type: 'task-completed', taskId: 'bg_2', duration: 2000 }),
        makeReminder({ type: 'task-failed', taskId: 'bg_3', error: 'err' }),
      ];
      const msg = service.formatBatchMessage(reminders);
      expect(msg).toContain('2 succeeded');
      expect(msg).toContain('1 failed');
      expect(msg).toContain('3 tasks');
      expect(msg).toContain('bg_1');
      expect(msg).toContain('bg_2');
      expect(msg).toContain('bg_3');
    });

    it('should include duration in completed entries', () => {
      const reminders = [
        makeReminder({ type: 'task-completed', taskId: 'bg_a', duration: 3500 }),
        makeReminder({ type: 'task-completed', taskId: 'bg_b', duration: 200 }),
      ];
      const msg = service.formatBatchMessage(reminders);
      expect(msg).toContain('4s');
      expect(msg).toContain('200ms');
    });

    it('should include error in failed entries', () => {
      const reminders = [
        makeReminder({ type: 'task-failed', taskId: 'bg_f1', error: 'timeout' }),
        makeReminder({ type: 'task-failed', taskId: 'bg_f2', error: 'crash' }),
      ];
      const msg = service.formatBatchMessage(reminders);
      expect(msg).toContain('timeout');
      expect(msg).toContain('crash');
    });
  });

  describe('AC #12: getRecentReminders()', () => {
    it('should return newest first', async () => {
      await service.notify(
        makeReminder({
          type: 'task-started',
          taskId: 'bg_old',
          channelId: 'ch-r',
          timestamp: 1000,
        })
      );
      await service.notify(
        makeReminder({
          type: 'task-started',
          taskId: 'bg_new',
          channelId: 'ch-r',
          timestamp: 2000,
        })
      );

      const recent = service.getRecentReminders('ch-r');
      expect(recent).toHaveLength(2);
      expect(recent[0].taskId).toBe('bg_new');
      expect(recent[1].taskId).toBe('bg_old');
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await service.notify(
          makeReminder({
            type: 'task-started',
            taskId: `bg_${i}`,
            channelId: 'ch-lim',
          })
        );
      }
      const recent = service.getRecentReminders('ch-lim', 3);
      expect(recent).toHaveLength(3);
    });

    it('should return empty array for unknown channel', () => {
      expect(service.getRecentReminders('ch-unknown')).toHaveLength(0);
    });
  });

  describe('AC #13: clearChannel()', () => {
    it('should remove stored reminders', async () => {
      await service.notify(makeReminder({ type: 'task-started', channelId: 'ch-clear' }));
      expect(service.getRecentReminders('ch-clear')).toHaveLength(1);

      service.clearChannel('ch-clear');
      expect(service.getRecentReminders('ch-clear')).toHaveLength(0);
    });

    it('should clear pending batches for channel', async () => {
      await service.notify(makeReminder({ type: 'task-completed', channelId: 'ch-batch' }));
      service.clearChannel('ch-batch');

      vi.advanceTimersByTime(5000);
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should not affect other channels', async () => {
      await service.notify(makeReminder({ type: 'task-started', channelId: 'ch-keep' }));
      await service.notify(makeReminder({ type: 'task-started', channelId: 'ch-remove' }));

      service.clearChannel('ch-remove');
      expect(service.getRecentReminders('ch-keep')).toHaveLength(1);
      expect(service.getRecentReminders('ch-remove')).toHaveLength(0);
    });
  });

  describe('AC #14: formatContextInjection()', () => {
    it('should format recent reminders for agent injection', async () => {
      await service.notify(
        makeReminder({
          type: 'task-completed',
          channelId: 'ch-ctx',
          taskId: 'bg_ctx1',
          description: 'Review code',
          agentId: 'reviewer',
          duration: 12000,
        })
      );

      const ctx = service.formatContextInjection('ch-ctx');
      expect(ctx).toContain('System Reminders');
      expect(ctx).toContain('bg_ctx1');
      expect(ctx).toContain('Review code');
      expect(ctx).toContain('reviewer');
    });

    it('should return empty string for empty channel', () => {
      expect(service.formatContextInjection('ch-empty')).toBe('');
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await service.notify(
          makeReminder({
            type: 'task-started',
            channelId: 'ch-ctxlim',
            taskId: `bg_${i}`,
          })
        );
      }
      const ctx = service.formatContextInjection('ch-ctxlim', 3);
      const lines = ctx.split('\n');
      expect(lines.length).toBe(4); // 1 header + 3 entries
    });

    it('should include duration for completed tasks', async () => {
      await service.notify(
        makeReminder({
          type: 'task-completed',
          channelId: 'ch-dur',
          duration: 45000,
        })
      );
      const ctx = service.formatContextInjection('ch-dur');
      expect(ctx).toContain('45s');
    });

    it('should include error for failed tasks', async () => {
      await service.notify(
        makeReminder({
          type: 'task-failed',
          channelId: 'ch-err',
          error: 'Connection refused',
        })
      );
      const ctx = service.formatContextInjection('ch-err');
      expect(ctx).toContain('Connection refused');
    });
  });

  describe('AC #15: destroy()', () => {
    it('should flush pending batches before clearing', async () => {
      await service.notify(makeReminder({ type: 'task-completed', taskId: 'bg_pending' }));
      expect(mockCallback).not.toHaveBeenCalled();

      await service.destroy();
      expect(mockCallback).toHaveBeenCalledOnce();
      const msg = (mockCallback as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(msg).toContain('bg_pending');
    });

    it('should clear all state after destroy', async () => {
      await service.notify(
        makeReminder({
          type: 'task-started',
          channelId: 'ch-destroy',
        })
      );
      await service.destroy();
      expect(service.getRecentReminders('ch-destroy')).toHaveLength(0);
    });

    it('should handle destroy with no pending batches', async () => {
      await expect(service.destroy()).resolves.toBeUndefined();
    });
  });

  describe('AC #16: Channel history stores up to MAX_REMINDERS_PER_CHANNEL', () => {
    it('should store up to 50 reminders per channel', async () => {
      for (let i = 0; i < 55; i++) {
        await service.notify(
          makeReminder({
            type: 'task-started',
            channelId: 'ch-cap',
            taskId: `bg_${i}`,
          })
        );
      }
      const recent = service.getRecentReminders('ch-cap', 100);
      expect(recent).toHaveLength(50);
    });

    it('should evict oldest reminders when exceeding limit', async () => {
      for (let i = 0; i < 55; i++) {
        await service.notify(
          makeReminder({
            type: 'task-started',
            channelId: 'ch-evict',
            taskId: `bg_${i}`,
          })
        );
      }
      const recent = service.getRecentReminders('ch-evict', 100);
      expect(recent[recent.length - 1].taskId).toBe('bg_5');
      expect(recent[0].taskId).toBe('bg_54');
    });
  });

  describe('AC #17: i18n labels', () => {
    it('should use English labels by default', () => {
      const msg = service.formatChatMessage(
        makeReminder({ type: 'task-completed', duration: 5000 })
      );
      expect(msg).toContain('Duration');
      expect(msg).toContain('Agent');
    });

    it('should use Korean labels after setLanguage(ko)', () => {
      service.setLanguage('ko');
      const msg = service.formatChatMessage(
        makeReminder({ type: 'task-completed', duration: 5000 })
      );
      expect(msg).toContain('소요 시간');
      expect(msg).toContain('에이전트');
    });

    it('should use Korean task-failed label', () => {
      service.setLanguage('ko');
      const msg = service.formatChatMessage(makeReminder({ type: 'task-failed', error: 'err' }));
      expect(msg).toContain('백그라운드 작업 실패');
      expect(msg).toContain('오류');
    });

    it('should use Korean all-tasks-complete label', () => {
      service.setLanguage('ko');
      const msg = service.formatChatMessage(makeReminder({ type: 'all-tasks-complete' }));
      expect(msg).toContain('모든 백그라운드 작업 완료');
    });

    it('should use Korean batch summary labels', () => {
      service.setLanguage('ko');
      const reminders = [
        makeReminder({ type: 'task-completed', taskId: 'bg_k1' }),
        makeReminder({ type: 'task-failed', taskId: 'bg_k2', error: 'e' }),
      ];
      const msg = service.formatBatchMessage(reminders);
      expect(msg).toContain('성공');
      expect(msg).toContain('실패');
      expect(msg).toContain('중');
    });

    it('should use Korean context injection header', async () => {
      service.setLanguage('ko');
      await service.notify(
        makeReminder({
          type: 'task-started',
          channelId: 'ch-ko',
        })
      );
      const ctx = service.formatContextInjection('ch-ko');
      expect(ctx).toContain('시스템 알림');
    });
  });

  describe('AC #18: Duration formatting', () => {
    it('should format sub-second as milliseconds', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-completed',
          duration: 500,
        })
      );
      expect(msg).toContain('500ms');
    });

    it('should format seconds', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-completed',
          duration: 30000,
        })
      );
      expect(msg).toContain('30s');
    });

    it('should format minutes and seconds', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-completed',
          duration: 125000,
        })
      );
      expect(msg).toContain('2m 5s');
    });

    it('should format exact minutes without seconds', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-completed',
          duration: 180000,
        })
      );
      expect(msg).toContain('3m');
      expect(msg).not.toContain('3m 0s');
    });
  });

  describe('AC #19: Message truncation enforces Discord 1800 char limit', () => {
    it('should truncate messages longer than 1800 characters', () => {
      const longDesc = 'A'.repeat(2000);
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-started',
          description: longDesc,
        })
      );
      expect(msg.length).toBeLessThanOrEqual(1800);
      expect(msg).toMatch(/\.\.\.$/);
    });

    it('should not truncate short messages', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'task-started',
          description: 'short',
        })
      );
      expect(msg).not.toMatch(/\.\.\.$/);
    });
  });

  describe('AC #20: Callback error handling', () => {
    it('should not throw when callback rejects', async () => {
      const failCb = vi.fn().mockRejectedValue(new Error('send failed'));
      service.registerCallback(failCb as ChatNotifyCallback, 'discord');

      await expect(service.notify(makeReminder({ type: 'task-started' }))).resolves.toBeUndefined();
    });

    it('should continue sending to other callbacks on failure', async () => {
      const failCb = vi.fn().mockRejectedValue(new Error('fail'));
      const okCb = vi.fn().mockResolvedValue(undefined);
      service.registerCallback(failCb as ChatNotifyCallback, 'discord');
      service.registerCallback(okCb as ChatNotifyCallback, 'slack');

      await service.notify(makeReminder({ type: 'task-started' }));
      expect(failCb).toHaveBeenCalledOnce();
      expect(okCb).toHaveBeenCalledOnce();
    });
  });

  describe('AC #21: Separate batch timers per channel', () => {
    it('should batch independently per channel', async () => {
      await service.notify(
        makeReminder({
          type: 'task-completed',
          channelId: 'ch-A',
          taskId: 'bg_a1',
        })
      );
      await service.notify(
        makeReminder({
          type: 'task-completed',
          channelId: 'ch-B',
          taskId: 'bg_b1',
        })
      );

      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => {
        expect(mockCallback).toHaveBeenCalledTimes(2);
      });

      const calls = (mockCallback as ReturnType<typeof vi.fn>).mock.calls;
      const channelIds = calls.map((c) => c[0]);
      expect(channelIds).toContain('ch-A');
      expect(channelIds).toContain('ch-B');
    });
  });

  describe('AC #22: Unknown type returns empty string', () => {
    it('should return empty string for unknown type', () => {
      const msg = service.formatChatMessage(
        makeReminder({
          type: 'unknown-type' as SystemReminderType,
        })
      );
      expect(msg).toBe('');
    });
  });
});
