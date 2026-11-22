// The bench page: built from src/page into dist/page, which the bench server serves. In
// `vite dev`, the holder's WebSocket and the job images go to a bench server on 3520.
// Vitest reads this file too; its tests run in node, from the repo root.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repo = fileURLToPath(new URL('.', import.meta.url));
const server = 'http://localhost:3520';

export default defineConfig({
  root: `${repo}src/page`,
  build: {
    outDir: `${repo}dist/page`,
    emptyOutDir: true,
  },
  worker: {
    format: 'es',
  },
  server: {
    proxy: {
      '/holder': { target: server, ws: true },
      '/jobs': { target: server },
    },
  },
  test: {
    root: repo,
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
