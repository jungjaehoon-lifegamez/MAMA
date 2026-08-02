import { describe, expect, it } from 'vitest';

import { directConnectorReadForTool } from '../../src/envelope/tool-connector-scope.js';

describe('TG-04: private direct-reader connector scope', () => {
  it.each([
    'kagemusha_overview',
    'kagemusha_entities',
    'kagemusha_tasks',
    'kagemusha_messages',
  ] as const)('maps %s to the private kagemusha connector', (tool) => {
    expect(directConnectorReadForTool(tool)).toBe('kagemusha');
  });
});
