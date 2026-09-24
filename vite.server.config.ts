import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Fails the build if the server bundle ever reaches `electron` (or
 * `electron-updater`), enforcing the Electron-free-core invariant at the one
 * place it matters: the artifact that runs headless. See the Phase 0/1 design.
 */
function forbidElectron(): Plugin {
  return {
    name: 'forbid-electron',
    resolveId(id) {
      if (id === 'electron' || id.startsWith('electron/') || id === 'electron-updater') {
        throw new Error(`Server bundle must not import "${id}" — keep server-reachable code Electron-free.`);
      }
      return null;
    },
  };
}

/**
 * Replaces electron-vite's `?nodeWorker` import (used by src/main/repo/watcher.ts)
 * with a plain `node:worker_threads` factory, emitting the worker as its own
 * self-contained chunk so the server bundle needs no source tree at runtime.
 */
function nodeWorker(): Plugin {
  return {
    name: 'node-worker',
    load(id) {
      if (!id.endsWith('?nodeWorker')) return null;
      const ref = this.emitFile({ type: 'chunk', id: id.slice(0, -'?nodeWorker'.length) });
      return `import { Worker } from 'node:worker_threads';\nexport default function (options) {\n  return new Worker(new URL(import.meta.ROLLUP_FILE_URL_${ref}), options);\n}\n`;
    },
  };
}
// serves out/renderer. Third-party deps stay external (installed in node_modules);
// only our own src + @shared are bundled.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // The service runs `node out/server/index.mjs` directly, so npm_package_version is never set.
  define: { __GITGOOD_VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version) },
  plugins: [forbidElectron(), nodeWorker()],
  build: {
    ssr: true,
    outDir: 'out/server',
    emptyOutDir: true,
    target: 'node20',
    sourcemap: true,
    rollupOptions: {
      input: resolve('src/server/index.ts'),
      output: { entryFileNames: 'index.mjs', format: 'es' },
    },
  },
});
