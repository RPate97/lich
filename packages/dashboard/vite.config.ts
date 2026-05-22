import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Build the SPA into dist/web. `base: './'` makes asset URLs relative so the
// Bun static server can serve them from any mount path.
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src/web') },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
