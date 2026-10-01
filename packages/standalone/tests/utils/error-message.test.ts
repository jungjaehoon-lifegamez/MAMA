import { describe, expect, it } from 'vitest';
import { messageWithCauses } from '../../src/utils/error-message.js';

describe('messageWithCauses', () => {
  it('follows the cause chain, at most three messages', () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('other side closed', { cause: new Error('a', { cause: new Error('b') }) }),
    });
    expect(messageWithCauses(error)).toBe('fetch failed: other side closed: a');
  });

  it('names a refused connection to a host with several addresses', () => {
    // Node's fetch gives an AggregateError with an empty message, one error per address.
    const refused = Object.assign(
      new AggregateError(
        [new Error('connect ECONNREFUSED ::1:9'), new Error('connect ECONNREFUSED 127.0.0.1:9')],
        ''
      ),
      { code: 'ECONNREFUSED' }
    );
    expect(messageWithCauses(new TypeError('fetch failed', { cause: refused }))).toBe(
      'fetch failed: connect ECONNREFUSED ::1:9'
    );
  });
});
