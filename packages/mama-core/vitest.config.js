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
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    isolate: true,
    unstubGlobals: true,
  },
});
