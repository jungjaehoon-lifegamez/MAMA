import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The operator is Viewer CONTENT, not a document: this builds one ES library
// (operator.js + operator.css) that the Viewer loads from its own origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/viewer/operator/',
  // Library mode leaves `process.env.NODE_ENV` for a downstream bundler to
  // resolve, but the Viewer loads this file directly in the browser, where
  // `process` does not exist and React would throw before it renders anything.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: '../public/viewer/operator',
    emptyOutDir: true,
    lib: {
      entry: 'src/operator-entry.tsx',
      formats: ['es'],
      fileName: 'operator',
      cssFileName: 'operator',
    },
    rollupOptions: { output: { assetFileNames: 'operator.css' } },
  },
});
