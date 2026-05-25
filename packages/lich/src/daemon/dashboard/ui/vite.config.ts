import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Vite config for the lich dashboard UI.
//
// Build output lands in `./dist/` adjacent to this config so the dashboard
// server (packages/lich/src/daemon/dashboard/server.ts) can resolve it via
// `import.meta.dir + '/ui/dist'`. Task 30 (LEV-432) will compose this build
// into the main lich-daemon binary.
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
