import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const versionFile = resolve(__dirname, '../../../version.ts');
const versionMatch = readFileSync(versionFile, 'utf8').match(/"([^"]+)"/);
if (!versionMatch) throw new Error(`Could not parse VERSION from ${versionFile}`);
const LICH_VERSION = versionMatch[1];

// Output goes to `./dist/` adjacent to this config so the dashboard server
// resolves it via `import.meta.dir + '/ui/dist'`.
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
  define: {
    __LICH_VERSION__: JSON.stringify(LICH_VERSION),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
