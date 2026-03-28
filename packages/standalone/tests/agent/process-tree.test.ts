import { describe, expect, it } from 'vitest';

import { collectDescendantPids } from '../../src/agent/process-tree.js';

describe('Story: collectDescendantPids', () => {
  describe('AC #1: collects direct and nested descendants', () => {
    it('collects direct and nested descendants for a root pid', () => {
      const descendants = collectDescendantPids(100, [
        { pid: 101, ppid: 100 },
        { pid: 102, ppid: 100 },
        { pid: 201, ppid: 101 },
        { pid: 301, ppid: 201 },
        { pid: 999, ppid: 1 },
      ]);

      expect(descendants).toEqual([101, 102, 201, 301]);
    });

    it('returns an empty array when the root has no children', () => {
      expect(collectDescendantPids(42, [{ pid: 1, ppid: 0 }])).toEqual([]);
    });
  });
});
