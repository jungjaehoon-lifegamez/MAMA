import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 30000,
    // Fix ONNX Runtime V8 locking issues with Transformers.js
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Isolate tests to prevent cross-contamination
    isolate: true,
    // Set MAMA_FORCE_TIER_3 to skip embeddings for faster tests
    env: {
      MAMA_FORCE_TIER_3: 'true',
    },
  },
});
