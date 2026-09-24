import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
      sourcemap: true,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
      sourcemap: true,
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
      sourcemap: true,
      // The same bundle is served to phone browsers (server mode): flatten CSS nesting for Safari < 17.2.
      cssTarget: ['chrome110', 'safari15'],
    },
  },
});
