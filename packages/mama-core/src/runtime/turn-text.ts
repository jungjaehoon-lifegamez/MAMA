/**
 * Reading and writing a turn's text, with nothing in it that knows which product
 * the turn belongs to.
 *
 * These five were methods on the product's loop class only because they were written
 * there. None of them reads any state on that class; the one that needed to know the
 * backend takes it as an argument. They come out first so that what remains of the
 * turn body is the part that actually holds state.
 */
import type {
  BackendType,
  ContentBlock,
  Message,
  PromptResult,
  TextBlock,
} from './drivers/types.js';

/** The text blocks of one content array, joined. */
export function extractTextFromContent(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** The last assistant message's text, or empty when the history holds none. */
export function extractTextResponse(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role === 'assistant') {
      const content = message.content;
      if (typeof content === 'string') {
        return content;
      }
      return extractTextFromContent(content as ContentBlock[]);
    }
  }
  return '';
}

/**
 * Tokens a turn counts against the run budget.
 *
 * One backend reports cache reads and cache creation outside input_tokens; the other
 * reports input tokens inclusive of cached ones. Adding cache reads for the second
 * doubled every count in 0.44.0, where a 2.8M turn read as 5.5M and was stopped.
 */
export function countBudgetTokens(usage: PromptResult['usage'], backend: BackendType): number {
  const base = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  if (backend === 'codex') {
    return base;
  }
  return base + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}
