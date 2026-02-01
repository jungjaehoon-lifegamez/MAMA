import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StreamingCallbackManager,
  type DiscordGatewayInterface,
} from '../../src/agent/streaming-callback-manager.js';
import type { Message } from 'discord.js';
import type { ClaudeResponse } from '../../src/agent/types.js';

describe('StreamingCallbackManager', () => {
  let mockGateway: DiscordGatewayInterface;
  let mockOriginalMessage: Partial<Message>;
  let mockPlaceholderMessage: Partial<Message>;
  let manager: StreamingCallbackManager;

  beforeEach(() => {
    mockPlaceholderMessage = {
      edit: vi.fn().mockResolvedValue(undefined),
    };

    mockOriginalMessage = {
      reply: vi.fn().mockResolvedValue(mockPlaceholderMessage),
    };

    mockGateway = {
      editMessageThrottled: vi.fn().mockResolvedValue(undefined),
    };

    manager = new StreamingCallbackManager(mockGateway, mockOriginalMessage as Message);
  });

  describe('createPlaceholder', () => {
    it('creates Discord message with placeholder text', async () => {
      await manager.createPlaceholder();

      expect(mockOriginalMessage.reply).toHaveBeenCalledWith('⏳ Processing...');
      expect(manager.getPlaceholderMessage()).toBe(mockPlaceholderMessage);
    });

    it('stores placeholder message reference', async () => {
      expect(manager.getPlaceholderMessage()).toBeNull();

      await manager.createPlaceholder();

      expect(manager.getPlaceholderMessage()).not.toBeNull();
    });
  });

  describe('onDelta', () => {
    it('accumulates text across multiple deltas', async () => {
      await manager.createPlaceholder();

      await manager.onDelta('Hello ');
      expect(manager.getAccumulatedText()).toBe('Hello ');

      await manager.onDelta('world');
      expect(manager.getAccumulatedText()).toBe('Hello world');
    });

    it('calls editMessageThrottled with accumulated text', async () => {
      await manager.createPlaceholder();

      await manager.onDelta('First');
      expect(mockGateway.editMessageThrottled).toHaveBeenCalledWith(
        mockPlaceholderMessage,
        'First'
      );

      await manager.onDelta(' Second');
      expect(mockGateway.editMessageThrottled).toHaveBeenCalledWith(
        mockPlaceholderMessage,
        'First Second'
      );
    });

    it('does not call editMessageThrottled if placeholder not created', async () => {
      await manager.onDelta('Text');

      expect(mockGateway.editMessageThrottled).not.toHaveBeenCalled();
      expect(manager.getAccumulatedText()).toBe('Text');
    });

    it('handles multiple delta calls correctly', async () => {
      await manager.createPlaceholder();

      const deltas = ['The ', 'quick ', 'brown ', 'fox'];
      for (const delta of deltas) {
        await manager.onDelta(delta);
      }

      expect(manager.getAccumulatedText()).toBe('The quick brown fox');
      expect(mockGateway.editMessageThrottled).toHaveBeenCalledTimes(4);
    });
  });

  describe('onToolUse', () => {
    it('logs tool use event', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      manager.onToolUse('translate_image', { image_data: 'base64...' });

      expect(consoleSpy).toHaveBeenCalledWith('[Streaming] Tool called: translate_image');
      consoleSpy.mockRestore();
    });

    it('handles tool use with complex input', () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const complexInput = {
        image_data: 'base64...',
        source_lang: 'en',
        target_lang: 'ko',
      };

      manager.onToolUse('translate_image', complexInput);

      expect(consoleSpy).toHaveBeenCalledWith('[Streaming] Tool called: translate_image');
      consoleSpy.mockRestore();
    });
  });

  describe('onFinal', () => {
    it('logs stream completion', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const mockResponse: ClaudeResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      };

      await manager.onFinal(mockResponse);

      expect(consoleSpy).toHaveBeenCalledWith('[Streaming] Stream complete');
      consoleSpy.mockRestore();
    });
  });

  describe('onError', () => {
    it('edits placeholder with error message', async () => {
      await manager.createPlaceholder();

      const error = new Error('Image too large');
      await manager.onError(error);

      expect(mockPlaceholderMessage.edit).toHaveBeenCalledWith(
        '❌ Translation failed: Image too large\n\nPlease try again or use a smaller image.'
      );
    });

    it('logs error to console', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error');

      const error = new Error('Network timeout');
      await manager.onError(error);

      expect(consoleErrorSpy).toHaveBeenCalledWith('[Streaming] Error:', error);
      consoleErrorSpy.mockRestore();
    });

    it('does not crash if placeholder not created', async () => {
      const error = new Error('Test error');

      await expect(manager.onError(error)).resolves.not.toThrow();
    });

    it('handles error with special characters in message', async () => {
      await manager.createPlaceholder();

      const error = new Error('Failed: <tag> & "quotes"');
      await manager.onError(error);

      expect(mockPlaceholderMessage.edit).toHaveBeenCalledWith(
        '❌ Translation failed: Failed: <tag> & "quotes"\n\nPlease try again or use a smaller image.'
      );
    });
  });

  describe('cleanup', () => {
    it('clears placeholder message reference', async () => {
      await manager.createPlaceholder();
      expect(manager.getPlaceholderMessage()).not.toBeNull();

      await manager.cleanup();

      expect(manager.getPlaceholderMessage()).toBeNull();
    });

    it('clears accumulated text', async () => {
      await manager.createPlaceholder();
      await manager.onDelta('Some text');
      expect(manager.getAccumulatedText()).toBe('Some text');

      await manager.cleanup();

      expect(manager.getAccumulatedText()).toBe('');
    });

    it('can be called multiple times safely', async () => {
      await manager.createPlaceholder();
      await manager.onDelta('Text');

      await manager.cleanup();
      await manager.cleanup();

      expect(manager.getPlaceholderMessage()).toBeNull();
      expect(manager.getAccumulatedText()).toBe('');
    });
  });

  describe('integration scenarios', () => {
    it('handles complete streaming lifecycle', async () => {
      // Create placeholder
      await manager.createPlaceholder();
      expect(mockOriginalMessage.reply).toHaveBeenCalledWith('⏳ Processing...');

      // Stream deltas
      await manager.onDelta('Translating ');
      await manager.onDelta('image...');
      expect(manager.getAccumulatedText()).toBe('Translating image...');

      // Tool use
      manager.onToolUse('translate_image', { image_data: 'base64' });

      // Final response
      const mockResponse: ClaudeResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      };
      await manager.onFinal(mockResponse);

      // Cleanup
      await manager.cleanup();
      expect(manager.getPlaceholderMessage()).toBeNull();
      expect(manager.getAccumulatedText()).toBe('');
    });

    it('handles error during streaming', async () => {
      await manager.createPlaceholder();
      await manager.onDelta('Partial ');

      const error = new Error('Processing failed');
      await manager.onError(error);

      expect(mockPlaceholderMessage.edit).toHaveBeenCalledWith(
        '❌ Translation failed: Processing failed\n\nPlease try again or use a smaller image.'
      );

      await manager.cleanup();
      expect(manager.getPlaceholderMessage()).toBeNull();
    });

    it('accumulates text correctly with throttled edits', async () => {
      await manager.createPlaceholder();

      const textChunks = ['Hello', ' ', 'world', '!'];
      for (const chunk of textChunks) {
        await manager.onDelta(chunk);
      }

      expect(manager.getAccumulatedText()).toBe('Hello world!');
      expect(mockGateway.editMessageThrottled).toHaveBeenCalledTimes(4);

      // Verify each call has the accumulated text
      const calls = (mockGateway.editMessageThrottled as any).mock.calls;
      expect(calls[0][1]).toBe('Hello');
      expect(calls[1][1]).toBe('Hello ');
      expect(calls[2][1]).toBe('Hello world');
      expect(calls[3][1]).toBe('Hello world!');
    });
  });
});
