import { buildSync } from 'esbuild';
import { resolve } from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';

// Vitest does not run electron-vite's ?nodeWorker plugin. Execute the same bundled
// worker in a real thread; do not mock its filesystem or Git behavior.
const { outputFiles } = buildSync({
  entryPoints: [resolve('src/main/repo/watcher-worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});

export default function createWatcherWorker(options: WorkerOptions): Worker {
  return new Worker(outputFiles[0].text, { ...options, eval: true });
}
