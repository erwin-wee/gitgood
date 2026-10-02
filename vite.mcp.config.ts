import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The MCP server (src/mcp) as one dependency-free file, so `node out/mcp/index.mjs` works from a
// checkout and `ELECTRON_RUN_AS_NODE=1 gitgood -e …` works from an installed app (see plugin/README.md).
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  define: { __GITGOOD_VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version) },
  build: {
    ssr: true,
    outDir: 'out/mcp',
    emptyOutDir: true,
    target: 'node20',
    sourcemap: true,
    rollupOptions: {
      input: resolve('src/mcp/index.ts'),
      output: { entryFileNames: 'index.mjs', format: 'es' },
    },
  },
});
