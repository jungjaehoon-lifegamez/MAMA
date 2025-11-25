import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    fs: {
      strict: false,
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
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
    // Allow dynamic imports
    unstubGlobals: true,
  },
});
