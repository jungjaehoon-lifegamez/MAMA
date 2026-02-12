import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  server: {
    fs: {
      strict: false,
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    extensions: ['.ts', '.js', '.mjs', '.json'],
  },
  plugins: [
    {
      name: 'resolve-js-to-ts',
      resolveId(id, importer) {
        // Resolve .js imports to .ts files in src/
        if (id.endsWith('.js') && importer && id.includes('/src/')) {
          const tsPath = id.replace(/\.js$/, '.ts');
          return tsPath;
        }
        return null;
      },
    },
  ],
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
