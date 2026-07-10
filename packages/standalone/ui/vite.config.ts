import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/ui/',
  build: { outDir: '../public/ui', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3847',
      '/health': 'http://127.0.0.1:3847',
    },
  },
});
