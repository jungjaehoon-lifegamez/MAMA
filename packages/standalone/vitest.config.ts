import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    setupFiles: ['tests/setup/model-cache.ts', 'tests/setup/member-temp.ts'],
    // Load the workspace core through Node like production does. Inlined, the setup's
    // import and the core's own require() are two module instances with two states.
    server: { deps: { external: [/packages\/mama-core\/dist\//] } },
    // better-sqlite3 is a native module; replay tests open source and raw SQLite
    // handles in one run, so keep the worker process single and deterministic.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
