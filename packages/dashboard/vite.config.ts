import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src/web') },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
