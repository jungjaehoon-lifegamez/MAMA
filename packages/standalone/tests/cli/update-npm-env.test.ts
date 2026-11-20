/**
 * npm's environment for `mama update`: onnxruntime-node's postinstall on Linux x64 downloads CUDA
 * binaries from a GitHub release that answers 404 for 1.21.0, which fails the whole install. MAMA
 * embeds on the CPU, so every npm install it runs skips that download.
 */
import { describe, expect, it } from 'vitest';
import { npmEnvironment } from '../../src/cli/commands/update.js';

describe('npmEnvironment', () => {
  it('skips the onnxruntime CUDA download', () => {
    const env = npmEnvironment({ PATH: '/usr/bin' }, '/opt/node/bin/node');
    expect(env.ONNXRUNTIME_NODE_INSTALL_CUDA).toBe('skip');
    expect(env.PATH).toBe('/opt/node/bin:/usr/bin');
  });
});
